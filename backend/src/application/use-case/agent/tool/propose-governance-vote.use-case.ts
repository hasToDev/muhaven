import { randomUUID } from 'crypto';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  ProposeGovernanceVoteDto,
} from '../../../dto/agent/p11-tool.dto.js';
import type {
  GovernanceProposeActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeGovernanceVoteContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const PROPOSAL_TYPE_LABELS: Record<0 | 1, string> = {
  0: 'TRIGGER_PROTECTION',
  1: 'RESERVED_WAVE_5',
};

/**
 * Wave 4 P11 — `muhaven_propose_governance_vote`.
 *
 * Investor-side propose. Returns an ActionDescriptor that the frontend
 * runner submits via the existing ConfirmModal → SDK → ZeroDev kernel
 * pipeline. Backend never holds a private key — kernel signs.
 *
 * `EncryptedGovernance.createProposal` is a plaintext call (no FHE
 * input), so the runner only needs viem `walletClient.writeContract`.
 *
 * P11.B contracts are not yet deployed to Arb Sepolia at Wave 4 close.
 * The use-case checks `ENCRYPTED_GOVERNANCE_ADDRESS` and refuses with
 * `409 P11_NOT_DEPLOYED` when unset rather than minting an
 * ActionDescriptor pointing at the zero address.
 */
export class ProposeGovernanceVoteToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly env: { encryptedGovernanceAddress?: string },
  ) {}

  async execute(
    ctx: ProposeGovernanceVoteContext,
    input: ProposeGovernanceVoteDto,
    now: Date = new Date(),
  ): Promise<GovernanceProposeActionDescriptor> {
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(
        423,
        'Surface is paused — resume before proposing actions.',
      );
    }

    if (!this.env.encryptedGovernanceAddress) {
      throw ApplicationHttpError.conflict(
        'P11_NOT_DEPLOYED: EncryptedGovernance contract is not yet deployed to Arbitrum Sepolia.',
      );
    }
    if (!HEX_ADDRESS_RE.test(this.env.encryptedGovernanceAddress)) {
      throw ApplicationHttpError.serviceUnavailable(
        'P11_MISCONFIGURED: ENCRYPTED_GOVERNANCE_ADDRESS env var is malformed.',
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

    if (input.proposalType === 1) {
      // Reserved for Wave 5; refuse instead of minting a descriptor that
      // would silently fail on-chain.
      throw ApplicationHttpError.badRequest(
        'proposalType 1 is reserved for Wave 5 — only TRIGGER_PROTECTION (0) is supported.',
      );
    }

    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const governanceAddress = this.env.encryptedGovernanceAddress.toLowerCase();
    const actionPayload = {
      tool: 'muhaven_propose_governance_vote',
      action: 'governance_propose',
      tokenAddress,
      proposalType: input.proposalType,
      governanceAddress,
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
        tool: 'muhaven_propose_governance_vote',
        tokenAddress,
        proposalType: input.proposalType,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'governance_propose',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Open a ${PROPOSAL_TYPE_LABELS[0]} proposal for ${token.symbol}.`,
      preview: {
        tokenAddress,
        tokenSymbol: token.symbol,
        proposalType: input.proposalType,
        proposalTypeLabel: PROPOSAL_TYPE_LABELS[input.proposalType],
        governanceAddress,
        requestedAtSec,
      },
      sdkCall: {
        contractName: 'EncryptedGovernance',
        functionName: 'createProposal',
        args: {
          token: tokenAddress,
          proposalType: input.proposalType,
        },
      },
    };
  }
}

export { PROPOSAL_TYPE_LABELS };
