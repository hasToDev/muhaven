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
 * `confirmedActionCount` / `riskQuestionnaireComplete` are still read by
 * other surfaces (P2 maintains them for display / future policy) but, as
 * of the Option D · C4 "pick any tier" follow-up, NO LONGER gate any
 * transition here — the old `MIN_CONFIRMS_FOR_POLICY_BOUND` (=5) gate was
 * removed along with the forced climb. See `requestUserTierChange` JSDoc.
 */
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
 * User-initiated tier change (no security trigger).
 *
 * **Wave 5 Option D · Commit 4 (+ "pick any tier" follow-up, operator
 * decisions 2026-05-24) — the forced tier climb is FULLY removed.** Any
 * non-paused tier may move DIRECTLY to any OTHER non-paused tier:
 * - Upward moves (e.g. Advisory → PolicyBound, Advisory → Scoped) are
 *   step-ups; the caller (`RequestTierTransitionUseCase`) requires a
 *   passkey-bound confirmation-token tap as the consent moment. The
 *   Scoped mint ceremony adds a second user-present passkey signature +
 *   an explicit per-op cap + TTL.
 * - Downward moves auto-commit (no confirmation).
 *
 * There are NO remaining `confirmedActionCount` / `riskQuestionnaireComplete`
 * gates. Those gated the OLD climb (Confirm → PolicyBound → Scoped); they
 * were trust-CALIBRATION UX, not the security boundary. The real rails are
 * per-tier and independent of which sequence reached the tier — the
 * on-chain Scoped CallPolicy (purchase-only; `transfer` excluded), the
 * per-op mhUSDC cap, the 8h TTL, and the dashboard / Telegram revoke
 * surfaces. C4 first removed the Scoped gate; keeping a forced climb to
 * the LOWER PolicyBound tier while the HIGHER Scoped tier was directly
 * reachable was an inversion, so this follow-up removes the PolicyBound
 * gates too — the whole ladder is now "pick any tier, one confirm tap".
 *
 * The only rejections that remain: same-tier (no-op), source paused
 * (resume first), target paused (use `triggerPause`). `confirmedActionCount`
 * + `riskQuestionnaireComplete` stay on the entity (P2 maintains them for
 * display / future policy) but no longer gate anything here. If a stricter
 * posture is ever wanted (e.g. post-breach cooldown), reintroduce a gate
 * here rather than relying on those counters elsewhere.
 *
 * See `development/DEV_WAVE_5/NEXT_SESSION_PROMPT_OPTION_D.md`
 * § "skip the forced tier climb" + memory `project_skip_tier_climb_direct_scoped`.
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

  // Any non-paused → any other non-paused tier is allowed. Step-up vs
  // step-down (and the confirmation-token requirement for step-ups) is the
  // caller's concern — see `RequestTierTransitionUseCase.isStepDown`. The
  // guards above already reject same-tier, source-paused, and target-paused.
  return accept(current, target, null, now);
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
