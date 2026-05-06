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
  ProposeUnpauseTokenDto,
} from '../../../dto/agent/issuer-tool.dto.js';
import type {
  UnpauseTokenActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeUnpauseTokenContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 P7 — `muhaven_propose_unpause_token`.
 *
 * Closes the F2 self-serve issuer-onboarding wizard's deferred step 6:
 *   1. `IssuerControlledOracle.setNAV(token, initialNav)`
 *   2. `TokenRegistry.setPaused(token, false)`
 *
 * Both signed by the **applicant kernel** via the existing ZeroDev
 * session-key path. This is the production-trajectory shape — the
 * deployer-side `scripts/unpause-token.ts` is the demo-stage compromise;
 * the agent path moves the privilege to the right place (issuer owns
 * NAV, issuer signs).
 *
 * Tier-2 (Confirm-per-action) is the natural posture: low blast radius
 * (single-issuer-scoped), easy mental model. Doesn't need Tier-3 policy
 * framing for v1.
 *
 * Equivalence with the operator script: given the same token +
 * initialNav, on-chain state must converge. The script holds the deployer
 * EOA so it can rotate `setNavWriter` for itself; the agent holds the
 * applicant kernel so it can write NAV directly (the F2 wizard already
 * registered the kernel as nav writer at deploy time). The script needs
 * a temporary writer rotation; the agent does NOT — that's the savings.
 */
export class ProposeUnpauseTokenToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly issuerOracleOverride: string | null = null,
    private readonly tokenRegistryOverride: string | null = null,
  ) {}

  private resolveOracleAddress(): string | null {
    const v = this.issuerOracleOverride ?? process.env.ISSUER_ORACLE_ADDRESS ?? null;
    if (!v || !/^0x[a-fA-F0-9]{40}$/.test(v)) return null;
    return v.toLowerCase();
  }
  private resolveTokenRegistryAddress(): string | null {
    const v = this.tokenRegistryOverride ?? process.env.TOKEN_REGISTRY_ADDRESS ?? null;
    if (!v || !/^0x[a-fA-F0-9]{40}$/.test(v)) return null;
    return v.toLowerCase();
  }

  async execute(
    ctx: ProposeUnpauseTokenContext,
    input: ProposeUnpauseTokenDto,
    now: Date = new Date(),
  ): Promise<UnpauseTokenActionDescriptor> {
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(
        423,
        'Surface is paused — resume before proposing actions.',
      );
    }

    const user = await this.userRepo.findById(ctx.userId);
    if (!user || user.role !== 'issuer' || user.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'NOT_APPROVED_ISSUER: unpause_token requires an approved issuer kernel.',
      );
    }

    const tokenAddress = input.tokenAddress.toLowerCase();
    const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not registered: ${input.tokenAddress}`);
    }
    if (token.issuerAddress.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden(
        'NOT_TOKEN_ISSUER: caller is not the registered issuer of this token.',
      );
    }
    // Idempotent — refuse the propose if the token is already active so
    // the audit log doesn't show duplicate unpause attempts. Operator
    // script analog `scripts/unpause-token.ts` skips the same way.
    if (token.status === 'active') {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} is already active — no unpause needed.`,
      );
    }

    const initialNav = BigInt(input.initialNavUsd6);
    if (initialNav <= 0n) {
      throw ApplicationHttpError.badRequest(
        'initialNavUsd6 must be > 0 (Oracle rejects zero NAV).',
      );
    }

    const issuerOracleAddress = this.resolveOracleAddress();
    const tokenRegistryAddress = this.resolveTokenRegistryAddress();
    if (!issuerOracleAddress || !tokenRegistryAddress) {
      throw new ApplicationHttpError(
        503,
        'Issuer oracle / token registry not configured — set ISSUER_ORACLE_ADDRESS + TOKEN_REGISTRY_ADDRESS in backend env.',
      );
    }

    // R-3 mitigation: pin requestedAtSec + tool name into the action hash.
    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const actionPayload = {
      tool: 'muhaven_propose_unpause_token',
      action: 'unpause_token',
      tokenAddress,
      initialNavUsd6: initialNav.toString(),
      issuerOracleAddress,
      tokenRegistryAddress,
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
      now,
      metadata: {
        tool: 'muhaven_propose_unpause_token',
        tokenAddress,
        initialNavUsd6: initialNav.toString(),
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'unpause_token',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Activate ${token.symbol} — set initial NAV ${displayUsd(initialNav)} + unpause registry.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        initialNavUsd6: initialNav.toString(),
        issuerOracleAddress,
        tokenRegistryAddress,
        requestedAtSec,
      },
      sdkCall: {
        // Two sequential txs from the same kernel — frontend dispatches
        // both via the issuer's session-key signer. Each `txs` entry maps
        // to a real on-chain (address, function, args) tuple — no synthetic
        // function names, the runner can resolve every selector.
        contractName: 'IssuerOracle+TokenRegistry',
        functionName: 'unpauseSequence',
        args: {
          oracle: issuerOracleAddress,
          tokenRegistry: tokenRegistryAddress,
          token: tokenAddress,
          initialNav: initialNav.toString(),
          txs: [
            {
              contract: 'IssuerControlledOracle',
              address: issuerOracleAddress,
              fn: 'setNAV',
              args: { token: tokenAddress, newNav: initialNav.toString() },
            },
            {
              contract: 'TokenRegistry',
              address: tokenRegistryAddress,
              fn: 'setPaused',
              args: { token: tokenAddress, paused: false },
            },
          ],
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
