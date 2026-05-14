import { randomUUID } from 'crypto';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { IUserRepository } from '../../../../domain/auth/repository/user.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type { ProposeCreateCheckoutDto } from '../../../dto/agent/issuer-tool.dto.js';
import type { CreateCheckoutActionDescriptor } from '../../../dto/agent/tool.dto.js';

export interface ProposeCreateCheckoutContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 §5 Path C — `muhaven_propose_create_checkout`.
 *
 * Issuer asks the agent: "Create a checkout link for $5 of AURA88 with
 * memo 'Series A allocation'." The propose use-case validates issuer
 * lifecycle + token ownership, mints a confirm token bound to the
 * cleartext parameters, and returns an ActionDescriptor the frontend
 * ConfirmModal renders. The actual session mint happens at commit time
 * (`commit-create-checkout.use-case.ts`) so the AES-256-GCM key + URL
 * fragment are surfaced ONCE per user-authorized commit.
 *
 * Why action mint at commit (not propose):
 *   1. The fragment key is the privacy primitive — surfacing it twice
 *      (once on propose, once on commit) doubles the leak surface for
 *      zero UX gain. The agent CAN'T render the URL until the user
 *      authorizes, so no point materializing it earlier.
 *   2. The propose path is single-use replay-rejected via
 *      ConfirmTokenService; an attacker who steals the confirm token
 *      can mint at most one session (and the same one each retry, since
 *      the actionPayload is hashed). Commit-side mint preserves that
 *      single-use property.
 *
 * Privacy: `amountUsd6` is cleartext in both the action payload AND
 * the preview rows. The issuer typed it; we render it back. The actual
 * encryption happens in the session create step (key generated
 * fresh at commit time, fragment lives on the URL).
 */
export class ProposeCreateCheckoutToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: ProposeCreateCheckoutContext,
    input: ProposeCreateCheckoutDto,
    now: Date = new Date(),
  ): Promise<CreateCheckoutActionDescriptor> {
    // Tier gate — identical posture to every propose_* tool.
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(
        423,
        'Surface is paused — resume before proposing actions.',
      );
    }

    // Issuer role + lifecycle gate (mirrors P7 propose_distribute_yield).
    const user = await this.userRepo.findById(ctx.userId);
    if (!user || user.role !== 'issuer' || user.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'NOT_APPROVED_ISSUER: create_checkout requires an approved issuer kernel.',
      );
    }

    const tokenAddress = input.tokenAddress.toLowerCase();
    const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      // Third-pass review (Arch L-4): 409 Conflict mirrors the commit-side
      // posture for the same "no longer registered" condition. Before, the
      // propose side returned 404 and commit returned 409 for identical
      // lifecycle drift — API-consumer DX wart that surfaces on every
      // retry-after-propose flow in ClawHub / MCP clients.
      throw ApplicationHttpError.conflict(`Token not registered: ${input.tokenAddress}`);
    }
    if (token.status !== 'active') {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} is not active (status=${token.status}).`,
      );
    }

    // Issuer-of-record check. Refuse if the calling kernel is not the
    // registered issuer of the token. Without this gate any approved
    // issuer could mint checkout links against another issuer's tokens
    // — confusing buyers and breaking the per-issuer audit trail.
    if (token.issuerAddress.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden(
        'NOT_TOKEN_ISSUER: caller is not the registered issuer of this token.',
      );
    }

    const amount = BigInt(input.amountUsd6);
    if (amount <= 0n) {
      throw ApplicationHttpError.badRequest('amountUsd6 must be > 0.');
    }
    // Plan B (2026-05-14 walkthrough): mirror the create-session
    // use-case's ≥1 USDC floor so an LLM-proposed checkout returns a
    // structured error instead of forwarding a doomed amount to the
    // commit-time create step.
    if (amount < 1_000_000n) {
      throw ApplicationHttpError.badRequest(
        'amountUsd6 must be ≥ 1_000_000 (1 USDC) — demo-NAV scaling rejects smaller amounts',
      );
    }

    const memo = input.memo?.trim() || null;
    const successUrl = input.successUrl || null;
    const cancelUrl = input.cancelUrl || null;

    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const actionPayload = {
      tool: 'muhaven_propose_create_checkout',
      action: 'create_checkout',
      tokenAddress,
      amountUsd6: amount.toString(),
      memo,
      successUrl,
      cancelUrl,
      issuerAddress: ctx.walletAddress.toLowerCase(),
      requestedAtSec,
    };
    const issued = await this.confirmTokens.issue({
      userId: ctx.userId,
      actionKind: 'permit_grant',
      actionPayload,
      now,
    });
    await this.appendAudit.execute({
      userId: ctx.userId,
      surface: ctx.surface,
      eventType: AuditEventType.ConfirmTokenIssued,
      // create_checkout is NOT in the ActionId hot-path enum
      // (Buy / Sell / Claim / Rebalance per ADR-1). Issuer-side tools
      // filter by metadata.tool. Leave actionId null per the same
      // convention used by distribute_yield / kyc_add / set_policy.
      now,
      metadata: {
        tool: 'muhaven_propose_create_checkout',
        tokenAddress,
        amountUsd6: amount.toString(),
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'create_checkout',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Mint a hosted-checkout link for ${displayUsd(amount)} of ${token.symbol}.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        amountUsd6: amount.toString(),
        memo,
        successUrl,
        cancelUrl,
        issuerAddress: ctx.walletAddress.toLowerCase(),
        requestedAtSec,
      },
      // Wire-shape note for the frontend: commit fires the backend
      // CreateCheckoutSessionUseCase via the dedicated commit route.
      // There is NO on-chain leg — the response surfaces the buyer URL.
      sdkCall: {
        contractName: 'MuHavenCheckout',
        functionName: 'createSessionViaAgent',
        args: {
          tokenAddress,
          amountUsd6: amount.toString(),
          memo: memo ?? '',
        },
      },
    };
  }
}

function displayUsd(usd6: bigint): string {
  const whole = usd6 / 1_000_000n;
  const frac = (usd6 % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `$${whole.toString()}.${frac}` : `$${whole.toString()}`;
}
