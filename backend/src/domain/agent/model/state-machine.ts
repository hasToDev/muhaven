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
 * transitions per ADR-0 §"Allowed transitions and required gates" + the
 * Wave 5 Path D extension for the Scoped tier (RD-2 in
 * `development/DEV_WAVE_5/PATH_D_PLAN.md`).
 *
 * - Advisory → ConfirmPerAction: always allowed (after the user has
 *   accepted the Wealthfront-style limits — that gate is an upstream
 *   responsibility of the route handler).
 * - ConfirmPerAction → PolicyBound: requires `confirmedActionCount ≥ 5`
 *   AND `riskQuestionnaireComplete`.
 * - * → Scoped (Wave 5 Option D · Commit 4, operator decision
 *   2026-05-24 "Uniform"): reachable DIRECTLY from any non-paused tier,
 *   WITHOUT the ≥5-confirm + risk-questionnaire gates. The forced tier
 *   climb (Advisory → Confirm → PolicyBound → Scoped) was trust-
 *   CALIBRATION UX, NOT the security boundary. Scoped's real blast-radius
 *   rails — the on-chain Scoped CallPolicy (purchase-only; `transfer`
 *   excluded), the per-op mhUSDC cap, the 8h TTL, and the dashboard /
 *   Telegram revoke surfaces — are independent of which tier-sequence
 *   reached Scoped, so direct-to-Scoped is no less safe. Re-arming is
 *   never silent: `* → Scoped` is a step-up (the caller's confirmation-
 *   token tap is the consent moment, see
 *   `RequestTierTransitionUseCase.isStepDown`) AND the dashboard mint
 *   ceremony triggers a second user-present passkey signature + requires
 *   an explicit cap + TTL. This applies AFTER a security pause too: the
 *   "Uniform" decision accepts that post-breach re-arming relies on
 *   fresh consent + cap/TTL/revoke rather than a forced re-climb.
 *   See `development/DEV_WAVE_5/NEXT_SESSION_PROMPT_OPTION_D.md`
 *   § "skip the forced tier climb" + memory
 *   `project_skip_tier_climb_direct_scoped`.
 * - All step-downs auto-commit (Scoped → PolicyBound → ConfirmPerAction
 *   → Advisory).
 * - All other transitions in this function are forbidden — pause/resume
 *   has its own entry points. ADR-0 explicitly forbids any
 *   `Advisory → PolicyBound` skip and any
 *   `ConfirmPerAction → PolicyBound` skip without the ≥5-confirms gate.
 *   (The lower-tier PolicyBound gates are deliberately UNCHANGED — they
 *   remain an opt-in climb; only Scoped became directly reachable.)
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

  // Wave 5 Option D · Commit 4 — direct-to-Scoped (operator decision
  // 2026-05-24 "Uniform"). Scoped is reachable from ANY non-paused tier
  // without the ≥5-confirm + risk-questionnaire gates. See the function
  // JSDoc above for the load-bearing rationale (the climb is calibration
  // UX, not the security boundary; cap + TTL + CallPolicy + revoke are
  // the rails). The `target === current.tier` guard above already
  // rejects Scoped → Scoped, and the paused guard already rejects the
  // paused source — so reaching here means current ∈ {Advisory,
  // ConfirmPerAction, PolicyBound}, all of which step UP into Scoped.
  if (target === Tier.Scoped) {
    return accept(current, target, null, now);
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

  if (current.tier === Tier.PolicyBound) {
    if (target === Tier.ConfirmPerAction) {
      return accept(current, target, null, now);
    }
    if (target === Tier.Advisory) {
      return accept(current, target, null, now);
    }
  }

  if (current.tier === Tier.Scoped) {
    if (
      target === Tier.PolicyBound ||
      target === Tier.ConfirmPerAction ||
      target === Tier.Advisory
    ) {
      return accept(current, target, null, now);
    }
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
 * landing is always `advisory`, and the gate counters
 * (`confirmedActionCount` + `riskQuestionnaireComplete`) are cleared.
 *
 * Wave 5 Option D · Commit 4 (operator decision 2026-05-24 "Uniform") —
 * **post-pause re-arming is NO LONGER a forced re-climb.** Pre-C4 the
 * cleared counters were a hard R-1 defense: a breached user had to
 * re-season through Confirm → PolicyBound (≥5 confirms + risk Q) before
 * Scoped re-opened. C4 made Scoped directly reachable from any non-paused
 * tier without those gates, so the counter reset no longer gates Scoped
 * re-arming. The operator accepted this trade-off: post-breach re-arming
 * relies instead on FRESH consent — a confirmation-token step-up tap + a
 * passkey-signed mint ceremony + an explicit per-op cap + 8h TTL — plus
 * the standing rails (purchase-only CallPolicy with `transfer` excluded,
 * per-op cap, TTL, revoke). The counter reset is retained so the lower
 * opt-in climb (Confirm → PolicyBound) still requires fresh evidence, and
 * so any future re-tightening of the Scoped gate is meaningful again.
 * If a stricter post-breach posture is ever wanted, add an explicit
 * cooldown / "pause-trigger still active?" check before `* → Scoped`
 * rather than relying on these counters.
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
    confirmedActionCount: 0,
    riskQuestionnaireComplete: false,
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
