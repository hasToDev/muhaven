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
    // Phase 9.A audit-handle follow-up: broadened with `amount` (euint64
    // handle, bytes32) — the per-claim audit handle that bypasses the
    // cumulative `MuHavenStable._balances[investor]` chain-depth issue.
    type: 'event',
    name: 'YieldClaimed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
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
  // Wave 5 W3 Phase 9 — the single-step direct USDC→mhUSDC deposit
  // (`MuHavenStable.wrapUsdc`, which the CashPage "Convert to mhUSDC" now
  // uses) emits `WrapUsdc`, NOT `Wrap`. Without this ABI the deposit is
  // unindexed → no cash-rail `tax_events` row → the agent's
  // `hasCashRailActivity` gate falsely reports "you have no mhUSDC" on buy.
  // `from`/`ephemeralEOA` mirror Wrap's indexed addresses; `amount` is the
  // CLEARTEXT USDC (uint256, base-6) and `amountHandle` the encrypted mhUSDC
  // handle (euint64 → bytes32).
  {
    type: 'event',
    name: 'WrapUsdc',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'amountHandle', type: 'bytes32', indexed: false },
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
  {
    // Phase 9.A · Expansion (F1 follow-up). `TokenRegistry.setPaused`
    // emits `PausedUpdated(token, paused)` — fired by the F2 wizard
    // (registers tokens paused), the operator's `unpause-token.ts`
    // (flips paused=false post-NAV-publish), and any future
    // emergency-pause path. Subscribing keeps `rwa_tokens.status` in
    // sync without an operator-driven seed:tokens:v35 refresh.
    type: 'event',
    name: 'PausedUpdated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'paused', type: 'bool', indexed: false },
    ],
  },
] as const;

/**
 * Wave 5 — standard ERC-20 `Transfer(from, to, value)` for the GLOBAL Circle
 * USDC contract. Unlike `muHavenTokenTransferAbi` (whose `amount` is an
 * encrypted euint128 → bytes32), USDC's `value` is a CLEARTEXT `uint256` — the
 * indexer stores it verbatim in `metadata.cleartext_amount`. Used by the
 * `UsdcSend` leg, which topic-filters `from: [kernels]` so only our users'
 * outbound sends are fetched from the shared contract (not global volume).
 */
export const usdcTransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
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
