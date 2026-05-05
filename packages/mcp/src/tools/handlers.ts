/**
 * Tool handlers — pure functions of `(input, deps)` returning a structured
 * tool result. The MCP server transport layer (`src/server.ts`) wires
 * these to the host LLM via `@modelcontextprotocol/sdk`.
 *
 * Design notes:
 *  - Handlers NEVER throw. They translate every error into a structured
 *    `{ ok: false, code, message }` payload so the host LLM can decide
 *    how to surface it without crashing the MCP server. This matches the
 *    MCPB error-presentation convention.
 *  - Position handlers DO NOT submit UserOps. They return an unsigned
 *    envelope plus a broker signature; the host (or the MuHaven
 *    dashboard via deep-link) is responsible for bundler submission.
 *    Splitting submission from signing is the lethal-trifecta defense.
 *  - Backend errors with status >= 500 are surfaced as `server_error`
 *    so the host can retry; client errors (4xx) bubble up as the
 *    discriminating code (`unauthorized`, `forbidden`, etc.). The host
 *    MUST NOT auto-retry 4xx.
 */

import { keccak256, toBytes } from 'viem';
import type { BackendClient } from '../clients/backend-client.js';
import { BackendError } from '../clients/backend-client.js';
import type { BrokerClient } from '../clients/broker-client.js';
import { BrokerClientError } from '../clients/broker-client.js';
import type {
  PolicyAuditExportInput,
  PolicyPauseInput,
  PolicySetTierInput,
  PolicySessionKeyStatusInput,
  PositionBuyInput,
  PositionClaimInput,
  PositionRebalanceInput,
  PositionSellInput,
  ReadAuditInput,
  ReadDistributionInput,
  ReadPortfolioInput,
  ReadTokensInput,
  ReadYieldsInput,
} from './schemas.js';

export interface ToolDeps {
  backend: BackendClient;
  broker?: BrokerClient;
  /** Surface this MCP server is configured for. Always 'mcp' here, but
   *  carried as a dep so the audit tool can filter to the local surface. */
  surface: 'mcp';
}

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function err(code: string, message: string): ToolResult<never> {
  return { ok: false, code, message };
}

function mapBackendError(e: unknown): ToolResult<never> {
  if (e instanceof BackendError) return err(`backend.${e.code}`, e.message);
  if (e instanceof Error) return err('backend.network', e.message);
  return err('backend.network', 'unknown backend error');
}

function mapBrokerError(e: unknown): ToolResult<never> {
  if (e instanceof BrokerClientError) return err(`broker.${e.code}`, e.message);
  if (e instanceof Error) return err('broker.network', e.message);
  return err('broker.network', 'unknown broker error');
}

// ---------- read group ----------

export async function readPortfolio(
  _input: ReadPortfolioInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/portfolio');
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readYields(
  input: ReadYieldsInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/yields', {
      token: input.token,
      limit: input.limit,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readDistribution(
  input: ReadDistributionInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/distributions', {
      token: input.token,
      epoch: input.epoch,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readTokens(
  _input: ReadTokensInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/tokens');
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function readAudit(
  input: ReadAuditInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/agent/policy/audit', {
      surface: input.surface,
      eventTypes: input.eventTypes?.join(','),
      since: input.since,
      until: input.until,
      cursor: input.cursor,
      limit: input.limit,
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

// ---------- position group ----------

interface PositionEnvelopeData {
  intentHash: `0x${string}`;
  unsignedUserOp: {
    target: string;
    data: string;
    note: string;
  };
  brokerSignature?: `0x${string}`;
  signerAddress?: `0x${string}`;
}

/**
 * Compute the digest the broker will sign. Wave 4 P3 ships a *placeholder*
 * intent hash — the canonical UserOp hash construction (with chainId /
 * entryPoint / nonce) lands in P6 when the on-chain pieces wire up.
 *
 * Domain-separated with a literal version prefix
 * (`muhaven.placeholder.intent.v0:`) so a P3 placeholder signature can
 * NEVER be replayed as a real EIP-712 / EIP-4337 UserOp hash — the
 * preimage lives in a different namespace than any real signing target.
 * Without this separator, an attacker who controls the LLM input could
 * craft intent JSON whose keccak collides with a UserOp hash the user
 * will later approve.
 */
const PLACEHOLDER_INTENT_DOMAIN = 'muhaven.placeholder.intent.v0:';

function computeIntentHash(intent: Record<string, unknown>): `0x${string}` {
  const canonical = JSON.stringify(sortKeys(intent));
  return keccak256(toBytes(PLACEHOLDER_INTENT_DOMAIN + canonical));
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
    return sorted as unknown as T;
  }
  return value;
}

async function signEnvelope(
  intent: Record<string, unknown>,
  toolName: string,
  summary: string,
  deps: ToolDeps,
): Promise<ToolResult<PositionEnvelopeData>> {
  const intentHash = computeIntentHash(intent);
  if (!deps.broker) {
    return err(
      'broker.unavailable',
      'position tools require a running muhaven-broker daemon — see README §Broker setup',
    );
  }
  try {
    const sig = await deps.broker.signHash(intentHash, { tool: toolName, summary });
    return ok({
      intentHash,
      unsignedUserOp: {
        target: 'see backend',
        data: 'see backend',
        note: 'P3 returns a placeholder envelope; P6 wires the canonical UserOp shape.',
      },
      brokerSignature: sig.signature,
      signerAddress: sig.signerAddress,
    });
  } catch (e) {
    return mapBrokerError(e);
  }
}

export async function positionBuy(
  input: PositionBuyInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionEnvelopeData>> {
  return signEnvelope(
    { kind: 'buy', token: input.token, amountUsdc6: input.amountUsdc6 },
    'muhaven.position.buy',
    `buy ${input.amountUsdc6} USDC of ${input.token}`,
    deps,
  );
}

export async function positionSell(
  input: PositionSellInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionEnvelopeData>> {
  return signEnvelope(
    { kind: 'sell', token: input.token, amountShares: input.amountShares },
    'muhaven.position.sell',
    `sell ${input.amountShares} shares of ${input.token}`,
    deps,
  );
}

export async function positionClaim(
  input: PositionClaimInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionEnvelopeData>> {
  return signEnvelope(
    { kind: 'claim', token: input.token, escrowId: input.escrowId ?? null },
    'muhaven.position.claim',
    `claim ${input.token}${input.escrowId ? ` escrow#${input.escrowId}` : ' (all)'}`,
    deps,
  );
}

export async function positionRebalance(
  input: PositionRebalanceInput,
  deps: ToolDeps,
): Promise<ToolResult<PositionEnvelopeData>> {
  return signEnvelope(
    { kind: 'rebalance', legs: input.legs },
    'muhaven.position.rebalance',
    `rebalance ${input.legs.length} legs`,
    deps,
  );
}

// ---------- policy group ----------

export async function policySetTier(
  input: PolicySetTierInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/policy/transition', {
      surface: deps.surface,
      targetTier: input.targetTier,
      ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
    });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policyPause(
  input: PolicyPauseInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.post('/api/v1/agent/policy/pause', {
      ...(input.surface ? { surface: input.surface } : {}),
    });
    return ok({
      backend: data,
      onChain: {
        action: 'uninstallPlugin',
        note: 'Submit via dashboard passkey or follow-up muhaven.position.* invocation.',
      },
    });
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policyAuditExport(
  input: PolicyAuditExportInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  // Drains the cursor in a loop with a hard `maxRows` cap so a malformed
  // backend cannot trick us into unbounded paging.
  const items: unknown[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  const PAGE_LIMIT = 200;
  const MAX_PAGES = Math.ceil(input.maxRows / PAGE_LIMIT) + 1;

  try {
    while (items.length < input.maxRows && pages < MAX_PAGES) {
      const page = (await deps.backend.get('/api/v1/agent/policy/audit', {
        surface: input.surface,
        since: input.since,
        until: input.until,
        cursor,
        limit: PAGE_LIMIT,
      })) as { items?: unknown[]; cursor?: string };

      const got = Array.isArray(page.items) ? page.items : [];
      for (const row of got) {
        if (items.length >= input.maxRows) break;
        items.push(row);
      }
      pages++;
      if (!page.cursor || got.length === 0) break;
      cursor = page.cursor;
    }
    return ok({ items, total: items.length, truncated: items.length === input.maxRows });
  } catch (e) {
    return mapBackendError(e);
  }
}

export async function policySessionKeyStatus(
  _input: PolicySessionKeyStatusInput,
  deps: ToolDeps,
): Promise<ToolResult<unknown>> {
  try {
    const data = await deps.backend.get('/api/v1/agent/policy/state', { surface: deps.surface });
    return ok(data);
  } catch (e) {
    return mapBackendError(e);
  }
}
