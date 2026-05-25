/**
 * Wave 5 Slice 1 (MCP sell) — server-side derivation of the autonomous SELL
 * selectorCaps (+ per-token queue targets) for a Scoped session.
 *
 * Why this exists (LOCKED decision #1): the on-chain Scoped CallPolicy that
 * the user's passkey installed at mint (the D-1 broadening) ALREADY authorizes
 * `MuHavenSubscription.redeem` + `RedemptionQueue.submit`/`claim` — so the
 * agent can sell within the same on-chain envelope it could already buy
 * within, with NO per-user on-chain re-mint. The only gating is the OFF-CHAIN
 * broker `selectorCaps` snapshot, which legacy (pre-Slice-1) sessions minted
 * with ONLY `subscription.purchase`. This helper extends a legacy session's
 * caps to cover the sell ops, derived from the existing purchase cap (same
 * per-op share ceiling). NEW mints carry these caps natively (the frontend
 * `buildScopedMintBody`), so this only changes legacy rows on read.
 *
 * It is PURE — the caller decides whether to apply the result (and to emit the
 * one-time provenance audit). Never mutates the input session.
 */

import { toFunctionSelector } from 'viem';
import type {
  ScopedSession,
  ScopedSelectorCap,
} from '../../../../domain/agent/model/scoped-session.js';

/** `MuHavenSubscription.purchase(address,InEuint128,uint128,address)` — the
 *  signal cap a Path-D autonomy session always carries; its `maxAmount` is the
 *  per-op share ceiling reused for redeem + submit. */
export const SUBSCRIPTION_PURCHASE_SELECTOR = toFunctionSelector(
  'function purchase(address,(uint256,uint8,uint8,bytes),uint128,address)',
).toLowerCase() as `0x${string}`;

/** `MuHavenSubscription.redeem(...)` — same arg shape as purchase, so
 *  `maxSharesHint` is at word index 2. */
export const SUBSCRIPTION_REDEEM_SELECTOR = toFunctionSelector(
  'function redeem(address,(uint256,uint8,uint8,bytes),uint128,address)',
).toLowerCase() as `0x${string}`;
export const REDEEM_CAP_ARG_INDEX = 2;

/** `RedemptionQueue.submit(InEuint128,uint128,address)` — NO leading token
 *  arg (queue is per-token), so `maxSharesHint` is at word index 1. */
export const REDEMPTION_QUEUE_SUBMIT_SELECTOR = toFunctionSelector(
  'function submit((uint256,uint8,uint8,bytes),uint128,address)',
).toLowerCase() as `0x${string}`;
export const QUEUE_SUBMIT_CAP_ARG_INDEX = 1;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export interface DerivedSellCaps {
  readonly selectorCaps: ScopedSelectorCap[];
  readonly targetContracts: `0x${string}`[];
  /** Which sell selectors were newly added (for the provenance audit). Empty
   *  when nothing changed. */
  readonly addedSelectors: `0x${string}`[];
  /** True iff selectorCaps OR targetContracts gained an entry. */
  readonly changed: boolean;
}

/**
 * Derive the augmented `selectorCaps` + `targetContracts` for a Scoped
 * session so the broker can autonomously sell. Idempotent: a session that
 * already carries the redeem/submit caps + queue targets returns
 * `changed: false` with its existing arrays (copied).
 *
 * Only derives when the session carries a CAPPED `subscription.purchase`
 * entry — that's the marker of a Path-D autonomy session minted from the
 * pre-authorized envelope, and its `maxAmount` is the per-op share ceiling we
 * apply to redeem + submit. A session without it (or with an uncapped
 * purchase) is left untouched.
 *
 * @param redemptionQueueAddresses every per-token RedemptionQueue address
 *   (`Object.values` of the `REDEMPTION_QUEUE_BY_TOKEN_JSON` map). Empty →
 *   only the redeem cap is derived (no submit cap, no queue targets), so
 *   `viaQueue` sells degrade to a Path-C deep-link.
 */
export function deriveAutonomousSellCaps(
  session: ScopedSession,
  redemptionQueueAddresses: readonly string[],
): DerivedSellCaps {
  const selectorCaps: ScopedSelectorCap[] = [...session.selectorCaps];
  const targetContracts: `0x${string}`[] = [...session.targetContracts];
  const addedSelectors: `0x${string}`[] = [];

  const purchaseCap = selectorCaps.find(
    (c) => c.selector.toLowerCase() === SUBSCRIPTION_PURCHASE_SELECTOR,
  );
  // No capped purchase entry → not a Path-D autonomy session we should
  // extend. Leave it exactly as minted.
  if (!purchaseCap || purchaseCap.maxAmount === null || purchaseCap.capArgIndex === null) {
    return { selectorCaps, targetContracts, addedSelectors: [], changed: false };
  }
  const perOpCap = purchaseCap.maxAmount;

  const hasSelector = (sel: `0x${string}`): boolean =>
    selectorCaps.some((c) => c.selector.toLowerCase() === sel);
  const hasTarget = (t: string): boolean =>
    targetContracts.some((x) => x.toLowerCase() === t);

  // redeem — subscription target already in the allowlist; same cap shape.
  if (!hasSelector(SUBSCRIPTION_REDEEM_SELECTOR)) {
    selectorCaps.push({
      selector: SUBSCRIPTION_REDEEM_SELECTOR,
      capArgIndex: REDEEM_CAP_ARG_INDEX,
      maxAmount: perOpCap,
    });
    addedSelectors.push(SUBSCRIPTION_REDEEM_SELECTOR);
  }

  // queue submit — needs the per-token queue targets AND a submit cap
  // (capArgIndex 1). Dedupe + lower-case + shape-check the queue addresses.
  const seenQueues = new Set<string>();
  for (const raw of redemptionQueueAddresses) {
    if (!ADDR_RE.test(raw)) continue;
    const lower = raw.toLowerCase() as `0x${string}`;
    if (seenQueues.has(lower)) continue;
    seenQueues.add(lower);
    if (!hasTarget(lower)) targetContracts.push(lower);
  }
  if (seenQueues.size > 0 && !hasSelector(REDEMPTION_QUEUE_SUBMIT_SELECTOR)) {
    selectorCaps.push({
      selector: REDEMPTION_QUEUE_SUBMIT_SELECTOR,
      capArgIndex: QUEUE_SUBMIT_CAP_ARG_INDEX,
      maxAmount: perOpCap,
    });
    addedSelectors.push(REDEMPTION_QUEUE_SUBMIT_SELECTOR);
  }

  const changed =
    selectorCaps.length !== session.selectorCaps.length ||
    targetContracts.length !== session.targetContracts.length;
  return { selectorCaps, targetContracts, addedSelectors, changed };
}
