import { randomUUID } from 'crypto';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { GetPolicyStateUseCase } from '../policy/get-policy-state.use-case.js';
import type { ConfirmTokenService } from '../policy/confirm-token.service.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  SetPolicyDto,
  SetPolicyActionDescriptor,
} from '../../../dto/agent/tool.dto.js';

export interface SetPolicyContext {
  userId: string;
  /** Surface from which the LLM emitted the tool call. */
  emittingSurface: Surface;
}

/**
 * Wave 4 P2 — `muhaven_set_policy(tier, params)`.
 *
 * The agent surface itself NEVER mutates tier — that's the policy/transition
 * route's job and requires a passkey signature on `commit-tier-transition`.
 * This tool produces a confirm-token-bearing ActionDescriptor that the
 * frontend forwards to the policy/transition flow. ADR-0 §"Forbidden
 * Advisory→Policy-bound transition" still applies: the use case rejects
 * the structurally forbidden transitions before the tool returns.
 */
export class SetPolicyToolUseCase {
  constructor(
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly confirmTokens: ConfirmTokenService,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    ctx: SetPolicyContext,
    input: SetPolicyDto,
    now: Date = new Date(),
  ): Promise<SetPolicyActionDescriptor> {
    if (input.targetTier === Tier.Paused) {
      throw ApplicationHttpError.badRequest(
        'Use muhaven_pause for transient pauses; targetTier=paused is not directly settable.',
      );
    }

    const surface = input.surface;
    const current = await this.getPolicyState.forSurface(ctx.userId, surface, now);

    // ADR-0 §"Allowed transitions". Mirror the production /policy/transition
    // checks here so the agent surface can't return a confirm-token for a
    // tier the policy/transition route would reject — better UX + audit
    // narrative ("the agent never proposed an impossible transition").
    if (
      current.tier === Tier.Advisory
      && input.targetTier === Tier.PolicyBound
    ) {
      throw new ApplicationHttpError(
        409,
        'Advisory → Policy-bound is forbidden in Wave 4. Step through Confirm-per-action first.',
      );
    }
    if (
      current.tier === Tier.ConfirmPerAction
      && input.targetTier === Tier.PolicyBound
      && (current.confirmedActionCount < 5 || !current.riskQuestionnaireComplete)
    ) {
      throw new ApplicationHttpError(
        409,
        `Confirm-per-action → Policy-bound requires ≥5 confirmed actions (have ${current.confirmedActionCount}) and a complete risk Q&A (${current.riskQuestionnaireComplete ? 'done' : 'not done'}).`,
      );
    }

    const actionPayload = {
      action: 'set_policy',
      surface,
      targetTier: input.targetTier,
    };
    const issued = await this.confirmTokens.issue({
      userId: ctx.userId,
      actionKind: 'tier_transition',
      actionPayload,
      now,
    });
    await this.appendAudit.execute({
      userId: ctx.userId,
      surface,
      // actionId is intentionally null — set_policy is not a hot-path
      // ActionId (Buy/Sell/Claim/Rebalance per ADR-1). Audit-log queries
      // for tier transitions filter by eventType + metadata.tool.
      eventType: AuditEventType.ConfirmTokenIssued,
      now,
      metadata: {
        tool: 'muhaven_set_policy',
        currentTier: current.tier,
        targetTier: input.targetTier,
        confirmTokenId: issued.token,
      },
    });

    const toolCallId = `tc_${randomUUID()}`;
    return {
      kind: 'set_policy',
      toolCallId,
      confirmTokenId: issued.token,
      expiresAtSec: Math.floor(issued.expiresAt.getTime() / 1000),
      summary: `Switch ${surface} from ${current.tier} → ${input.targetTier}.`,
      preview: {
        surface,
        targetTier: input.targetTier,
        requestedAt: now.toISOString(),
      },
      sdkCall: {
        contractName: 'MuHavenAgentPolicy',
        functionName: 'commitTierTransition',
        args: {
          surface,
          targetTier: input.targetTier,
          // confirmationToken passed by the frontend on the
          // /policy/transition POST — matches the existing API.
        },
      },
    };
  }
}
