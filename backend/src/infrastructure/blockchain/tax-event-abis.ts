/**
 * Minimal event ABIs for the tax-event indexer (ADR-020).
 *
 * Wave 3.5 contracts emit `Purchased` / `Redeemed` / `QueueClaimed` /
 * `YieldClaimed`. The indexer maps those four to the four ADR-020 categories
 * (`Acquisition`, `Disposition`, `Disposition`, `IncomeAccrual`) at write
 * time. Keeping this ABI list focused on events (not full contract surfaces)
 * minimises the topic-filter chunk fetch payload.
 *
 * Phase 9.A · Option Z (2026-05-XX) extends the indexer with
 * `MuHavenStable.Wrap` / `MuHavenStable.Unwrap` — the post-upgrade events
 * carry an encrypted `amount` handle (`euint64` → `bytes32`) so investors
 * can decrypt the cash-conversion amount via permit on the activity feed.
 * The handle is stored verbatim in `tax_events.metadata.encrypted_amount_handle`.
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

/**
 * Phase 9.A · Option Z — `MuHavenStable.Wrap` / `Unwrap` event ABIs.
 * `euint64 amount` compiles to `bytes32` per cofhe-contracts v0.1.3
 * (verified against `artifacts/.../MuHavenStable.json`). Pre-upgrade
 * (legacy 2-arg) wraps remain on-chain under a different topic0 and are
 * intentionally invisible to this indexer — only post-upgrade events
 * match the topic filter below.
 */
export const muHavenStableWrapAbi = [
  {
    type: 'event',
    name: 'Wrap',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Unwrap',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
    ],
  },
] as const;

/**
 * Phase 9.A · Option Z follow-up — `MuHavenToken.Transfer(from, to, amount)`
 * event ABI for the broadened Wave 3.5 fhERC-20 transfer event. `euint128
 * amount` compiles to `bytes32`. The indexer fetches Transfer logs from
 * each per-RWA MuHavenToken proxy and filters at insert time:
 *   - mints (`from == 0`) — already covered by Subscription.Purchased
 *   - burns (`to == 0`) — already covered by Subscription.Redeemed +
 *     RedemptionQueue.QueueClaimed
 *   - protocol-mediated moves (sender or recipient in the platform's
 *     filter set: subscription / queues / treasuries) — already
 *     covered upstream
 * Whatever survives is a true P2P transfer; the indexer inserts TWO
 * `tax_events` rows per kept event (one keyed by sender, one by
 * recipient) so `findByHolder` returns the right perspective for
 * either party's /activity feed.
 */
export const muHavenTokenTransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
    ],
  },
] as const;

/**
 * Phase 9.A · Expansion (F1) — `TokenRegistry.IssuerUpdated(token,
 * oldIssuer, newIssuer)` event ABI. Fired by `TokenRegistry.setIssuer`
 * whenever the on-chain owner rotates the per-token issuer (see
 * `contracts/TokenRegistry.sol:123` + the `transfer-issuer.ts` operator
 * script). The indexer dispatches this into `TokenRegistryHandler` so
 * `rwa_tokens.issuer_address` rolls forward without an operator running
 * `pnpm seed:sync-issuers`.
 *
 * The event is intentionally NOT mapped into `tax_events` — issuer
 * rotation is a registry-config change, not a holder-keyed taxable
 * marker (ADR-020). Adding a sixth `getLogs` task to the indexer is the
 * minimum viable production-trajectory subscription; expand the array
 * when more `TokenRegistry` events need backend mirroring.
 */
export const tokenRegistryEventsAbi = [
  {
    type: 'event',
    name: 'IssuerUpdated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'oldIssuer', type: 'address', indexed: true },
      { name: 'newIssuer', type: 'address', indexed: true },
    ],
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
