import { z } from 'zod';
import { ApplicationHttpError } from '../../../core/errors.js';
import { Surface } from '../../../domain/agent/model/surface.enum.js';
import { AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import { CheckoutSessionStatus } from '../../../domain/checkout/model/checkout-session.js';
import type { IAgentStateRepository } from '../../../domain/agent/repository/agent-state.repository.js';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { ConfirmTokenService } from '../agent/policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../agent/policy/append-audit-event.use-case.js';
import type {
  CreateCheckoutSessionResult,
  CreateCheckoutSessionUseCase,
} from './create-session.use-case.js';
import type { IIssuerLabelResolver } from '../../../infrastructure/checkout/issuer-label-resolver.js';

/**
 * Wave 4 §5 Path C — close the HavenBot propose → commit loop for
 * `muhaven_propose_create_checkout`.
 *
 * Flow:
 *   1. Consume the confirm token via ConfirmTokenService (R-3 single-use
 *      + action-hash byte-for-byte match).
 *   2. Resolve token metadata from the actionPayload (matched at hash time).
 *   3. Fire CreateCheckoutSessionUseCase to mint the encrypted session.
 *   4. Append `permit_granted` + `confirm_token_consumed` audit rows
 *      tagged `surface: havenbot`, `actionKind: create_checkout`.
 *   5. Return the buyer URL + sessionId + fragmentKey ONCE.
 *
 * The frontend ConfirmModal flips to a success state showing the URL.
 *
 * Privacy:
 *   - The fragment key is generated INSIDE CreateCheckoutSessionUseCase
 *     and surfaced here ONLY on the response. We never log it.
 *   - The action payload (cleartext amount + memo) was the basis for the
 *     confirm-token hash; an attacker who steals the confirm token can
 *     mint AT MOST one session and can only mint THE EXACT one the
 *     issuer authorized.
 */

/**
 * Action payload shape — must match `propose-create-checkout.use-case.ts`
 * byte-for-byte. Validated here for the same reason ConfirmTokenService
 * hashes it: a malformed payload should be rejected at the boundary, not
 * after the SDK call.
 *
 * Third-pass review (Sec M1): the propose-side DTO's `superRefine` URL
 * validator rejects `javascript:` / `data:` / `vbscript:` schemes — the
 * commit reconstruction MUST mirror that posture or a future maintenance
 * code path that bypasses ConfirmTokenService.consume leaves the URL guard
 * gone. Today the hash-equality check defends in depth; the schema-level
 * validator below is the second layer.
 */
const commitRedirectUrl = z
  .string()
  .max(512)
  .nullable()
  .superRefine((raw, ctx) => {
    if (raw === null) return;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid URL' });
      return;
    }
    if (u.protocol === 'https:') return;
    if (u.protocol === 'http:') {
      const h = u.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http:// only allowed for localhost; production must use https://',
      });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `protocol ${u.protocol} is not allowed (https:// or http://localhost only)`,
    });
  });

export const CommitCreateCheckoutActionPayloadSchema = z
  .object({
    tool: z.literal('muhaven_propose_create_checkout'),
    action: z.literal('create_checkout'),
    tokenAddress: z.string().regex(/^0x[a-f0-9]{40}$/),
    amountUsd6: z.string().regex(/^[1-9]\d*$/),
    memo: z.string().nullable(),
    successUrl: commitRedirectUrl,
    cancelUrl: commitRedirectUrl,
    issuerAddress: z.string().regex(/^0x[a-f0-9]{40}$/),
    requestedAtSec: z.number().int().nonnegative(),
  })
  .strict();

export type CommitCreateCheckoutActionPayload = z.infer<
  typeof CommitCreateCheckoutActionPayloadSchema
>;

export interface CommitCreateCheckoutInput {
  userId: string;
  surface: Surface;
  confirmToken: string;
  actionPayload: Record<string, unknown>;
  now?: Date;
}

export interface CommitCreateCheckoutResult {
  consumed: true;
  auditEventId: string;
  session: {
    sessionId: string;
    url: string;
    fragmentKey: string;
    status: CheckoutSessionStatus;
    expiresAt: string;
  };
}

export class CommitCreateCheckoutUseCase {
  constructor(
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly createSession: CreateCheckoutSessionUseCase,
    private readonly issuerLabelResolver: IIssuerLabelResolver,
    /**
     * Third-pass review (Code-Reviewer HIGH-1): the generic
     * `commit-tool-action.use-case` bumps `confirmedActionCount` after a
     * successful permit_grant so the Confirm-per-action → PolicyBound
     * autonomy gate can advance. The dedicated checkout commit copied the
     * audit-pair pattern but skipped the state bump entirely, leaving
     * issuers stuck at the lower tier despite confirming 5+ create_checkout
     * commits. Inject IAgentStateRepository here and replicate the bump.
     */
    private readonly agentStateRepo: IAgentStateRepository,
  ) {}

  async execute(input: CommitCreateCheckoutInput): Promise<CommitCreateCheckoutResult> {
    const now = input.now ?? new Date();

    // Validate the action payload shape BEFORE the consume call so a
    // bad-shaped payload surfaces as 400 rather than the generic 403
    // hash-mismatch path. The schema's `.strict()` also catches the
    // confused-deputy case where the frontend echoes back additional
    // unexpected fields.
    let parsed: CommitCreateCheckoutActionPayload;
    try {
      parsed = CommitCreateCheckoutActionPayloadSchema.parse(input.actionPayload);
    } catch {
      throw ApplicationHttpError.badRequest(
        'create_checkout action payload schema mismatch',
      );
    }

    // Pre-validate token state + issuer-of-record BEFORE consuming the
    // confirm token. Order matters (sec-review LOW-4): consume is
    // destructive — a single-use confirm token is burned even if the
    // downstream conflict throws. If we consume FIRST and then 409 on a
    // paused token, the legitimate issuer must re-propose because their
    // confirm token is dead. Pre-validating means a token-paused-mid-
    // flight 409 leaves the confirm token live for a retry once the
    // token returns to `active`.
    //
    // The hash-equality on consume still defends against
    // tokenAddress / amount / memo tampering — only the token-state
    // checks are run-ahead-of-consume here.
    const token = await this.rwaTokenRepo.findByAddress(parsed.tokenAddress);
    if (!token) {
      throw ApplicationHttpError.conflict(
        `Token ${parsed.tokenAddress} is no longer registered.`,
      );
    }
    if (token.status !== 'active') {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} is no longer active (status=${token.status}).`,
      );
    }
    // Issuer-of-record re-check at commit. The propose hash binds the
    // `issuerAddress` field byte-for-byte, but the token's on-chain
    // issuer-of-record can rotate between propose + commit (admin
    // transfer / IssuerUpdated event from the registry indexer). A
    // rotation would let the propose-time issuer still mint a session
    // pinned to themselves in `metadata.issuerAddress`, even though they
    // no longer own the token. Audit-trail anomaly + buyer-facing
    // issuerLabel misattribution. Refuse at commit when the registered
    // issuer no longer matches the propose-time identity.
    if (token.issuerAddress.toLowerCase() !== parsed.issuerAddress.toLowerCase()) {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} issuer-of-record rotated between propose and commit.`,
      );
    }

    // R-3 single-use consume — throws 410 (consumed/expired) or 403
    // (wrong binding) on rejection. NOW that pre-flight checks passed,
    // burning the token is acceptable; on a successful consume, the
    // session mint below is the side-effect the user authorized.
    //
    // Third-pass review (Arch L-3): pass the parsed (typed) payload so a
    // future refactor that catches the .parse() exception differently
    // cannot leak extra keys into the hash. Today .strict() guarantees
    // equivalence; the explicit `parsed` makes the dependency explicit.
    await this.confirmTokens.consume(
      input.confirmToken,
      input.userId,
      'permit_grant',
      parsed,
      now,
    );

    // Third-pass review (Arch M-2): write the `confirm_token_consumed`
    // audit row IMMEDIATELY after consume succeeds. If createSession
    // below throws (transient PG error / AES encrypt failure), we still
    // have audit attribution for the burned token — orphan-consumed
    // tokens without audit rows are a forensic gap. The PermitGranted
    // row writes AFTER session mint (and references the sessionId), so
    // its absence is itself a signal that the create_checkout failed
    // mid-flight.
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.ConfirmTokenConsumed,
      now,
      metadata: { confirmTokenId: input.confirmToken },
    });

    // Resolve label via the dependency-injected resolver — same shape
    // CheckoutLinkModal (dashboard path) will use, keeping the create-
    // session metadata uniform across the two surfaces.
    const resolved = await this.issuerLabelResolver.resolve(
      parsed.issuerAddress as `0x${string}`,
    );
    const issuerLabel = resolved?.label ?? null;
    const result: CreateCheckoutSessionResult = await this.createSession.execute({
      issuerUserId: input.userId,
      metadata: {
        issuerAddress: parsed.issuerAddress as `0x${string}`,
        tokenAddress: parsed.tokenAddress as `0x${string}`,
        tokenSymbol: token.symbol,
        issuerLabel,
        description: parsed.memo ?? `${token.symbol} purchase`,
        successUrl: parsed.successUrl as string | null,
        cancelUrl: parsed.cancelUrl as string | null,
      },
      payload: {
        amountUsd6: parsed.amountUsd6,
        memo: parsed.memo ?? undefined,
      },
      now,
    });

    const audit = await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.PermitGranted,
      now,
      metadata: {
        tool: 'muhaven_propose_create_checkout',
        actionKind: 'create_checkout',
        sessionId: result.session.sessionId,
        // The URL fragment key + buyer URL are deliberately NOT logged
        // — leak-by-audit would defeat the privacy property.
        tokenAddress: parsed.tokenAddress,
        amountUsd6: parsed.amountUsd6,
      },
    });

    // Third-pass review (Code-Reviewer HIGH-1): bump the surface's
    // `confirmedActionCount` so the Confirm-per-action → PolicyBound gate
    // can advance after ≥5 confirms. Mirrors the read-modify-write in
    // commit-tool-action.use-case.ts. The benign race where two parallel
    // commits each see the same starting count is tolerable here — the
    // threshold is ≥5; off-by-one is fine.
    const state = await this.agentStateRepo.findByUserAndSurface(
      input.userId,
      input.surface,
    );
    if (state) {
      const next = state.with({
        confirmedActionCount: state.confirmedActionCount + 1,
        updatedAt: now,
      });
      await this.agentStateRepo.upsert(next);
    }

    return {
      consumed: true,
      auditEventId: audit.id,
      session: {
        sessionId: result.session.sessionId,
        url: result.url,
        fragmentKey: result.fragmentKey,
        status: result.session.status,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    };
  }
}

