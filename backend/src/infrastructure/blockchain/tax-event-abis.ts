/**
 * Minimal event ABIs for the tax-event indexer (ADR-020).
 *
 * Wave 3.5 contracts emit `Purchased` / `Redeemed` / `QueueClaimed` /
 * `YieldClaimed`. The indexer maps those four to the four ADR-020 categories
 * (`Acquisition`, `Disposition`, `Disposition`, `IncomeAccrual`) at write
 * time. Keeping this ABI list focused on events (not full contract surfaces)
 * minimises the topic-filter chunk fetch payload.
 *
 * `FeeEvent` is omitted — Wave 3.5 paymaster ops don't yet surface a per-
 * holder gas marker.
 */

export const subscriptionTaxAbi = [
  {
    type: 'event',
    name: 'Purchased',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'maxSharesHint', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Redeemed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'maxSharesHint', type: 'uint128', indexed: false },
      { name: 'escalated', type: 'bool', indexed: false },
    ],
  },
] as const;

export const redemptionQueueTaxAbi = [
  {
    type: 'event',
    name: 'QueueClaimed',
    inputs: [
      { name: 'investor', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
    ],
  },
] as const;

export const yieldSnapshotTaxAbi = [
  {
    type: 'event',
    name: 'YieldClaimed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
    ],
  },
] as const;

/**
 * Minimal `RedemptionQueue.token() → address` view used to resolve the
 * token address for a `QueueClaimed` event (the event itself doesn't carry
 * it). One `eth_call` per queue address is amortised across every
 * QueueClaimed in a poll window via in-memory cache.
 */
export const redemptionQueueTokenViewAbi = [
  {
    type: 'function',
    name: 'token',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export const oracleNavViewAbi = [
  {
    type: 'function',
    name: 'getNAV',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'nav', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
    ],
  },
] as const;
