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
 * once via passkey, and the SDK fires legs sequentially through the
 * existing kernel session-key (legs are atomic at the policy-engine level
 * but NOT atomic at the EVM level — Wave 5 may add a multicall wrapper).
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
  ): Promise<RebalanceActionDescriptor> {
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(423, 'Surface is paused — resume before proposing actions.');
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
        // Wave 4 ships rebalance as N sequential per-leg purchase/redeem
        // SDK calls (no on-chain multicall yet). The frontend
        // useAgentActionRunner currently refuses rebalance with a Wave 5
        // deferral message — the SDK multicall wrapper lands then. The
        // descriptor below is shape-compatible for the eventual swap.
        contractName: 'MuHavenSubscription',
        functionName: 'TBD_wave5_multicall',
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
