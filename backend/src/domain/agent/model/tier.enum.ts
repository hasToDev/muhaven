/**
 * Tiered-autonomy state per ADR-0 (`development/DEV_WAVE_4/ADR_LOG.md`).
 *
 * `paused` is a transient state — the engine always lands a paused user back
 * in `advisory` after the trigger-specific cleanup completes. It is modelled
 * as a tier so it can be stored uniformly in `agent_user_state`.
 */
export const Tier = {
  Advisory: 'advisory',
  ConfirmPerAction: 'confirm-per-action',
  PolicyBound: 'policy-bound',
  Paused: 'paused',
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

export const TIER_VALUES: readonly Tier[] = [
  Tier.Advisory,
  Tier.ConfirmPerAction,
  Tier.PolicyBound,
  Tier.Paused,
] as const;

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_VALUES as readonly string[]).includes(value);
}
