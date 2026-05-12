import { z } from 'zod';
import { ApplicationHttpError } from '../../../core/errors.js';
import { Surface } from '../../../domain/agent/model/surface.enum.js';
import { AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import { CheckoutSessionStatus } from '../../../domain/checkout/model/checkout-session.js';
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
 */
export const CommitCreateCheckoutActionPayloadSchema = z
  .object({
    tool: z.literal('muhaven_propose_create_checkout'),
    action: z.literal('create_checkout'),
    tokenAddress: z.string().regex(/^0x[a-f0-9]{40}$/),
    amountUsd6: z.string().regex(/^[1-9]\d*$/),
    memo: z.string().nullable(),
    successUrl: z.string().nullable(),
    cancelUrl: z.string().nullable(),
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
    await this.confirmTokens.consume(
      input.confirmToken,
      input.userId,
      'permit_grant',
      input.actionPayload,
      now,
    );

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
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.ConfirmTokenConsumed,
      now,
      metadata: { confirmTokenId: input.confirmToken },
    });

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

