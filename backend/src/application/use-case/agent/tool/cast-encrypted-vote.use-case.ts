import { randomUUID } from 'crypto';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  CastEncryptedVoteDto,
} from '../../../dto/agent/p11-tool.dto.js';
import type {
  GovernanceVoteActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface CastEncryptedVoteContext {
  userId: string;
  walletAddress: string;
  surface: Surface;
}

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Wave 4 P11 — `muhaven_cast_encrypted_vote`.
 *
 * Investor-side propose. Builds an ActionDescriptor for the FHE-encrypted
 * vote ceremony. The runner encrypts the cleartext yes/no client-side
 * via `cofheClient.encrypt(...)` to produce InEuint128, then submits
 * `EncryptedGovernance.castVote(proposalId, encryptedVote)` via viem.
 *
 * The cleartext vote is in the descriptor preview so the ConfirmModal
 * can render an unambiguous summary; once the FHE encryption fires the
 * ciphertext NEVER leaves the user's device.
 *
 * R-3 mitigation: `requestedAtSec` is round-tripped through the action
 * hash so a stolen descriptor can't be replayed against a future
 * proposal at the same id (proposal id rotation isn't a concern, but
 * stale-quote protection is uniform across propose tools).
 */
export class CastEncryptedVoteToolUseCase {
  constructor(
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly env: { encryptedGovernanceAddress?: string },
  ) {}

  async execute(
    ctx: CastEncryptedVoteContext,
    input: CastEncryptedVoteDto,
    now: Date = new Date(),
  ): Promise<GovernanceVoteActionDescriptor> {
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

    // Defence-in-depth: the regex on the DTO already enforces a positive
    // integer string, but the BigInt cast surfaces the "0" boundary
    // unambiguously here.
    const proposalId = BigInt(input.proposalId);
    if (proposalId <= 0n) {
      throw ApplicationHttpError.badRequest('proposalId must be > 0.');
    }

    const requestedAtSec = Math.floor(now.getTime() / 1000);
    const governanceAddress = this.env.encryptedGovernanceAddress.toLowerCase();
    const actionPayload = {
      tool: 'muhaven_cast_encrypted_vote',
      action: 'governance_vote',
      proposalId: proposalId.toString(),
      voteYes: input.voteYes,
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
        tool: 'muhaven_cast_encrypted_vote',
        proposalId: proposalId.toString(),
        // voteYes is intentionally NOT in the audit metadata — the
        // privacy guarantee is "encrypted ballot" so even an audit-log
        // reader shouldn't be able to read which way each user voted.
        // The cleartext sits in the in-flight ConfirmModal preview only.
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'governance_vote',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Vote ${input.voteYes ? 'YES' : 'NO'} on proposal #${proposalId.toString()}.`,
      preview: {
        proposalId: proposalId.toString(),
        voteYes: input.voteYes,
        governanceAddress,
        requestedAtSec,
      },
      sdkCall: {
        contractName: 'EncryptedGovernance',
        functionName: 'castVote',
        args: {
          proposalId: proposalId.toString(),
          // The cleartext bool — runner encrypts to InEuint128 client-side
          // (1 = yes, 0 = no) BEFORE the on-chain write. Backend never
          // sees the encrypted handle.
          voteYes: input.voteYes,
        },
      },
    };
  }
}
