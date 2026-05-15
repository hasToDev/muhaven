import { randomUUID } from 'crypto';
import type { Address } from 'viem';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { IUserRepository } from '../../../../domain/auth/repository/user.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type { IIssuerOracleNavWriter } from '../../../../infrastructure/oracle/issuer-oracle-nav-writer.service.js';
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
 * Closes the F2 self-serve issuer-onboarding wizard's deferred step 6.
 *
 * 2026-05-17 Design A · PREVENTION shape:
 *   1. `IssuerControlledOracle.setNAV(token, initialNav)` — executed
 *      **server-side** here, signed by the platform's NAV writer EOA
 *      (`IssuerOracleNavWriterService`). The platform IS the registered
 *      navWriter for self-serve-onboarded tokens (deploy library Step
 *      7), so this is the right signer.
 *   2. `TokenRegistry.setPaused(token, false)` — proposed to the
 *      applicant kernel via the existing ZeroDev session-key path. The
 *      applicant remains the registered `MUHAVEN_ISSUER` and is the
 *      only party authorised to decide when the token opens for
 *      business.
 *
 * Pre-Design-A shape had the applicant kernel signing BOTH txs (the
 * applicant was the navWriter then). Splitting them means the applicant
 * confirms ONE action — "unpause my token" — and the ConfirmModal shows
 * the NAV-publish tx hash as provenance, not a second authorize step.
 *
 * Tier-2 (Confirm-per-action) is the natural posture: low blast radius
 * (single-issuer-scoped), easy mental model.
 *
 * If the server-side setNAV reverts (deviation gate / zero NAV / RPC
 * failure / oracle ownership misconfig), no confirm token is minted and
 * the LLM/UI surface the underlying error — the applicant never sees a
 * partial-state ConfirmModal.
 */
export class ProposeUnpauseTokenToolUseCase {
  // Lazy-init on first use to avoid touching `getEnv()` at instance
  // construction (some tests instantiate the use case before priming
  // the env schema's required vars). Cached after first call.
  private _logger: ReturnType<typeof getLogger> | null = null;
  private get logger(): ReturnType<typeof getLogger> {
    if (!this._logger) this._logger = getLogger('ProposeUnpauseTokenToolUseCase');
    return this._logger;
  }

  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly oracleNavWriter: IIssuerOracleNavWriter | null = null,
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
    if (!this.oracleNavWriter) {
      throw new ApplicationHttpError(
        503,
        'Platform NAV writer not configured — set PLATFORM_NAV_WRITER_ADDRESS in backend env (must equal the address derived from PLATFORM_DEPLOYER_PRIVATE_KEY).',
      );
    }

    // ── Server-side setNAV (platform-signed) ─────────────────────────
    // 2026-05-17 Design A · PREVENTION: the platform is the registered
    // navWriter for self-serve-onboarded tokens, so the backend signs
    // setNAV. Any revert here (ZeroNAV / deviation gate / RPC failure /
    // legacy token whose navWriter never got rotated) bubbles up before
    // a confirm token is minted — the applicant never sees a half-done
    // ConfirmModal.
    let navPublishTxHash: string;
    try {
      const result = await this.oracleNavWriter.setNAV(
        tokenAddress as Address,
        initialNav,
      );
      navPublishTxHash = result.txHash;
    } catch (err) {
      // viem error stacks can be thousands of characters (sim+ABI+args).
      // Log the full error for ops + audit; slice the response message
      // so a 502 stays parseable in chat/Telegram surfaces.
      this.logger.warn(
        { err, tokenAddress, initialNav: initialNav.toString() },
        'Server-side setNAV reverted; refusing to mint confirm token',
      );
      const raw = err instanceof Error ? err.message : String(err);
      throw new ApplicationHttpError(
        502,
        `setNAV failed on IssuerControlledOracle: ${raw.slice(0, 500)}`,
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
      navPublishTxHash,
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
        navPublishTxHash,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'unpause_token',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Activate ${token.symbol} — initial NAV ${displayUsd(initialNav)} published, sign to unpause.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        initialNavUsd6: initialNav.toString(),
        issuerOracleAddress,
        tokenRegistryAddress,
        navPublishTxHash,
        requestedAtSec,
      },
      sdkCall: {
        // Single-tx descriptor — only `setPaused(false)` is left for the
        // applicant kernel. setNAV already published server-side above.
        contractName: 'TokenRegistry',
        functionName: 'setPaused',
        args: {
          tokenRegistry: tokenRegistryAddress,
          token: tokenAddress,
          paused: false,
          txs: [
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
