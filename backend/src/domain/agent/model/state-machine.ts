import { Tier } from './tier.enum.js';
import type { Trigger } from './trigger.enum.js';
import { AgentUserState } from './agent-user-state.js';

/**
 * Pure-domain state machine implementing ADR-0
 * (`development/DEV_WAVE_4/ADR_LOG.md`).
 *
 * No I/O, no logging, no time mocking — callers (use cases) decide where
 * the side effects land. Wraps every transition in a `TransitionResult`
 * that exposes both the new entity and a structured outcome so the use
 * case can compose the audit-event side effect deterministically.
 *
 * Gate inputs (`confirmedActionCount`, `riskQuestionnaireComplete`) are
 * read-only here. P2 (HavenBot per-action confirmation modal) increments
 * the count on each successful Confirm-tier action; P2 onboarding flow
 * flips the questionnaire flag. This module never mutates them.
 */
export const MIN_CONFIRMS_FOR_POLICY_BOUND = 5;

export interface TransitionContext {
  /** Optional override for `now` — tests pass a fixed Date. */
  now?: Date;
}

export type TransitionRejectionCode =
  | 'forbidden_transition'
  | 'gate_failed_confirms'
  | 'gate_failed_questionnaire'
  | 'gate_failed_already_paused';

export interface TransitionRejection {
  ok: false;
  code: TransitionRejectionCode;
  message: string;
}

export interface TransitionAccepted {
  ok: true;
  state: AgentUserState;
  fromTier: Tier;
  toTier: Tier;
  trigger: Trigger | null;
}

export type TransitionResult = TransitionAccepted | TransitionRejection;

function nowOf(ctx?: TransitionContext): Date {
  return ctx?.now ?? new Date();
}

/**
 * User-initiated tier change (no security trigger). Validates allowed
 * transitions per ADR-0 §"Allowed transitions and required gates".
 *
 * - Advisory → ConfirmPerAction: always allowed (after the user has
 *   accepted the Wealthfront-style limits — that gate is an upstream
 *   responsibility of the route handler).
 * - ConfirmPerAction → PolicyBound: requires `confirmedActionCount ≥ 5`
 *   AND `riskQuestionnaireComplete`.
 * - All other transitions in this function are forbidden — pause/resume
 *   has its own entry points. ADR-0 explicitly forbids any
 *   `Advisory → PolicyBound` skip and any
 *   `ConfirmPerAction → PolicyBound` skip without the ≥5-confirms gate.
 */
export function requestUserTierChange(
  current: AgentUserState,
  target: Tier,
  ctx?: TransitionContext,
): TransitionResult {
  const now = nowOf(ctx);

  if (current.tier === Tier.Paused) {
    return {
      ok: false,
      code: 'gate_failed_already_paused',
      message: 'cannot transition while paused — call resume() first',
    };
  }

  if (target === current.tier) {
    return {
      ok: false,
      code: 'forbidden_transition',
      message: `already at tier ${current.tier}`,
    };
  }

  if (target === Tier.Paused) {
    return {
      ok: false,
      code: 'forbidden_transition',
      message: 'pause must be entered via triggerPause()',
    };
  }

  if (current.tier === Tier.Advisory) {
    if (target === Tier.ConfirmPerAction) {
      return accept(current, target, null, now);
    }
    if (target === Tier.PolicyBound) {
      return {
        ok: false,
        code: 'forbidden_transition',
        message: 'advisory → policy-bound is forbidden in Wave 4 (must traverse confirm-per-action)',
      };
    }
  }

  if (current.tier === Tier.ConfirmPerAction) {
    if (target === Tier.Advisory) {
      return accept(current, target, null, now);
    }
    if (target === Tier.PolicyBound) {
      if (current.confirmedActionCount < MIN_CONFIRMS_FOR_POLICY_BOUND) {
        return {
          ok: false,
          code: 'gate_failed_confirms',
          message: `policy-bound requires ≥${MIN_CONFIRMS_FOR_POLICY_BOUND} confirmed actions; have ${current.confirmedActionCount}`,
        };
      }
      if (!current.riskQuestionnaireComplete) {
        return {
          ok: false,
          code: 'gate_failed_questionnaire',
          message: 'policy-bound requires the risk questionnaire to be completed first',
        };
      }
      return accept(current, target, null, now);
    }
  }

  if (current.tier === Tier.PolicyBound && target === Tier.ConfirmPerAction) {
    return accept(current, target, null, now);
  }

  if (current.tier === Tier.PolicyBound && target === Tier.Advisory) {
    return accept(current, target, null, now);
  }

  return {
    ok: false,
    code: 'forbidden_transition',
    message: `transition ${current.tier} → ${target} is not allowed`,
  };
}

/**
 * Trigger-driven pause. Always lands in `paused` regardless of source tier
 * (idempotent — pausing an already-paused state is a no-op + audit entry,
 * but the repository updates `pausedAt` / `pauseTrigger` to reflect the
 * latest source).
 */
export function triggerPause(
  current: AgentUserState,
  trigger: Trigger,
  metadata: Record<string, unknown> | null,
  ctx?: TransitionContext,
): TransitionAccepted {
  const now = nowOf(ctx);
  const next = current.with({
    tier: Tier.Paused,
    pausedAt: now,
    pauseTrigger: trigger,
    pauseMetadata: metadata,
    enteredAt: now,
    updatedAt: now,
  });
  return {
    ok: true,
    state: next,
    fromTier: current.tier,
    toTier: Tier.Paused,
    trigger,
  };
}

/**
 * Resume from paused. Per ADR-0 §"Allowed transitions" the post-pause
 * landing is always `advisory` — the user must re-traverse
 * Confirm → PolicyBound to regain autonomy. This is a hard structural
 * defense for R-1 (forces every breach to season behaviour through the
 * confirm tier before scope re-expands).
 */
export function resumeAfterPause(
  current: AgentUserState,
  ctx?: TransitionContext,
): TransitionResult {
  if (current.tier !== Tier.Paused) {
    return {
      ok: false,
      code: 'forbidden_transition',
      message: `cannot resume from tier ${current.tier}; only paused is resumable`,
    };
  }
  const now = nowOf(ctx);
  const next = current.with({
    tier: Tier.Advisory,
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
    enteredAt: now,
    validatorAddress: null,
    updatedAt: now,
  });
  return {
    ok: true,
    state: next,
    fromTier: Tier.Paused,
    toTier: Tier.Advisory,
    trigger: null,
  };
}

function accept(
  current: AgentUserState,
  target: Tier,
  trigger: Trigger | null,
  now: Date,
): TransitionAccepted {
  const next = current.with({
    tier: target,
    enteredAt: now,
    updatedAt: now,
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
  });
  return {
    ok: true,
    state: next,
    fromTier: current.tier,
    toTier: target,
    trigger,
  };
}
