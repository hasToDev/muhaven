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
 * Wave 5 Path D Slice 2 Commit 2.B — chain-anchor hash normalization
 * (self-review pre-Codex pass).
 *
 * `ConfirmTokenService.hashAction` returns `createHash('sha256').
 * digest('hex')` which is 64 bare-hex chars WITHOUT `0x` prefix
 * (matches the DB column `agent_confirm_tokens.action_hash` historical
 * shape). The `agent_scoped_sessions` mirror's `consent_action_hash`,
 * by contrast, follows the codebase's standard `HEX_32_BYTE_RE`
 * convention `/^0x[0-9a-fA-F]{64}$/` (Zod-enforced at mint time per
 * `MintScopedSessionDtoSchema:250`).
 *
 * For the WORM forensic-chain JOIN to work
 * (`ScopedSessionMinted.metadata.consentActionHash` ↔
 * `ConfirmTokenConsumed.metadata.actionHash` ↔
 * `TierChanged.metadata.actionHash` ↔
 * `ConfirmTokenIssued.metadata.actionHash`), the audit-metadata view
 * of the hash MUST be byte-equal. Without normalization, a JOIN
 * query `metadata->>'consentActionHash' = metadata->>'actionHash'`
 * would compare `'0xabc...'` (mint side) against `'abc...'` (consume
 * side) and produce zero matches — silently defeating the Compliance
 * H-1 forensic-chain claim.
 *
 * Resolution: keep the DB column shape unchanged (bare-hex, no
 * back-compat churn) and prefix `0x` at the audit-emit boundary. The
 * mint-side `consentActionHash` already arrives `0x`-prefixed per
 * Zod; this normalization makes ALL chain anchors consistently
 * `0x`-prefixed hex in audit metadata.
 */
function toChainAnchorHash(bareHashHex: string): `0x${string}` {
  return (bareHashHex.startsWith('0x') ? bareHashHex : `0x${bareHashHex}`) as `0x${string}`;
}

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

    // Auto-confirm step-downs. Any step UP requires a passkey-bound
    // confirmation token because the user is broadening agent capability.
    // Scoped (Wave 5 Path D) sits above PolicyBound — Scoped → * is always
    // a step-down; * → Scoped is a step-up (handled below).
    const isStepDown =
      (current.tier === Tier.Scoped && input.targetTier === Tier.PolicyBound) ||
      (current.tier === Tier.Scoped && input.targetTier === Tier.ConfirmPerAction) ||
      (current.tier === Tier.Scoped && input.targetTier === Tier.Advisory) ||
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
        actionHash: toChainAnchorHash(confirmation.actionHash),
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

    // Capture the consumed token's `actionHash` so both audit rows
    // below can embed it. PATH_D_PLAN.md §"Slice 2 audit-correlation
    // requirement" (line 263-265, Security M-2) mandates that the
    // forensic chain {userop → ScopedSessionMinted → TierChanged →
    // ConfirmTokenConsumed} be reconstructable from the WORM audit log
    // alone, i.e. without joining against the mutable
    // `agent_confirm_tokens` table. Anchoring the SAME hash on the
    // mint row (Commit 2.B mint use-case) AND the consume + tier-
    // change rows below gives forensic queries a stable join key
    // (Compliance Auditor R2 H-1).
    const consumed = await this.confirmTokens.consume(
      input.confirmationToken,
      input.userId,
      'tier_transition',
      { surface: input.surface, targetTier: input.targetTier },
      now,
    );

    await this.stateRepo.upsert(result.state);

    const anchoredHash = toChainAnchorHash(consumed.actionHash);
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.ConfirmTokenConsumed,
      now,
      metadata: {
        actionKind: 'tier_transition',
        targetTier: input.targetTier,
        actionHash: anchoredHash,
      },
    });
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.TierChanged,
      tierBefore: current.tier,
      tierAfter: input.targetTier,
      now,
      metadata: { actionHash: anchoredHash },
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
