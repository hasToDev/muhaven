import { randomUUID } from 'crypto';
import type { IYieldRecordRepository } from '../../../../domain/yield-history/repository/yield-record.repository.js';
import type { IEscrowRepository } from '../../../../domain/escrow/repository/escrow.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  ProposeClaimDto,
  ClaimActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface ProposeClaimContext {
  userId: string;
  surface: Surface;
}

/**
 * Wave 4 P2 — `muhaven_propose_claim`.
 *
 * Resolves the on-chain escrow id from the backend yield-record (mirrors
 * GetYieldsUseCase), tier-gates, mints a confirm token, and returns the
 * ActionDescriptor. The frontend invokes `MuHavenEscrow.redeem(id)` via
 * the SDK after the ConfirmModal authorizes.
 */
export class ProposeClaimToolUseCase {
  constructor(
    private readonly yieldRepo: IYieldRecordRepository,
    private readonly escrowRepo: IEscrowRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: ProposeClaimContext,
    input: ProposeClaimDto,
    now: Date = new Date(),
  ): Promise<ClaimActionDescriptor> {
    const state = await this.getPolicyState.forSurface(ctx.userId, ctx.surface, now);
    if (state.tier === Tier.Paused) {
      throw new ApplicationHttpError(423, 'Surface is paused — resume before proposing actions.');
    }

    const record = await this.yieldRepo.findById(input.yieldRecordId);
    if (!record || record.userId !== ctx.userId) {
      throw ApplicationHttpError.notFound('Yield record not found.');
    }
    if (record.status === 'claimed') {
      throw ApplicationHttpError.conflict(`Yield record ${record.id} already claimed.`);
    }
    const escrow = record.escrowId ? await this.escrowRepo.findById(record.escrowId) : null;
    const onChainEscrowId = escrow?.onChainEscrowId ?? null;
    if (!onChainEscrowId) {
      throw new ApplicationHttpError(
        425,
        'Escrow not yet indexed on-chain — try again in a few seconds.',
      );
    }

    const actionPayload = {
      action: 'claim',
      yieldRecordId: record.id,
      onChainEscrowId,
      tokenAddress: record.tokenAddress.toLowerCase(),
      distributionId: record.distributionId,
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
      actionId: ActionId.Claim,
      now,
      metadata: {
        tool: 'muhaven_propose_claim',
        yieldRecordId: record.id,
        onChainEscrowId,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'claim',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Claim yield from epoch ${record.distributionId} (escrow #${onChainEscrowId}).`,
      preview: {
        yieldRecordId: record.id,
        onChainEscrowId,
        tokenAddress: record.tokenAddress.toLowerCase(),
        distributionId: record.distributionId,
      },
      sdkCall: {
        contractName: 'MuHavenEscrow',
        functionName: 'redeem',
        args: {
          escrowId: onChainEscrowId,
        },
      },
    };
  }
}
