# MuHaven SDK

> TypeScript SDK for the MuHaven contract pipeline — atomic Subscription, per-token Treasury, pluggable Oracle, RedemptionQueue, pull-based YieldSnapshot, ERC-3643 modular compliance, and the MuHavenStable confidential USDC wrapper.

---

## Overview

`@muhaven/sdk` (`packages/sdk/`) wraps the on-chain pipeline behind a small set of typed clients. Each client owns one contract surface; the consumer composes them as needed. The package ships:

- **Per-contract clients** — `SubscriptionClient`, `TreasuryClient`, `RedemptionQueueClient`, `YieldSnapshotClient`, `OracleClient`, `IdentityRegistryClient`, `StableClient`.
- **Pluggable sender pattern** — same API for EOA wallets (viem `WalletClient`) and ZeroDev kernel smart accounts (UserOps via `@zerodev/permissions` session keys).
- **Batch FHE encryption** via `@cofhe/sdk` — one ZK proof per call where the underlying contract accepts batched encrypted inputs.
- **Progress callbacks** for UI wiring.
- **Wave 3 legacy classes** preserved for the read-only Wave 3 deploy (`deployments/arb-sepolia.json`) — `MuHavenClient`, `DistributionStatus`, `fetchAllInvestors`. New code should target the per-contract clients above.

The SDK is consumed by:
- `frontend/src/services/v35/` — investor + issuer flows in the Vue 3 dashboard.
- `backend/src/infrastructure/` — server-side workers (NAV publisher, scripts).
- `scripts/` — root Hardhat scripts (`run-yield-epoch.ts`, `wrap-test-usdc.ts`, etc.).

**Package.** `@muhaven/sdk` · **Location.** `packages/sdk/` · **CoFHE.** `@cofhe/sdk` v0.5.1 (TFHE v1.5.3 in browser).

---

## Quickstart

### Install

```bash
pnpm add @muhaven/sdk viem
```

`@cofhe/sdk` ships as a regular dependency of `@muhaven/sdk` (pinned to `^0.5.1`). `viem` is a peer dependency — consumers bring their own version (`^2.47.0` or compatible) so the public client + wallet client shared with the SDK is the same instance the rest of the app uses.

### Investor — atomic purchase

```typescript
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { createCofheClient, createCofheConfig, Encryptable } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { SubscriptionClient, walletClientToSender } from '@muhaven/sdk';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http(process.env.RPC_URL) });

const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
await cofheClient.connect(publicClient, walletClient);
await cofheClient.permits.createSelf({ issuer: account.address });

const subscription = new SubscriptionClient({
  publicClient,
  sender: walletClientToSender(walletClient),
  cofheClient,
  address: '0x39D49B2614d24ba189B613bEAa903d829A73eA9e',  // MuHavenSubscription proxy (prod)
  expectedChainId: 421614,
});

// Atomic purchase: KYC → compliance → oracle → FHE.mul → mhUSDC pull → mint
const txHash = await subscription.purchase({
  token: TBILL1_TOKEN_ADDRESS,
  amount: 100_000_000n,           // 100 mhUSDC (6 decimals) — encrypted by the SDK
  maxSharesHint: 100n * 10n**18n, // cleartext upper bound for silent-fail gate
  ephemeralEOA: ephAccount.address, // session signer that gets FHE.allow on minted handles
});
```

### Investor — claim yield (pull-based)

```typescript
import { YieldSnapshotClient } from '@muhaven/sdk';

const snapshot = new YieldSnapshotClient({
  publicClient,
  sender: walletClientToSender(walletClient),
  cofheClient,
  address: '0xaC4163f84db2C85333D5aF6f87848d7362A59887',  // YieldSnapshot proxy (prod)
});

// Pull this investor's share for an epoch they held tokens at snapshot time.
// Idempotent — re-running on a claimed epoch reverts AlreadyClaimed.
const txHash = await snapshot.claimYield({
  token: TBILL1_TOKEN_ADDRESS,
  epochId: 3n,
  ephemeralEOA: ephAccount.address,
});
```

### Issuer — yield epoch (open → snapshot → finalize → fund)

```typescript
import { YieldSnapshotClient, RATE_SCALE } from '@muhaven/sdk';

const snapshot = new YieldSnapshotClient(...);

// 1. Open a new epoch
const { epochId } = await snapshot.openEpoch({ token: TBILL1_TOKEN_ADDRESS });

// 2. Paginated snapshot — captures balance + accumulates encTotalSupply
const holders = await fetchAllHoldersForToken(TBILL1_TOKEN_ADDRESS);
for (const batch of chunked(holders, 50)) {
  await snapshot.snapshotBatch({ epochId, investors: batch });
}

// 3. Lock the phase
await snapshot.finalizeSnapshot({ epochId });

// 4. Fund the epoch with mhUSDC + cleartext per-share rate
//    ratePerShare is fixed-point at RATE_SCALE = 1_000_000 (sub-1:1 yield support, ADR-048)
//    Conservation enforced off-chain: ratePerShare ≤ floor(totalYield / totalSupply)
const totalYield   = 50_000_000n;     // 50 mhUSDC
const ratePerShare = 200_000n;        // 0.0002 mhUSDC per share × RATE_SCALE
await snapshot.fundEpoch({ epochId, totalYield, ratePerShare });
```

For a complete end-to-end driver including auto-batching, see `scripts/run-yield-epoch.ts`.

---

## Architecture

### Atomic single-tx purchase

The Subscription contract folds the entire buy flow into one tx — no two-step exposure window, no plaintext intermediate state:

```
Investor → Subscription.purchase(token, encAmount, maxSharesHint, ephEOA)
              │
              ├─ MuHavenIdentityRegistry.isVerified(msg.sender)
              ├─ ModularCompliance.canTransfer(token, mint convention)
              │     └─ AND-aggregate: CountryAllow / MaxHolders / Lockup / MaxBalance / ...
              ├─ IPriceOracle.getNAV(token)  (deviation gate, sequencer uptime, freshness)
              ├─ FHE.mul(encAmount, NAV)  →  encShares128
              │     └─ silent-fail bound by FHE.select(encShares ≤ maxSharesHint, encShares, 0)
              ├─ MuHavenStable.transferFrom(investor, treasury, encAmount, ephEOA, addr0)
              │     └─ uses 5-arg overload (ADR-044) so only investor leg gets FHE.allow
              ├─ MuHavenToken.mintFromSubscription(investor, encShares, ephEOA)
              │     └─ FHE.allow(_balances[investor], ephEOA)  // permit grant
              ├─ ModularCompliance state hooks (created)
              └─ emit Purchased(token, investor, maxSharesHint, ephEOA, ...)
```

Silent-fail by design — observers cannot tell from gas / events whether the buy actually moved funds (e.g. insufficient mhUSDC, share-cap overflow, KYC revoked mid-flight).

### Pull-based per-epoch yield

Replaces Wave 3's push-model O(N) escrow creation with an O(1) issuer-side pipeline + investor-pull payout. Per-investor share is computed once at fund time via cleartext fixed-point `ratePerShare`, sidestepping the cofhe TN chain-length cap that bit the original `FHE.div(encYield, encTotalSupply)` model (see `docs/COFHE_TN_INDEXER_CHAIN_LENGTH_REPORT.md`).

```
Issuer
  ├─ openEpoch(token)                                   →  epochId, snapshotStartTs
  ├─ snapshotBatch(epochId, investors[]) (paginated)    →  per-holder snapshotBalance handle
  │   └─ accumulates encTotalSupply running sum         →  ADR-038 closes mid-snapshot drain vector
  ├─ finalizeSnapshot(epochId)                          →  locks the phase
  └─ fundEpoch(epochId, totalYield, ratePerShare)       →  mhUSDC pulled from issuer
                                                            ratePerShare stored cleartext (ADR-048)

Investor
  └─ claimYield(epochId, ephEOA)
      ├─ encShare128 = FHE.mul(snapshotBalance, FHE.asEuint128(ratePerShare))
      ├─ encShare64  = FHE.div(encShare128, FHE.asEuint128(RATE_SCALE))   // sub-1:1 yield rescale
      ├─ MuHavenStable.trustedPayout(snapshot, investor, encShare64, ephEOA)
      │   └─ ADR-046 fast-path — bypasses _silentFailBound (per-epoch conservation
      │       guarantees the snapshot's float covers every legitimate claim)
      └─ marks (epochId, investor) claimed (idempotent, AlreadyClaimed on re-claim)
```

The issuer sees aggregate epoch totals, not individual claims. `encTotalSupply` is grantable to the issuer (ADR-049) so they can see the SUM but not per-investor balances.

### Pluggable sender

Each client takes a `MuHavenSender`:

```typescript
export interface MuHavenSender {
  readonly address: Address;
  getChainId(): Promise<number>;
  write(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hash>;
}
```

Two built-in adapters:

| Adapter | Use case | Implementation |
|---|---|---|
| `walletClientToSender(walletClient)` | Node CLI, scripts, EOA-backed flows | viem `WalletClient.writeContract` |
| `createZeroDevSender(kernelClient)` (in `frontend/src/providers/zerodev/`) | Browser + smart account + passkey | UserOps through the ZeroDev bundler |

Both return a `MuHavenSender`. Every SDK client accepts the same shape — the same `SubscriptionClient` instance works in scripts and in the browser; the only swap point is the sender. Frontend writes are gasless UserOps signed by the active session key (no passkey prompt within the session).

---

## API reference

> Full source: [`packages/sdk/src/clients/`](../packages/sdk/src/clients/). The signatures below are the public surface; refer to the source for parameter defaults and progress-event types.

### `SubscriptionClient`

The atomic buy/redeem coordinator.

| Method | Purpose |
|---|---|
| `purchase({ token, amount, maxSharesHint, ephemeralEOA, onProgress? })` | Atomic single-tx purchase. Encrypts `amount` as `InEuint128` mhUSDC; computes shares via `FHE.mul`; silent-fails on `encShares > maxSharesHint`. Returns the tx hash. |
| `redeem({ token, encShares, maxSharesHint, ephemeralEOA, onProgress? })` | Instant redeem with auto-escalate to `RedemptionQueue` on per-epoch cleartext-cap overflow. Burns shares via `MuHavenToken.burnFromSubscription`, pays out mhUSDC via `MuHavenStable.transferFrom`. |
| `getCapInfo(token)` | Reads the current cleartext redemption cap remaining for the active epoch. |

### `YieldSnapshotClient`

Pull-based per-epoch yield distribution.

| Method | Purpose |
|---|---|
| `openEpoch({ token })` | Allocates a sequential `epochId` for `token`. Issuer-only. |
| `snapshotBatch({ epochId, investors, onProgress? })` | Idempotent per `(epochId, investor)`. Captures `MuHavenToken.snapshotBalance(holder)` and accumulates `encTotalSupply`. Skips zero-address entries. |
| `finalizeSnapshot({ epochId })` | Locks the snapshot phase. Reverts `EmptySnapshot` when `holderCount == 0`. |
| `fundEpoch({ epochId, totalYield, ratePerShare })` | Pulls `totalYield` mhUSDC from the issuer; stores cleartext `ratePerShare` (fixed-point at `RATE_SCALE`). Issuer-only. |
| `claimYield({ token, epochId, ephemeralEOA, onProgress? })` | Investor-pull. Idempotent (`AlreadyClaimed` revert on re-claim). Pay-out via `MuHavenStable.trustedPayout`. |
| `sweepExpired({ epochId })` | Returns unclaimed yield to the issuer after the epoch's `claimWindowEnd`. |
| `getEpochTotalSupplyHandle({ epochId })` | Returns `encTotalSupply` ciphertext handle (for issuer "Decrypt from chain" UX, ADR-049). |
| `refreshSnapshotSupplyGrant({ epochId, eph })` | Re-grants ACL on `encTotalSupply` to a freshly-rotated ephemeral EOA. ADR-050 (cross-session safety + ADR-009 pattern alignment). |
| `getEpoch({ epochId })` | Returns the epoch view (`EpochView` type) — `token`, `holderCount`, `totalYield`, `ratePerShare`, `funded`, `swept`, etc. |

### `RedemptionQueueClient`

Overflow redemption queue — Subscription auto-escalates here when the per-epoch cleartext cap is exceeded.

| Method | Purpose |
|---|---|
| `submit({ token, encShares, maxSharesHint, ephemeralEOA })` | Direct submission (rare — usually called via `Subscription.redeem` cap-overflow branch). |
| `processEpoch({ token, epochId, navAtSettlement })` | Issuer-driven settlement at the published NAV. Burns queue-held shares via `burnFromQueue`. |
| `claim({ requestId })` | Investor-pull post-settlement. Pay-out from treasury. |
| `cancelOnKYCRevocation({ requestId })` | Issuer-only. Returns shares when the investor's KYC is revoked mid-queue (ADR-027). |
| `getRequest({ requestId })` | Returns a `QueueRequest` view. |

### `OracleClient`

Pluggable price oracle wrapper. Reads work against any `IPriceOracle` impl; writes target the configured oracle (issuer-controlled or Chainlink-backed) per-token.

| Method | Purpose |
|---|---|
| `getNAV({ token })` | Reads the current NAV. Reverts `StaleNAV` if past staleness window or `SequencerDown` if the L2 sequencer feed reports down. |
| `isFresh({ token })` | Boolean predicate — true if NAV is fresh AND sequencer is up + outside grace window. |
| `setNAV({ token, value })` | Writes a new NAV. Issuer-only, gated by per-token `maxDeviationBps` deviation gate; over-threshold writes park in pending state. |
| `acceptPendingNAV({ token })`, `rejectPendingNAV({ token })` | Owner-only resolution of a parked NAV. |

### `TreasuryClient`

Per-token mhUSDC custody. Operator approvals to Subscription + Queue are immutable (granted at init).

| Method | Purpose |
|---|---|
| `getMinFloat({ token })` | Reads cleartext solvency-floor target. |
| `setMinFloat({ token, value })` | Issuer-only update. |
| `withdraw({ token, encAmount, recipient })` | Silent-fail on solvency-floor breach via `FHE.select` (ADR-029). |

### `IdentityRegistryClient`

ERC-3643 identity registry surface for off-chain checks (the Subscription contract reads on-chain directly).

| Method | Purpose |
|---|---|
| `isVerified({ account })` | Boolean — runs whitelist → claim verification (topics × trusted issuers × `validUntil`). |
| `addToWhitelist({ account })`, `removeFromWhitelist({ account })` | Issuer-only convenience. |
| `getDevMode()` | Boolean — true while migration mode is active; flipping to false is irreversible. |

### `StableClient`

mhUSDC wrapper.

| Method | Purpose |
|---|---|
| `wrap({ amount })` | USDC → mhUSDC (cleartext in, encrypted out). |
| `unwrap({ encAmount, ephemeralEOA })` | mhUSDC → USDC. |
| `confidentialTransferFrom({ from, to, encAmount, fromEph, toEph })` | 5-arg overload (ADR-044). Pass `address(0)` for the leg that should NOT receive the counterparty `FHE.allow` grant. |
| `getBalanceHandle({ account })` | Returns ciphertext handle for `decryptForView`. |

### Constants

| Constant | Value | Notes |
|---|---|---|
| `RATE_SCALE` | `1_000_000n` | Fixed-point scale on `Epoch.ratePerShare` (ADR-048 sub-1:1 yield support). |
| `DEFAULT_BATCH_SIZE` | `50` | Wave 3 legacy `MuHavenClient` default batch size. |
| `MAX_BATCH_SIZE` | `200` | Hard cap on Wave 3 legacy batches; practical Arb Sepolia ceiling is lower (gas). |

### Errors

All SDK errors extend `MuHavenError`:

| Class | Thrown when |
|---|---|
| `ConfigError` | Missing or invalid constructor config |
| `NetworkError` | Chain-id mismatch — call `client.getChainId()` after construction |
| `EncryptionError` | `@cofhe/sdk` returns unexpected shape from `encryptInputs` |
| `BatchSizeExceededError` | Caller exceeds `MAX_BATCH_SIZE` (Wave 3 legacy) |
| `TxFailedError` | Receipt status `reverted` |
| `InvariantError` | Internal invariant broken — file an issue |

Plus contract-revert names surfaced verbatim in the tx receipt: `AlreadyClaimed`, `EmptySnapshot`, `StaleNAV`, `SequencerDown`, `BelowMinInvestment`, `CostOverflowsPUSDCWidth`, `NotTrustedPayer`, `BelowMinFloat`, etc.

---

## Integration guide

### Frontend (Vue 3 + ZeroDev)

The frontend builds clients behind singletons in `frontend/src/services/v35/`. The sender is the ZeroDev kernel client, so all writes are gasless UserOps authenticated by a WebAuthn passkey + scoped session key:

```typescript
// frontend/src/services/v35/SubscriptionService.ts (simplified)
import { SubscriptionClient } from '@muhaven/sdk';
import { createZeroDevSender } from '@/providers/zerodev/sender';

export async function getSubscription() {
  const kernelClient = await walletStore.ensureConnected();
  const cofheClient  = await fheStore.ensureReady();
  return new SubscriptionClient({
    publicClient,
    sender: createZeroDevSender(kernelClient),
    cofheClient,
    address: addresses.muhavenSubscription,
    expectedChainId: 421614,
  });
}
```

After the first passkey sign-in, `frontend/src/providers/zerodev/session-key.ts` installs a `@zerodev/permissions` validator scoped to the MuHaven contract set — subsequent SDK writes are signed locally with no passkey prompt for the session duration.

The ephemeral-EOA pattern (ADR-021) is wired in `frontend/src/composables/useFhe.ts` — the `eph` is generated in-memory at first-write-op and threaded into every contract call that produces investor-decryptable state.

### Backend / Node scripts

The backend NAV publisher and root Hardhat scripts use an EOA sender:

```typescript
import { walletClientToSender, OracleClient } from '@muhaven/sdk';

const oracle = new OracleClient({
  publicClient,
  sender: walletClientToSender(walletClient),
  cofheClient,
  address: addresses.issuerControlledOracle,
});

await oracle.setNAV({ token: TBILL1, value: navFromFRED });
```

All other calls are identical to the frontend — the sender is the only swap point.

### Piecewise vs end-to-end

Yield epochs are intentionally piecewise — each phase persists state on-chain so a crashed snapshot cron can be safely re-run. The reference driver `scripts/run-yield-epoch.ts` shows the full sequence with idempotent retries:

```typescript
const { epochId } = await snapshot.openEpoch({ token });
await db.epochs.create({ epochId, status: 'opened' });

for (const batch of chunked(holders, 50)) {
  await snapshot.snapshotBatch({ epochId, investors: batch });   // idempotent per (epoch, investor)
}
await db.epochs.update(epochId, { status: 'snapshotted' });

await snapshot.finalizeSnapshot({ epochId });
await snapshot.fundEpoch({ epochId, totalYield, ratePerShare });
await db.epochs.update(epochId, { status: 'funded' });
```

Investors then pull `claimYield(epochId, eph)` on their own schedule.

---

## Caveats

1. **Cleartext `ratePerShare`.** Stored on-chain in the clear. By design — RWA per-share rates are conventionally published off-chain (TBILL APY, dividend rate). Per-investor balances + per-claim shares stay encrypted. Conservation must be enforced off-chain by the issuer (`ratePerShare ≤ floor(totalYield / totalSupply)`). A dishonest issuer can short-pay the snapshot, but the next claim transaction reverts on insufficient mhUSDC float — observable to investors.

2. **`maxSharesHint` is cleartext.** The investor-supplied upper bound on shares is used by the silent-fail gate (`FHE.select(encShares ≤ hint, encShares, 0)`) and as the cap-tracker tick (ADR-019). It leaks one bit per purchase about the order-size band. Documented trade-off.

3. **Silent-fail events.** `Purchased` / `Redeemed` / `EpochClaimed` / `EscrowRedeemed` (legacy) all emit unconditionally. Off-chain pollers must verify the corresponding mhUSDC `ConfidentialTransfer` event (or the backend's record status) before treating success as confirmed. The block poller in `backend/src/infrastructure/event-poller` already does this.

4. **Sub-1:1 yields require `RATE_SCALE` rescale.** When per-share yield is less than 1 mhUSDC unit (e.g. 4% APY on $25 supply → $1 yield), `ratePerShare` must be supplied as `floor(yieldPerShare × RATE_SCALE)`. The contract's `claimYield` does the matching `FHE.div` rescale. If you stored a pre-RATE_SCALE epoch on-chain, `scripts/upgrade-yield-snapshot.ts` enumerates every funded-not-swept epoch and aborts if any has unscaled `0 < ratePerShare < RATE_SCALE` — operator override `MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1`.

5. **Ephemeral-EOA permit lifecycle.** Every mutation that produces investor-decryptable state needs `FHE.allow(handle, ephEOA)`. Re-running `claimYield` for an already-claimed epoch reverts `AlreadyClaimed` — but if the investor's session ephEOA rotated mid-flight, the old snapshot's `encTotalSupply` ACL grants stale. `YieldSnapshotClient.refreshSnapshotSupplyGrant` (ADR-050) is the recovery path; the frontend already wires this in the issuer's `/distribute` decrypt button.

6. **PUSDC selector shim.** `MuHavenStable` shims the legacy ReineiraOS PUSDC `confidentialTransferFrom(address,address,uint256)` selector for any path that touches PUSDC directly (rare in current code — most flows go through mhUSDC). Documented at `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md`.

7. **`MuHavenStable._trustedPayer` mapping.** `YieldSnapshot.claimYield` calls `MuHavenStable.trustedPayout(...)` (ADR-046 fast-path). The snapshot proxy must be in the wrapper's `_trustedPayer` mapping or every claim reverts `NotTrustedPayer` (`0x3e9d3e1e`). `scripts/deploy-v2.ts` folds this grant into the platform deploy as of Phase 10 (DEV_LOG 2026-05-04). Recovery: `scripts/grant-trusted-payer.ts` (idempotent).

---

## Testing

The SDK integration suite lives at the repo root and shares Hardhat fixtures with the contract tests:

```bash
pnpm test test/MuHavenSdk.integration.test.ts          # 25 cases — Wave 3 legacy pipeline
pnpm test test/MuHavenSdkV2.integration.test.ts        # Wave 3.5 atomic Subscription + pull yield
pnpm test test/MuHavenStable.integration.test.ts       # mhUSDC wrap / unwrap / trustedPayout
```

`packages/sdk/` itself only ships `build` / `dev` / `clean` / `typecheck` scripts — there is no `pnpm test` inside the package. All SDK tests run from the root.

Coverage spans:

- Constructor + chain-id validation per client
- Atomic `purchase` happy path + KYC-revoked / cap-overflow / stale-NAV silent-fail branches
- Pull-based yield: `openEpoch` → `snapshotBatch` (idempotent) → `finalizeSnapshot` → `fundEpoch` → `claimYield` (idempotent)
- Cleartext-`ratePerShare` × `RATE_SCALE` sub-1:1 yield rescale (ADR-048)
- Issuer ACL grant on `encTotalSupply` + `refreshSnapshotSupplyGrant` cross-session refresh (ADR-049, ADR-050)
- Auto-escalate to RedemptionQueue on cap overflow + queue settlement + `cancelOnKYCRevocation`
- mhUSDC `trustedPayout` ACL + `_trustedPayer` mapping enforcement
- Oracle deviation gate (within / over / accept / reject) + sequencer-uptime feed (down / grace window / unconfigured passthrough)

Tests run against the CoFHE mock environment (`@cofhe/mock-contracts`) — no live testnet needed.
