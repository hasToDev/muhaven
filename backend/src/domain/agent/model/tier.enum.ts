/**
 * Tiered-autonomy state per ADR-0 (`development/DEV_WAVE_4/ADR_LOG.md`).
 *
 * `paused` is a transient state — the engine always lands a paused user back
 * in `advisory` after the trigger-specific cleanup completes. It is modelled
 * as a tier so it can be stored uniformly in `agent_user_state`.
 *
 * `scoped` (Wave 5 Path D, RD-1/RD-2) is the most autonomous tier — agent
 * signs UserOps without prompting, bounded by a broker-side policy snapshot
 * (`maxPerOpUsd6` + ttl). Transition rules live in `state-machine.ts`;
 * full spec in `development/DEV_WAVE_5/PATH_D_PLAN.md`.
 *
 * **TIER_VALUES vs Postgres enum ordering**: `TIER_VALUES` below is the
 * source of truth for application logic. Drizzle declarative push emits
 * `ALTER TYPE agent_tier ADD VALUE 'scoped'` without a `BEFORE` clause,
 * so the Postgres enum's internal ordering appends new values at the end
 * regardless of source order here. **Never compare tiers by ordinal
 * position** — neither `TIER_VALUES.indexOf()` nor a Postgres `ORDER BY
 * tier` will give a stable result across schema evolutions. Compare by
 * string identity (`tier === Tier.X`). If you need a tier-rank ordinal
 * (e.g., "max tier reached" tracking), define an explicit
 * `Record<Tier, number>` map; do NOT lean on the enum ordering.
 */
export const Tier = {
  Advisory: 'advisory',
  ConfirmPerAction: 'confirm-per-action',
  PolicyBound: 'policy-bound',
  Scoped: 'scoped',
  Paused: 'paused',
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

export const TIER_VALUES: readonly Tier[] = [
  Tier.Advisory,
  Tier.ConfirmPerAction,
  Tier.PolicyBound,
  Tier.Scoped,
  Tier.Paused,
] as const;

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_VALUES as readonly string[]).includes(value);
}
