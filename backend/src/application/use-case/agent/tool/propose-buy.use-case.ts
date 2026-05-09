import { randomUUID } from 'crypto';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../domain/nav-history/repository/nav-history.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  ProposeBuyDto,
  BuyActionDescriptor,
} from '../../../dto/agent/tool.dto.js';
import { parseDecimalToUsd6 } from './quote.use-case.js';

export interface ProposeBuyContext {
  userId: string;
  walletAddress: string;
  /** Surface from which the propose was issued. Wave 4 P2 ships HavenBot;
   *  the same use case will serve MCP/OpenClaw via the same call. */
  surface: Surface;
}

/**
 * Wave 4 P2 — `muhaven_propose_buy`.
 *
 * Tier-gated propose. Returns an ActionDescriptor the frontend ConfirmModal
 * uses to drive `MuHavenClient.subscription.purchase` via ZeroDev kernel +
 * session key. Backend never encrypts the share count — that's the client's
 * job (CoFHE input signature requires the user's signer).
 *
 * The on-chain leg is fired by the frontend after the user confirms; the
 * audit-commit POST closes the loop with the tx hash.
 */
export class ProposeBuyToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly navHistoryRepo: INavHistoryRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: ProposeBuyContext,
    input: ProposeBuyDto,
    now: Date = new Date(),
  ): Promise<BuyActionDescriptor> {
    // Tier gate: Advisory and ConfirmPerAction can both propose; Paused
    // refuses (the user must explicitly resume first per ADR-0). PolicyBound
    // also produces a propose because the agent surface is the LLM's
    // structured output; the policy engine evaluates the on-chain leg.
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(423, 'Surface is paused — resume before proposing actions.');
    }

    const tokenAddress = input.tokenAddress.toLowerCase();
    const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not registered: ${input.tokenAddress}`);
    }
    if (token.status !== 'active') {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} is not active (status=${token.status}).`,
      );
    }

    const shares = BigInt(input.shares);
    const maxSharesHint = BigInt(input.maxSharesHint ?? input.shares);
    if (shares <= 0n) {
      throw ApplicationHttpError.badRequest('shares must be > 0.');
    }
    if (shares > maxSharesHint) {
      throw ApplicationHttpError.badRequest(
        `shares (${shares}) > maxSharesHint (${maxSharesHint}); on-chain purchase would silent-fail.`,
      );
    }

    const snap = await this.navHistoryRepo.findLatestByToken(tokenAddress);
    if (!snap) {
      throw ApplicationHttpError.notFound(`No NAV snapshot for ${token.symbol}; cannot quote buy.`);
    }
    // `snap.nav` is the decimal-price string the nav-worker writes
    // ("1.0" / "2400.5"). Convert to 6dp base units before BigInt
    // arithmetic — see `parseDecimalToUsd6` doc + 2026-05-09 fix.
    let navUsd6: bigint;
    try {
      navUsd6 = parseDecimalToUsd6(snap.nav);
    } catch (err) {
      throw ApplicationHttpError.conflict(
        `NAV for ${token.symbol} is malformed (${snap.nav}); cannot quote buy. ${err instanceof Error ? err.message : ''}`,
      );
    }
    if (navUsd6 <= 0n) {
      throw ApplicationHttpError.conflict(`NAV for ${token.symbol} non-positive (${snap.nav}).`);
    }
    const estimatedTotalUsd6 = (shares * navUsd6).toString();
    // Pin the 6dp base-unit string in the action payload so the commit
    // hash recovers byte-for-byte (R-3 replay defence) — must NOT use
    // `snap.nav` here, which is decimal-price + would mismatch the
    // ConfirmModal preview's navUsd6 (also 6dp base units).
    const navUsd6String = navUsd6.toString();

    const actionPayload = {
      action: 'buy',
      tokenAddress,
      shares: shares.toString(),
      maxSharesHint: maxSharesHint.toString(),
      navUsd6: navUsd6String,
      // navAt pinned in the action hash so a stale-quote replay is
      // rejected at consume time (R-3 mitigation).
      navAt: (snap.sourceTimestamp ?? snap.fetchedAt).toISOString(),
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
      actionId: ActionId.Buy,
      now,
      metadata: {
        tool: 'muhaven_propose_buy',
        tokenAddress,
        shares: shares.toString(),
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;

    return {
      kind: 'buy',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Buy ${shares.toString()} ${token.symbol} (${displayUsd(estimatedTotalUsd6)} at NAV ${displayUsd(navUsd6String)}).`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        shares: shares.toString(),
        maxSharesHint: maxSharesHint.toString(),
        navUsd6: navUsd6String,
        // Must match the actionPayload's navAt exactly — the
        // ConfirmTokenService.consume hash equality check fails silently
        // otherwise (every buy commit would 403). See dto.ts for context.
        navAt: actionPayload.navAt,
        estimatedTotalUsd6,
      },
      sdkCall: {
        contractName: 'MuHavenSubscription',
        functionName: 'purchase',
        args: {
          token: tokenAddress,
          shares: shares.toString(),
          maxSharesHint: maxSharesHint.toString(),
          // ephemeralEOA injected by the frontend (kernel session-key signer).
        },
      },
    };
  }
}

function displayUsd(usd6: string): string {
  const v = BigInt(usd6);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `$${whole.toString()}.${frac}` : `$${whole.toString()}`;
}
