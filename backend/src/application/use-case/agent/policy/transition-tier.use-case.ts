import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import { AgentUserState } from '../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import {
  requestUserTierChange,
  type TransitionRejectionCode,
} from '../../../../domain/agent/model/state-machine.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { GetPolicyStateUseCase } from './get-policy-state.use-case.js';
import { ConfirmTokenService, type IssueConfirmTokenResult } from './confirm-token.service.js';
import { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

/**
 * Phase-1 (issue): user requests a tier transition. The state machine
 * validates the proposed transition against current state. If allowed
 * but requires a passkey-bound confirmation (any transition out of
 * Advisory or into PolicyBound), we issue a single-use token and return
 * `{ requiresConfirmation: true }`.
 */
export interface RequestTierTransitionInput {
  userId: string;
  surface: Surface;
  targetTier: Tier;
  now?: Date;
}

export type RequestTierTransitionResult =
  | { requiresConfirmation: true; confirmation: IssueConfirmTokenResult }
  | { requiresConfirmation: false; state: AgentUserState };

export class RequestTierTransitionUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: RequestTierTransitionInput): Promise<RequestTierTransitionResult> {
    const now = input.now ?? new Date();
    const current = await this.getPolicyState.forSurface(input.userId, input.surface, now);

    const result = requestUserTierChange(current, input.targetTier, { now });
    if (!result.ok) {
      throw mapRejectionToHttp(result.code, result.message);
    }

    // Auto-confirm the cheapest transition (Advisory ⇆ ConfirmPerAction
    // *only* when stepping down). Any step into ConfirmPerAction or
    // PolicyBound requires a passkey-bound confirmation token because the
    // user is broadening agent capability.
    const isStepDown =
      (current.tier === Tier.PolicyBound && input.targetTier === Tier.ConfirmPerAction) ||
      (current.tier === Tier.PolicyBound && input.targetTier === Tier.Advisory) ||
      (current.tier === Tier.ConfirmPerAction && input.targetTier === Tier.Advisory);

    if (isStepDown) {
      await this.stateRepo.upsert(result.state);
      await this.appendAudit.execute({
        userId: input.userId,
        surface: input.surface,
        eventType: AuditEventType.TierChanged,
        tierBefore: current.tier,
        tierAfter: input.targetTier,
        now,
      });
      return { requiresConfirmation: false, state: result.state };
    }

    const confirmation = await this.confirmTokens.issue({
      userId: input.userId,
      actionKind: 'tier_transition',
      actionPayload: { surface: input.surface, targetTier: input.targetTier },
      now,
    });

    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.ConfirmTokenIssued,
      now,
      metadata: {
        actionKind: 'tier_transition',
        actionHash: confirmation.actionHash,
        expiresAt: confirmation.expiresAt.toISOString(),
        targetTier: input.targetTier,
      },
    });

    return { requiresConfirmation: true, confirmation };
  }
}

/**
 * Phase-2: user posts the confirmation token. We re-validate the state
 * machine with current state, atomically consume the token, then upsert
 * the new tier state.
 *
 * TOCTOU note: there is a small window between consume and upsert during
 * which another request (e.g., a webhook-driven pause) could change the
 * stored state. The upsert here would then clobber that change. The
 * window is microseconds in the happy path; the threat model is concurrent
 * requests for the same user, which is rare. Wave 5 will wrap consume +
 * upsert in a single Postgres transaction.
 */
export interface CommitTierTransitionInput {
  userId: string;
  surface: Surface;
  targetTier: Tier;
  confirmationToken: string;
  now?: Date;
}

export class CommitTierTransitionUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: CommitTierTransitionInput): Promise<AgentUserState> {
    const now = input.now ?? new Date();
    const current = await this.getPolicyState.forSurface(input.userId, input.surface, now);

    // Re-validate. Even a recently-issued token can't override a tier
    // gate — if the state changed between issue and commit (e.g., a
    // KYC revocation paused the user), the consume should still fail.
    const result = requestUserTierChange(current, input.targetTier, { now });
    if (!result.ok) {
      throw mapRejectionToHttp(result.code, result.message);
    }

    await this.confirmTokens.consume(
      input.confirmationToken,
      input.userId,
      'tier_transition',
      { surface: input.surface, targetTier: input.targetTier },
      now,
    );

    await this.stateRepo.upsert(result.state);

    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.ConfirmTokenConsumed,
      now,
      metadata: { actionKind: 'tier_transition', targetTier: input.targetTier },
    });
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.TierChanged,
      tierBefore: current.tier,
      tierAfter: input.targetTier,
      now,
    });

    return result.state;
  }
}

function mapRejectionToHttp(
  code: TransitionRejectionCode,
  message: string,
): ApplicationHttpError {
  switch (code) {
    case 'forbidden_transition':
      return ApplicationHttpError.forbidden(message);
    case 'gate_failed_confirms':
    case 'gate_failed_questionnaire':
      return new ApplicationHttpError(412, message);
    case 'gate_failed_already_paused':
      return new ApplicationHttpError(423, message);
  }
}
