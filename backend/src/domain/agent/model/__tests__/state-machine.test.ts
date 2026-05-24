import { describe, it, expect } from 'vitest';
import {
  MIN_CONFIRMS_FOR_POLICY_BOUND,
  requestUserTierChange,
  resumeAfterPause,
  triggerPause,
} from '../state-machine.js';
import { Tier } from '../tier.enum.js';
import { Surface } from '../surface.enum.js';
import { Trigger } from '../trigger.enum.js';
import { AgentUserState } from '../agent-user-state.js';

const NOW = new Date('2026-04-30T00:00:00.000Z');

function freshState(overrides: Partial<AgentUserState> = {}): AgentUserState {
  return new AgentUserState({
    userId: 'u1',
    surface: Surface.HavenBot,
    tier: Tier.Advisory,
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
    enteredAt: NOW,
    validatorAddress: null,
    confirmedActionCount: 0,
    riskQuestionnaireComplete: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('state-machine — allowed transitions', () => {
  it('Advisory → ConfirmPerAction is always allowed', () => {
    const s = freshState({ tier: Tier.Advisory });
    const r = requestUserTierChange(s, Tier.ConfirmPerAction, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.ConfirmPerAction);
  });

  it('ConfirmPerAction → PolicyBound requires ≥5 confirms + risk Q&A', () => {
    const s = freshState({
      tier: Tier.ConfirmPerAction,
      confirmedActionCount: MIN_CONFIRMS_FOR_POLICY_BOUND,
      riskQuestionnaireComplete: true,
    });
    const r = requestUserTierChange(s, Tier.PolicyBound, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.PolicyBound);
  });

  it('PolicyBound → ConfirmPerAction is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.PolicyBound });
    const r = requestUserTierChange(s, Tier.ConfirmPerAction, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it('ConfirmPerAction → Advisory is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.ConfirmPerAction });
    const r = requestUserTierChange(s, Tier.Advisory, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it('PolicyBound → Advisory is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.PolicyBound });
    const r = requestUserTierChange(s, Tier.Advisory, { now: NOW });
    expect(r.ok).toBe(true);
  });

  // Wave 5 Option D · Commit 4 — direct-to-Scoped (operator decision
  // 2026-05-24 "Uniform"). The forced climb was removed: Scoped is
  // reachable from ANY non-paused tier WITHOUT the ≥5-confirm + risk-Q
  // gates. Pre-C4 these four cases were `forbidden_transition` /
  // `gate_failed_*`; they now accept. See state-machine.ts JSDoc.

  it('Advisory → Scoped is allowed directly (no climb, no gates)', () => {
    const s = freshState({
      tier: Tier.Advisory,
      confirmedActionCount: 0,
      riskQuestionnaireComplete: false,
    });
    const r = requestUserTierChange(s, Tier.Scoped, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.Scoped);
  });

  it('ConfirmPerAction → Scoped is allowed directly (no gates)', () => {
    const s = freshState({
      tier: Tier.ConfirmPerAction,
      confirmedActionCount: 0,
      riskQuestionnaireComplete: false,
    });
    const r = requestUserTierChange(s, Tier.Scoped, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.Scoped);
  });

  it('PolicyBound → Scoped is allowed without ≥5 confirms or risk Q&A', () => {
    const s = freshState({
      tier: Tier.PolicyBound,
      confirmedActionCount: 0,
      riskQuestionnaireComplete: false,
    });
    const r = requestUserTierChange(s, Tier.Scoped, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.Scoped);
  });

  it('Scoped → PolicyBound is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.Scoped });
    const r = requestUserTierChange(s, Tier.PolicyBound, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.tier).toBe(Tier.PolicyBound);
  });

  it('Scoped → ConfirmPerAction is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.Scoped });
    const r = requestUserTierChange(s, Tier.ConfirmPerAction, { now: NOW });
    expect(r.ok).toBe(true);
  });

  it('Scoped → Advisory is allowed (step-down)', () => {
    const s = freshState({ tier: Tier.Scoped });
    const r = requestUserTierChange(s, Tier.Advisory, { now: NOW });
    expect(r.ok).toBe(true);
  });
});

describe('state-machine — forbidden transitions (ADR-0)', () => {
  it('Advisory → PolicyBound is forbidden in Wave 4', () => {
    const s = freshState({ tier: Tier.Advisory });
    const r = requestUserTierChange(s, Tier.PolicyBound, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden_transition');
  });

  it('ConfirmPerAction → PolicyBound without ≥5 confirms is rejected', () => {
    const s = freshState({
      tier: Tier.ConfirmPerAction,
      confirmedActionCount: 4,
      riskQuestionnaireComplete: true,
    });
    const r = requestUserTierChange(s, Tier.PolicyBound, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('gate_failed_confirms');
  });

  it('ConfirmPerAction → PolicyBound without risk Q&A is rejected', () => {
    const s = freshState({
      tier: Tier.ConfirmPerAction,
      confirmedActionCount: 5,
      riskQuestionnaireComplete: false,
    });
    const r = requestUserTierChange(s, Tier.PolicyBound, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('gate_failed_questionnaire');
  });

  it('any transition while paused is rejected — must call resume first', () => {
    const s = freshState({ tier: Tier.Paused, pausedAt: NOW, pauseTrigger: Trigger.ExplicitPause });
    const r = requestUserTierChange(s, Tier.Advisory, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('gate_failed_already_paused');
  });

  it('cannot transition INTO paused via the user-tier-change path', () => {
    const s = freshState({ tier: Tier.PolicyBound });
    const r = requestUserTierChange(s, Tier.Paused, { now: NOW });
    expect(r.ok).toBe(false);
  });

  it('rejecting a self-transition (advisory → advisory)', () => {
    const s = freshState({ tier: Tier.Advisory });
    const r = requestUserTierChange(s, Tier.Advisory, { now: NOW });
    expect(r.ok).toBe(false);
  });

  // Wave 5 Option D · Commit 4 — the Scoped tier is NO LONGER gated
  // behind a forced climb (see the "allowed transitions" block for the
  // direct-to-Scoped cases). Scoped → Scoped is still rejected as a
  // self-transition; only that invariant remains here.
  it('rejecting a self-transition (scoped → scoped)', () => {
    const s = freshState({ tier: Tier.Scoped });
    const r = requestUserTierChange(s, Tier.Scoped, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden_transition');
  });

  it('Scoped target while paused is still rejected (resume first)', () => {
    const s = freshState({
      tier: Tier.Paused,
      pausedAt: NOW,
      pauseTrigger: Trigger.DrawdownBreach,
    });
    const r = requestUserTierChange(s, Tier.Scoped, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('gate_failed_already_paused');
  });
});

describe('state-machine — pause/resume', () => {
  it('triggerPause moves any tier into Paused with the trigger recorded', () => {
    const s = freshState({ tier: Tier.PolicyBound });
    const r = triggerPause(s, Trigger.DrawdownBreach, { source: 'cron' }, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.state.tier).toBe(Tier.Paused);
    expect(r.state.pauseTrigger).toBe(Trigger.DrawdownBreach);
    expect(r.state.pausedAt).toEqual(NOW);
    expect(r.state.pauseMetadata).toEqual({ source: 'cron' });
  });

  it('resumeAfterPause lands paused users back in Advisory', () => {
    const s = freshState({
      tier: Tier.Paused,
      pausedAt: NOW,
      pauseTrigger: Trigger.ExplicitPause,
      validatorAddress: '0xvalidator',
    });
    const r = resumeAfterPause(s, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.tier).toBe(Tier.Advisory);
      expect(r.state.pausedAt).toBeNull();
      expect(r.state.pauseTrigger).toBeNull();
      // validator address cleared — re-traverse Confirm → PolicyBound to remint
      expect(r.state.validatorAddress).toBeNull();
    }
  });

  it('resumeAfterPause refuses non-paused tiers', () => {
    const s = freshState({ tier: Tier.PolicyBound });
    const r = resumeAfterPause(s, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden_transition');
  });

  // Wave 5 Path D — resume MUST reset gate counters so the post-pause
  // re-traversal is semantically meaningful, not just structural. Without
  // this, a Scoped user paused by drawdown/oracle/KYC could speed-run
  // back to Scoped on the stale counters.
  it('resumeAfterPause resets gate counters so re-traversal re-seasons the user', () => {
    const s = freshState({
      tier: Tier.Paused,
      pausedAt: NOW,
      pauseTrigger: Trigger.DrawdownBreach,
      confirmedActionCount: 8,
      riskQuestionnaireComplete: true,
      validatorAddress: '0xvalidator',
    });
    const r = resumeAfterPause(s, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.tier).toBe(Tier.Advisory);
      expect(r.state.confirmedActionCount).toBe(0);
      expect(r.state.riskQuestionnaireComplete).toBe(false);
      expect(r.state.validatorAddress).toBeNull();
    }
  });
});
