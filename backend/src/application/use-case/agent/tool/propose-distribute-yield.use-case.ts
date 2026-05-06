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
import type {
  ProposeDistributeYieldDto,
} from '../../../dto/agent/issuer-tool.dto.js';
import type {
  DistributeYieldActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeDistributeYieldContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 P7 — `muhaven_propose_distribute_yield`.
 *
 * Issuer-side propose. Wraps the existing `@muhaven/sdk`
 * `MuHavenClient.distributeYield(totalYield)` pipeline (startDistribution
 * → createYieldEscrows → fundEscrows). The frontend executes the SDK call
 * after the user signs through ConfirmModal — backend never holds the
 * encrypted yield handle.
 *
 * Production-trajectory: signs as the issuer kernel (NOT the platform
 * deployer). The use-case enforces (a) caller has `issuer` role with
 * `issuerStatus === 'approved'`, (b) token is registered + active, (c)
 * caller is the issuer-of-record for the token. Pre-flight PUSDC balance
 * + operator-approval checks live frontend-side via the SDK's
 * `validateNetwork` + `startDistribution` revert paths.
 */
export class ProposeDistributeYieldToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: ProposeDistributeYieldContext,
    input: ProposeDistributeYieldDto,
    now: Date = new Date(),
  ): Promise<DistributeYieldActionDescriptor> {
    // Tier gate identical to investor-side propose tools.
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(
        423,
        'Surface is paused — resume before proposing actions.',
      );
    }

    // Issuer role + lifecycle gate. Mirrors the F2 deploy / register
    // webhook posture — `withRole('issuer')` covers JWT, the lifecycle
    // column gates pending/suspended applicants. P5 ADR-5 shipped the
    // same shape; reusing it keeps the surface uniform.
    const user = await this.userRepo.findById(ctx.userId);
    if (!user || user.role !== 'issuer' || user.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'NOT_APPROVED_ISSUER: distribute_yield requires an approved issuer kernel.',
      );
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

    // Issuer-of-record check. The agent surface MUST refuse a
    // distribution proposal targeting another issuer's token even if the
    // caller is approved + issuer-roled — otherwise an issuer with
    // valid kernel could fund yield against tokens they don't own,
    // wasting their PUSDC + breaking the per-token issuer audit trail.
    if (token.issuerAddress.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden(
        'NOT_TOKEN_ISSUER: caller is not the registered issuer of this token.',
      );
    }

    const totalYield = BigInt(input.totalYieldUsd6);
    if (totalYield <= 0n) {
      throw ApplicationHttpError.badRequest('totalYieldUsd6 must be > 0.');
    }

    const label = (input.label?.trim() || `Yield distribution for ${token.symbol}`)
      .slice(0, 200);

    // R-3 mitigation: pin `requestedAtSec` into the action hash so a
    // stale-quote replay is rejected at consume time (mirrors propose_buy's
    // navAt pin — see propose-buy.use-case.ts:99 + dto.ts:271). Also pin
    // `tool` so the post-commit audit can reconstruct which propose tool
    // issued the token without joining back to a deleted confirm-token row.
    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const actionPayload = {
      tool: 'muhaven_propose_distribute_yield',
      action: 'distribute_yield',
      tokenAddress,
      totalYieldUsd6: totalYield.toString(),
      label,
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
      // distribute_yield is not in the ActionId hot-path enum (Buy / Sell /
      // Claim / Rebalance per ADR-1) — issuer actions filter by
      // metadata.tool. Leave actionId null per the same convention used
      // by `set_policy`.
      now,
      metadata: {
        tool: 'muhaven_propose_distribute_yield',
        tokenAddress,
        totalYieldUsd6: totalYield.toString(),
        label,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'distribute_yield',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Distribute ${displayUsd(totalYield)} of yield across all ${token.symbol} holders.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        totalYieldUsd6: totalYield.toString(),
        label,
        issuerAddress: ctx.walletAddress.toLowerCase(),
        // Surfaced so the frontend ConfirmModal echoes BYTE-EQUIVALENT
        // fields back through the commit POST — without it the
        // ConfirmTokenService action-hash check 403s every commit.
        requestedAtSec,
      },
      sdkCall: {
        contractName: 'MuHavenClient',
        functionName: 'distributeYield',
        args: {
          totalYield: totalYield.toString(),
          // SDK encrypts the totalYield client-side via cofheClient.
          // Frontend wires the SDK with the issuer kernel as sender +
          // batches the three-stage call with onProgress callbacks.
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
