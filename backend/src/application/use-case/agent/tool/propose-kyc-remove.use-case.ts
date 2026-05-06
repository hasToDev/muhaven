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
  ProposeKycRemoveDto,
} from '../../../dto/agent/issuer-tool.dto.js';
import type {
  KycRemoveActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeKycRemoveContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

/**
 * Wave 4 P7 — `muhaven_propose_kyc_remove`.
 *
 * Wraps `ERC3643KYCAdapter.removeFromWhitelist`. Tier-2 accredited
 * status is auto-cleared on tier-1 removal (per the contract's
 * `removeFromWhitelist` cascade — see ERC3643KYCAdapter.sol lines
 * 103-110). The frontend submits via the issuer kernel after the
 * ConfirmModal authorizes.
 *
 * Audit posture: every KYC removal cascades a T-5 KycRevocationReceived
 * trigger across the investor's surfaces (the existing T-5 path in
 * `agent-state-cron`). The agent surface here only writes the
 * propose-side audit — the cascade fires from the on-chain event the
 * indexer subscribes to (PROGRESS.md §"P1 cron policy engine").
 */
export class ProposeKycRemoveToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly userRepo: IUserRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly kycAdapterOverride: string | null = null,
  ) {}

  private resolveKycAdapter(): string | null {
    const v = this.kycAdapterOverride ?? process.env.KYC_ADAPTER_ADDRESS ?? null;
    if (!v || !/^0x[a-fA-F0-9]{40}$/.test(v)) return null;
    return v.toLowerCase();
  }

  async execute(
    ctx: ProposeKycRemoveContext,
    input: ProposeKycRemoveDto,
    now: Date = new Date(),
  ): Promise<KycRemoveActionDescriptor> {
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
        'NOT_APPROVED_ISSUER: kyc_remove requires an approved issuer kernel.',
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
      throw new ApplicationHttpError(
        503,
        'KYC adapter address not configured — set KYC_ADAPTER_ADDRESS in backend env.',
      );
    }

    // R-3 mitigation: pin requestedAtSec + tool name into the action hash.
    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const actionPayload = {
      tool: 'muhaven_propose_kyc_remove',
      action: 'kyc_remove',
      tokenAddress,
      investorAddress,
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
        tool: 'muhaven_propose_kyc_remove',
        tokenAddress,
        investorAddress,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'kyc_remove',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Remove ${investorAddress.slice(0, 10)}…${investorAddress.slice(-6)} from ${token.symbol} KYC.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        investorAddress,
        kycAdapterAddress,
        requestedAtSec,
      },
      sdkCall: {
        // Single-tx removal (the contract auto-clears tier-2 accredited
        // status — see ERC3643KYCAdapter.sol:103-110). Wire shape matches
        // kyc_add for runner uniformity.
        contractName: 'ERC3643KYCAdapter',
        functionName: 'removeFromWhitelist',
        args: {
          adapter: kycAdapterAddress,
          account: investorAddress,
          txs: [
            {
              contract: 'ERC3643KYCAdapter',
              address: kycAdapterAddress,
              fn: 'removeFromWhitelist',
              args: { account: investorAddress },
            },
          ],
        },
      },
    };
  }
}
