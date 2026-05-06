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
  ProposeKycAddDto,
} from '../../../dto/agent/issuer-tool.dto.js';
import type {
  KycAddActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeKycAddContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 P7 — `muhaven_propose_kyc_add`.
 *
 * Issuer-side propose. Wraps `ERC3643KYCAdapter.addToWhitelist` (tier 1)
 * or the tier-2 accredited path (tier 1 + addToAccreditedList). The
 * frontend submits via the issuer kernel after ConfirmModal authorizes.
 *
 * The `KYC_ADAPTER_ADDRESS` env is the canonical adapter on Arb Sepolia
 * (deployments/arb-sepolia-v2.json). Wave 5 will add per-token KYC
 * adapter resolution if/when token-scoped whitelists are required —
 * today every MuHaven RWA shares the platform-wide whitelist.
 *
 * Safety posture: no encrypted state mutated; only the cleartext
 * whitelist mapping. The audit row captures the investorAddress so a
 * compliance officer can later prove the chain-of-custody for KYC.
 */
export class ProposeKycAddToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    /** Optional explicit KYC adapter address. Defaults to
     *  `process.env.KYC_ADAPTER_ADDRESS` (resolved per-call so an env
     *  rotation is picked up without a container rebuild). Reading
     *  process.env directly avoids the full env-schema validation —
     *  the field is the only one we need here. */
    private readonly kycAdapterOverride: string | null = null,
  ) {}

  private resolveKycAdapter(): string | null {
    const v = this.kycAdapterOverride ?? process.env.KYC_ADAPTER_ADDRESS ?? null;
    // H3 mitigation: validate the env value as a 0x-prefixed 40-hex EVM
    // address. A misconfigured `'undefined'` literal or attacker-injected
    // garbage MUST NOT flow through to the descriptor → ConfirmModal →
    // signed tx. Reject at the boundary by returning null (use-case
    // surfaces 503).
    if (!v || !/^0x[a-fA-F0-9]{40}$/.test(v)) return null;
    return v.toLowerCase();
  }

  async execute(
    ctx: ProposeKycAddContext,
    input: ProposeKycAddDto,
    now: Date = new Date(),
  ): Promise<KycAddActionDescriptor> {
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
        'NOT_APPROVED_ISSUER: kyc_add requires an approved issuer kernel.',
      );
    }

    const tokenAddress = input.tokenAddress.toLowerCase();
    const investorAddress = input.investorAddress.toLowerCase();
    const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not registered: ${input.tokenAddress}`);
    }
    if (token.issuerAddress.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden(
        'NOT_TOKEN_ISSUER: caller is not the registered issuer of this token.',
      );
    }

    const kycAdapterAddress = this.resolveKycAdapter();
    if (!kycAdapterAddress) {
      // Defensive — KYC adapter env is required across Phase 9.A but
      // unconfigured local dev would otherwise return an undefined
      // address in the descriptor and the frontend ConfirmModal would
      // render `undefined → frontend tx error`.
      throw new ApplicationHttpError(
        503,
        'KYC adapter address not configured — set KYC_ADAPTER_ADDRESS in backend env.',
      );
    }

    // R-3 mitigation: pin requestedAtSec + tool name into the action hash.
    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const actionPayload = {
      tool: 'muhaven_propose_kyc_add',
      action: 'kyc_add',
      tokenAddress,
      investorAddress,
      kycTier: input.kycTier,
      kycAdapterAddress,
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
        tool: 'muhaven_propose_kyc_add',
        tokenAddress,
        investorAddress,
        kycTier: input.kycTier,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'kyc_add',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Add ${investorAddress.slice(0, 10)}…${investorAddress.slice(-6)} to ${token.symbol} KYC tier ${input.kycTier}.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        investorAddress,
        kycTier: input.kycTier,
        kycAdapterAddress,
        requestedAtSec,
      },
      sdkCall: {
        // Tier 1 = single tx (`addToWhitelist`).
        // Tier 2 = two sequential txs (`addToWhitelist` + `addToAccreditedList`).
        // Frontend runner branches on `txs.length` rather than a synthetic
        // function name so every tx maps to a real on-chain selector.
        contractName: 'ERC3643KYCAdapter',
        functionName: 'kycAddSequence',
        args: {
          adapter: kycAdapterAddress,
          account: investorAddress,
          kycTier: input.kycTier,
          // Real, ordered tx specs — 1 entry for tier 1, 2 entries for tier 2.
          // Each entry resolves to a concrete (address, function, args) tuple
          // that the runner forwards verbatim to the kernel session-key signer.
          txs:
            input.kycTier === 2
              ? [
                  {
                    contract: 'ERC3643KYCAdapter',
                    address: kycAdapterAddress,
                    fn: 'addToWhitelist',
                    args: { account: investorAddress },
                  },
                  {
                    contract: 'ERC3643KYCAdapter',
                    address: kycAdapterAddress,
                    fn: 'addToAccreditedList',
                    args: { account: investorAddress },
                  },
                ]
              : [
                  {
                    contract: 'ERC3643KYCAdapter',
                    address: kycAdapterAddress,
                    fn: 'addToWhitelist',
                    args: { account: investorAddress },
                  },
                ],
        },
      },
    };
  }
}
