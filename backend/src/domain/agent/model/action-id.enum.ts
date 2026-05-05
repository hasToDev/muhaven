/**
 * Action enum pinned in ADR-1 (`development/DEV_WAVE_4/ADR_LOG.md`).
 *
 * Plaintext (uint8) selector ID consumed by both the off-chain policy engine
 * and the on-chain `RiskParams.checkAndExecute(eAmount, actionId)` (P6
 * deliverable). Values 1..4 are pinned for Wave 4; 5..255 reserved for
 * issuer-side / governance / future actions.
 *
 * Adding a new action requires an ADR amendment + UUPS upgrade — the value
 * is a load-bearing constant for the on-chain policy hot-path.
 */
export const ActionId = {
  Buy: 1,
  Sell: 2,
  Claim: 3,
  Rebalance: 4,
} as const;

export type ActionId = (typeof ActionId)[keyof typeof ActionId];

export const ACTION_ID_VALUES: readonly ActionId[] = [
  ActionId.Buy,
  ActionId.Sell,
  ActionId.Claim,
  ActionId.Rebalance,
] as const;

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'number' && (ACTION_ID_VALUES as readonly number[]).includes(value);
}

export function actionIdName(actionId: ActionId): string {
  switch (actionId) {
    case ActionId.Buy:
      return 'Buy';
    case ActionId.Sell:
      return 'Sell';
    case ActionId.Claim:
      return 'Claim';
    case ActionId.Rebalance:
      return 'Rebalance';
  }
}
