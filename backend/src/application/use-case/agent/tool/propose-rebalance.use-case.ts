import { randomUUID } from 'crypto';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  ProposeRebalanceDto,
  ProposeRebalanceResult,
  RebalanceActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeRebalanceContext {
  userId: string;
  surface: Surface;
}

/**
 * Wave 4 P2 — `muhaven_propose_rebalance`.
 *
 * Multi-leg propose. Each leg is a sell or buy on a registered token.
 * The frontend ConfirmModal renders all legs together, the user signs
 * once via passkey, and (Wave 5 Slice 3) the runner submits ALL legs as
 * ONE atomic UserOp through the in-tab Scoped session key (sells before
 * buys) — see `frontend/src/composables/useAgentActionRunner.ts::runRebalance`.
 *
 * Two call shapes:
 *   - `legs` present → mint a hash-bound RebalanceActionDescriptor (below).
 *   - `legs` omitted → return a `toward_targets` client-compute DIRECTIVE:
 *     the browser computes the legs from the user's encrypted balances ×
 *     public NAV vs. their saved targets (the server can't read encrypted
 *     balances), then re-calls this tool WITH the computed legs.
 *
 * Tier-gated identically to propose_buy. Token-active checks fire on
 * every leg so a single archived token in a 5-leg rebalance hard-fails.
 */
export class ProposeRebalanceToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: ProposeRebalanceContext,
    input: ProposeRebalanceDto,
    now: Date = new Date(),
  ): Promise<ProposeRebalanceResult> {
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(423, 'Surface is paused — resume before proposing actions.');
    }

    // Wave 5 Slice 3 — "rebalance toward my saved targets" directive.
    //
    // When the LLM (or the dashboard) calls this tool with NO legs, the
    // legs aren't known here: drift = encrypted balance × public NAV vs.
    // the user's target allocations, and the server CANNOT read encrypted
    // balances. So we return a non-confirm-able DIRECTIVE. The dashboard
    // (which holds the decrypt permit) computes the legs client-side and
    // re-calls this tool with explicit `legs` to mint the real hash-bound
    // confirm token. No audit row here — the real ConfirmTokenIssued fires
    // on the computed-legs re-propose below.
    if (!input.legs || input.legs.length === 0) {
      return {
        tool: 'muhaven_propose_rebalance',
        directive: 'open_rebalance_composer',
        mode: 'toward_targets',
        explanation:
          'Opening your rebalance preview. The dashboard will compute the exact ' +
          'buy/sell legs from your encrypted balances and target allocations — ' +
          'review them, then approve once to settle in a single confidential transaction.',
      };
    }

    // Validate every leg's token + bigint normalization. Build the
    // canonical action payload in one pass so the action hash is
    // deterministic across replays.
    const normalizedLegs = await Promise.all(
      input.legs.map(async (leg, idx) => {
        const tokenAddress = leg.tokenAddress.toLowerCase();
        const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
        if (!token) {
          throw ApplicationHttpError.badRequest(
            `Leg ${idx}: token not registered (${leg.tokenAddress}).`,
          );
        }
        if (token.status !== 'active') {
          throw ApplicationHttpError.conflict(
            `Leg ${idx}: token ${token.symbol} not active (status=${token.status}).`,
          );
        }
        const shares = BigInt(leg.shares);
        const maxSharesHint = BigInt(leg.maxSharesHint ?? leg.shares);
        if (shares <= 0n) {
          throw ApplicationHttpError.badRequest(`Leg ${idx}: shares must be > 0.`);
        }
        if (shares > maxSharesHint) {
          throw ApplicationHttpError.badRequest(
            `Leg ${idx}: shares (${shares}) > maxSharesHint (${maxSharesHint}).`,
          );
        }
        return {
          kind: leg.kind,
          tokenAddress,
          tokenSymbol: token.symbol,
          shares: shares.toString(),
          maxSharesHint: maxSharesHint.toString(),
        };
      }),
    );

    const actionPayload = {
      action: 'rebalance',
      legs: normalizedLegs.map(({ kind, tokenAddress, shares, maxSharesHint }) => ({
        kind,
        tokenAddress,
        shares,
        maxSharesHint,
      })),
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
      actionId: ActionId.Rebalance,
      now,
      metadata: {
        tool: 'muhaven_propose_rebalance',
        legCount: normalizedLegs.length,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'rebalance',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Rebalance: ${normalizedLegs.length} leg(s) — ${normalizedLegs
        .map((l) => `${l.kind} ${l.shares} ${l.tokenSymbol}`)
        .join(', ')}.`,
      preview: {
        legCount: normalizedLegs.length,
        legs: normalizedLegs.map(({ kind, tokenAddress, shares, maxSharesHint }) => ({
          kind,
          tokenAddress,
          shares,
          maxSharesHint,
        })),
        privacyNote:
          'Sells silent-fail to zero on insufficient encrypted balance — verify on Arbiscan after signing.',
      },
      sdkCall: {
        // Wave 5 Slice 3 — the runner (`runRebalance`) ignores `sdkCall` and
        // hand-builds the `calls[]` (one purchase/redeem per leg) for a single
        // atomic UserOp via the Scoped session key. `sdkCall` is retained for
        // descriptor-shape uniformity (and is stripped before reaching the LLM).
        contractName: 'MuHavenSubscription',
        functionName: 'batchUserOp',
        args: {
          legs: normalizedLegs.map(({ kind, tokenAddress, shares, maxSharesHint }) => ({
            kind,
            token: tokenAddress,
            shares,
            maxSharesHint,
          })),
        },
      },
    };
  }
}
