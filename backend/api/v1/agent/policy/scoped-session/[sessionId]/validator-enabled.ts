import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ZodError, z } from 'zod';
import {
  createPublicClient,
  http,
  type Address,
  type Log,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { decodePermissionInstallFromSelectorSet } from '../../../../../../src/infrastructure/blockchain/selector-set.js';
import { RevokeScopedSessionParamsSchema } from '../../../../../../src/application/dto/agent/policy.dto.js';
import { MarkScopedSessionValidatorEnabledUseCase } from '../../../../../../src/application/use-case/agent/policy/mark-scoped-session-validator-enabled.use-case.js';
import { container } from '../../../../../../src/infrastructure/container.js';
import { sendResponse } from '../../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../../src/interface/middleware/with-cors.js';
import { withServiceSecret } from '../../../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../../src/core/errors.js';
import { getLogger } from '../../../../../../src/core/logger.js';

const log = getLogger('ValidatorEnabledCallback');

/**
 * Wave 5 Option D · Commit 3 — broker-callback route.
 *
 *   POST /api/v1/agent/policy/scoped-session/:sessionId/validator-enabled
 *
 * **Auth**: shared service secret `BROKER_CALLBACK_SERVICE_SECRET` in
 * `Authorization: Bearer <secret>`. The broker daemon (NOT the MCP
 * server, NOT the operator's browser) holds this secret per the
 * threat-model relaxation documented in `packages/mcp/src/broker/
 * protocol.ts` C3 JSDoc. The daemon fires this POST fire-and-forget
 * after observing the MODE.ENABLE UserOp receipt.
 *
 * **Authoritative source of truth = chain indexer.** This callback is
 * the fast-path optimization. The chain indexer runs independently;
 * whichever wins (callback or indexer) flips the row, and the other
 * arrives as a no-op via `MarkScopedSessionValidatorEnabledUseCase`'s
 * idempotency on `enable_status='enabled'`.
 *
 * **Re-verification**: the body's `txHash` is NOT trusted. We re-call
 * `eth_getTransactionReceipt` via the configured RPC + decode the
 * receipt's logs against the kernel `SelectorSet` install signal (see
 * `infrastructure/blockchain/selector-set.ts` — the deployed kernel does
 * NOT emit `PermissionInstalled` for enable-mode installs) to confirm:
 *   - the tx is mined,
 *   - it carries a matching SelectorSet (permission-enable) log,
 *   - the log's decoded permissionId (`vId[1..5)`) matches the body's
 *     `permissionId`.
 * Mismatches surface as 422 with a structural reason; the broker
 * daemon's retry loop drops the callback after 1h.
 *
 * **Idempotency**: the use-case is idempotent on `enable_status='enabled'`.
 * A repeated POST after the first success returns 200 with `flipped:false`.
 * The broker's `Idempotency-Key` header is informational — we don't
 * persist a per-key dedup table (the row's `enable_status` IS the
 * dedup gate).
 *
 * **Response shapes**:
 *   - 200 + `{ session, flipped }` when the flip succeeded (or row
 *     was already enabled).
 *   - 401 / 503 from `withServiceSecret` when auth fails / secret unset.
 *   - 404 when the sessionId doesn't exist.
 *   - 422 when the receipt re-verify rejects (permissionId mismatch,
 *     missing log, tx not mined).
 *   - 409 when the row is `'failed'` (watchdog beat the receipt).
 *   - 503 when the RPC URL is unset (broker callback can't re-verify).
 */

const ValidatorEnabledBodySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  accountAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase() as `0x${string}`),
  permissionId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{8}$/)
    .transform((s) => s.toLowerCase() as `0x${string}`),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase() as `0x${string}`),
  blockNumber: z.number().int().min(0),
  logIndex: z.number().int().min(0),
});

let cachedPublicClient: PublicClient | null = null;
function getPublicClient(): PublicClient | null {
  if (cachedPublicClient) return cachedPublicClient;
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) return null;
  cachedPublicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });
  return cachedPublicClient;
}

/**
 * Reset the cached PublicClient. Tests use this between scenarios.
 */
export function __resetPublicClientCacheForTests(): void {
  cachedPublicClient = null;
}

const useCase = new MarkScopedSessionValidatorEnabledUseCase(
  container.scopedSessionRepo,
  container.appendAuditEvent,
);

async function verifyReceipt(args: {
  txHash: `0x${string}`;
  permissionId: `0x${string}`;
  logIndex: number;
}): Promise<{ ok: true; emittedBy: Address } | { ok: false; reason: string }> {
  const client = getPublicClient();
  if (!client) {
    return { ok: false, reason: 'rpc_unconfigured' };
  }
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: args.txHash });
  } catch (err) {
    return {
      ok: false,
      reason: `receipt_lookup_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!receipt) {
    return { ok: false, reason: 'receipt_not_found' };
  }
  if (receipt.status !== 'success') {
    return { ok: false, reason: `tx_status_${receipt.status}` };
  }
  // Decode every log against the kernel SelectorSet install signal (the
  // deployed kernel does NOT emit PermissionInstalled for enable-mode
  // installs — see selector-set.ts). The caller's `logIndex` is
  // informational; we scan the FULL receipt so a callback with a
  // slightly-wrong logIndex still succeeds when the right event exists.
  // Defense-in-depth on broker implementation bugs.
  const decodedLogs: { permission: `0x${string}`; emittedBy: Address }[] = [];
  for (const lg of receipt.logs as Log[]) {
    const signal = decodePermissionInstallFromSelectorSet(lg);
    if (!signal) continue;
    decodedLogs.push({
      permission: signal.permissionId,
      emittedBy: lg.address as Address,
    });
  }
  const hit = decodedLogs.find(
    (m) => m.permission.toLowerCase() === args.permissionId.toLowerCase(),
  );
  if (!hit) {
    return {
      ok: false,
      reason:
        decodedLogs.length > 0
          ? 'permission_id_mismatch'
          : 'no_permission_installed_event',
    };
  }
  return { ok: true, emittedBy: hit.emittedBy };
}

async function postHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const rawSessionId = (req.query as Record<string, string | string[] | undefined>)
      .sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    const params = RevokeScopedSessionParamsSchema.parse({ sessionId });

    const body = ValidatorEnabledBodySchema.parse(req.body ?? {});

    const verify = await verifyReceipt({
      txHash: body.txHash,
      permissionId: body.permissionId,
      logIndex: body.logIndex,
    });
    if (!verify.ok) {
      if (verify.reason === 'rpc_unconfigured') {
        sendResponse(res, {
          statusCode: 503,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Receipt verification unavailable',
            status: 503,
            detail:
              'backend RPC_URL is unset — validator-enabled callback cannot re-verify the receipt',
          }),
        });
        return;
      }
      sendResponse(res, {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Receipt re-verification failed',
          status: 422,
          detail: verify.reason,
        }),
      });
      return;
    }

    // Optional cross-check: `body.accountAddress` should match the log
    // emitter. The SelectorSet event is emitted by the kernel (smart
    // account) itself, so `lg.address` IS `accountAddress`. Mismatch
    // points at a broker that picked the wrong tx hash.
    if (verify.emittedBy.toLowerCase() !== body.accountAddress.toLowerCase()) {
      sendResponse(res, {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'install-event emitter mismatch',
          status: 422,
          detail: `event emitted by ${verify.emittedBy}, callback claimed ${body.accountAddress}`,
        }),
      });
      return;
    }

    const result = await useCase.execute({
      sessionId: params.sessionId,
      txHash: body.txHash,
      blockNumber: body.blockNumber,
      logIndex: body.logIndex,
      source: 'broker_callback',
      // Multi-agent review HIGH-2: cross-check that the sessionId's
      // stored permissionId matches what the broker claimed in the
      // body. Defends against a broker that POSTs another session's
      // receipt under a wrong sessionId.
      expectedPermissionId: body.permissionId,
    });
    sendResponse(
      res,
      Response.ok({
        ok: true,
        flipped: result.flipped,
        sessionId: result.session.sessionId,
        enableStatus: result.session.enableStatus,
      }),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      sendResponse(res, Response.fromZodError(error));
      return;
    }
    if (error instanceof ApplicationHttpError) {
      sendResponse(res, Response.fromError(error, error.statusCode));
      return;
    }
    log.error({ err: error }, 'Unhandled error');
    sendResponse(res, Response.internalServerError());
  }
}

const protectedHandler = withServiceSecret(
  {
    envVar: 'BROKER_CALLBACK_SERVICE_SECRET',
    serviceName: 'Broker Callback',
  },
  async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== 'POST') {
      sendResponse(res, Response.methodNotAllowed('POST'));
      return;
    }
    return postHandler(req, res);
  },
);

export default withCors(protectedHandler);
