# MuHaven SDK

> TypeScript SDK for orchestrating two-phase yield distribution on top of MuHavenEscrow + YieldDistributor.

---

## Overview

The MuHaven SDK (`@muhaven/sdk`) wraps the on-chain yield pipeline behind a single `MuHavenClient` class. It handles:

- **Batch FHE encryption** of investor addresses via `@cofhe/sdk` (one ZK proof per batch)
- **Paginated reads** of the `InvestorRegistry` on-chain
- **Two-phase escrow creation** — client-side ciphertext generation + contract-side handle storage
- **Distribution orchestration** — `startDistribution` → `createYieldEscrows` → `fundEscrows` → investor `redeem`
- **Pluggable sender pattern** — same API for EOA wallets (viem WalletClient) and smart accounts (ZeroDev kernel via UserOps)
- **Progress callbacks** for UI wiring

The SDK is consumed by:
- `frontend/src/services/` — issuer and investor flows in the Vue 3 app
- `backend/src/infrastructure/` — server-side distribution worker

**Package:** `@muhaven/sdk` · **Location:** `packages/sdk/` · **Version:** `0.1.0`

---

## Quickstart

### Install

```bash
pnpm add @muhaven/sdk viem
```

`@cofhe/sdk` is bundled as a regular dependency of `@muhaven/sdk` (pinned to `^0.4.0`). `viem` is a **peer dependency** — consumers bring their own version (`^2.47.0` or compatible) so the wallet client / public client shared with the SDK is the same instance used elsewhere in the app.

### Distribute yield (issuer)

```typescript
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { MuHavenClient, walletClientToSender } from '@muhaven/sdk';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: http(process.env.RPC_URL),
});

const cofheClient = createCofheClient(
  createCofheConfig({ supportedChains: [arbSepolia] })
);
await cofheClient.connect(publicClient, walletClient);
await cofheClient.permits.createSelf({ issuer: account.address });

const sdk = new MuHavenClient({
  publicClient,
  sender: walletClientToSender(walletClient),
  cofheClient,
  addresses: {
    muhavenEscrow:     '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A',
    yieldDistributor:  '0xD403252436e41EFd81D76eB9223485cB66cb1638',
    investorRegistry:  '0x9e19cFC63661AF1624ba16392dc02134F91d36f6',
    yieldGate:         '0x2cBAa54E5Ce4ED6D68722e35E18eba77B1c11964',
  },
  expectedChainId: 421614,
});

await sdk.validateNetwork();

// End-to-end distribution: start + batchCreate + fund
const result = await sdk.distributeYield(50_000_000n, {  // 50 PUSDC (6 decimals)
  batchSize: 50,
  onProgress: (ev) => console.log(ev.stage, ev.current, '/', ev.total),
});

console.log('distributionId:', result.distributionId);
console.log('escrowIds:',      result.escrowIds);
```

### Claim yield (investor)

```typescript
const txHash = await sdk.claimYield(escrowId, {
  onProgress: (ev) => console.log(ev.stage, ev.txHash),
});
```

Investor flows in the Vue frontend run the SDK through a ZeroDev smart-account sender so claims are gasless UserOps. See [Integration guide](#integration-guide) below.

---

## Architecture

### Two-phase escrow creation

MuHavenEscrow's privacy model relies on client/contract collaboration:

```
Client (SDK)                              Contract (MuHavenEscrow)
────────────                              ────────────────────────
fetchAllInvestors()  ──── InvestorRegistry.getAll() ───→
                         ←──── address[] ─────────────────

encryptInputs([addr1, addr2, ...])  ──→ @cofhe/sdk: one shared ZK proof
                                        returns InEaddress[] tuples

batchCreate(inputs, resolver, data)  ──→ FHE.asEaddress (validates ZK)
                                         FHE.allowThis  (grants contract ACL)
                                         resolver.onConditionSet (plaintext cache)
                                         emit EscrowCreated(id, resolver)
                                    ←─── receipt with sequential IDs

parse logs → escrowIds[] aligned to investor order
```

The plaintext beneficiary is encoded into `resolverData` so the YieldGate (the condition resolver) can cache the mapping off-chain. This is a deliberate trade-off: calldata observers can link escrowId → investor at creation time, but events and state emit only escrowId — passive log analysis cannot reconstruct the mapping from on-chain data alone. See [THREAT_MODEL.md](./THREAT_MODEL.md) for the full boundary.

### Pluggable sender

`MuHavenClient` does not bind to any specific wallet library. Writes go through a `MuHavenSender`:

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
|---------|----------|----------------|
| `walletClientToSender(walletClient)` | Node CLI, tests, EOA-backed flows | Wraps `viem` WalletClient.writeContract |
| `createZeroDevSender(kernelClient)` (in `frontend/src/providers/`) | Browser + smart-account + passkey | Submits UserOps through the ZeroDev bundler |

Both return a `MuHavenSender`. The same `MuHavenClient` drives both. This is what lets the issuer's distribute flow and the investor's claim flow share the SDK despite running in very different contexts.

### Distribution pipeline

Issuer-side orchestration (called by `distributeYield()` or composable piecewise):

```
startDistribution(totalYield)
  ├─ encrypt totalYield as InEuint64
  ├─ YieldDistributor.startDistribution(encryptedTotal)
  ├─ YieldDistributor pulls PUSDC from issuer (confidentialTransferFrom)
  └─ returns distributionId

createYieldEscrows({ batchSize })
  ├─ fetchAllInvestors() via InvestorRegistry pagination
  ├─ for each batch of batchSize addresses:
  │    ├─ encryptAddresses(batch)        (shared ZK proof)
  │    ├─ MuHavenEscrow.batchCreate(...) (one tx per batch)
  │    └─ parse EscrowCreated logs to extract sequential escrowIds
  ├─ YieldDistributor.setEscrowIds(distributionId, allIds)
  └─ returns escrowIds[]

fundEscrows(distributionId, escrowIds, { batchSize })
  └─ YieldDistributor.processBatch(distributionId, offset, count) in a loop
     └─ each call: computes per-investor share in FHE, fundFrom()s each escrow
```

Investor-side claim:

```
claimYield(escrowId)       → MuHavenEscrow.redeem(escrowId)
claimYieldBatch(escrowIds) → MuHavenEscrow.redeemMultiple(escrowIds)
```

Silent-fail note: `EscrowRedeemed` is emitted whether or not funds actually move. The backend block poller observes both the event and the PUSDC `ConfidentialTransfer` before marking the yield record as claimed. See [SMART_CONTRACTS.md § MuHavenEscrow](./SMART_CONTRACTS.md#muhavenescrow) for the silent-fail rationale.

---

## API reference

### `class MuHavenClient`

```typescript
constructor(config: MuHavenClientConfig)
```

**Config:**

```typescript
interface MuHavenClientConfig {
  publicClient: PublicClient;       // viem
  sender: MuHavenSender;            // pluggable
  cofheClient: CofheLikeClient;     // @cofhe/sdk client, already connected
  addresses: MuHavenAddresses;
  expectedChainId?: number;         // default: none
  defaultBatchSize?: number;        // default: 50
}

interface MuHavenAddresses {
  muhavenEscrow:     Address;
  yieldDistributor:  Address;
  investorRegistry:  Address;
  yieldGate:         Address;
}
```

All four addresses are required. Passing a non-contract address will cause reverts on first call — validate with `sdk.validateNetwork()` immediately after construction.

### Core methods

| Method | Purpose |
|--------|---------|
| `getAccount(): Address` | Returns the sender's address. |
| `validateNetwork(): Promise<void>` | Throws `NetworkError` if `publicClient.chainId` or `sender.getChainId()` don't match `expectedChainId`. |
| `startDistribution(totalYield, opts?)` | Encrypt totalYield, submit to YieldDistributor, pull PUSDC. Returns `{ distributionId, txHash }`. |
| `createYieldEscrows(opts?)` | Full batchCreate pipeline: fetch investors, encrypt, batch. Returns `{ escrowIds, txHashes }`. |
| `fundEscrows(distributionId, escrowIds, opts?)` | Loop processBatch until all escrows funded. Returns `{ txHashes }`. |
| `distributeYield(totalYield, opts?)` | Convenience: startDistribution → createYieldEscrows → fundEscrows in sequence. |
| `claimYield(escrowId, opts?)` | Investor calls `MuHavenEscrow.redeem`. Returns `Hash`. |
| `claimYieldBatch(escrowIds, opts?)` | Investor calls `MuHavenEscrow.redeemMultiple`. Returns `Hash`. |
| `grantAdminDecrypt(distributionId, viewer, opts?)` | Grants `viewer` permit-based `decryptForView` access to the distribution's encrypted totals. |

All write methods accept `opts?: { onProgress?: ProgressCallback; batchSize?: number }`.

### Types

```typescript
export type ProgressStage =
  | 'encrypt' | 'batchCreate' | 'setEscrowIds' | 'processBatch'
  | 'startDistribution' | 'redeem' | 'grantAdminDecrypt';

export interface ProgressEvent {
  stage: ProgressStage;
  current: number;
  total: number;
  message?: string;
  txHash?: `0x${string}`;
}

export type ProgressCallback = (event: ProgressEvent) => void;
```

### Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `DEFAULT_BATCH_SIZE` | `50` | Balance between ZK proof cost and tx gas |
| `MAX_BATCH_SIZE` | `200` | Hard cap. Practical ceiling on Arb Sepolia is lower — see [caveats](#caveats) |

### ABIs

Re-exported for convenience:

```typescript
import { muhavenEscrowAbi, yieldDistributorAbi, investorRegistryAbi } from '@muhaven/sdk';
```

### Utilities

```typescript
fetchAllInvestors(publicClient, registryAddress, pageSize?): Promise<Address[]>
```

Paginated read of `InvestorRegistry.getInvestors(offset, limit)`. Default page size 200. Used internally by `createYieldEscrows` but exported for custom pipelines.

### Errors

All SDK errors extend `MuHavenError`:

| Class | Thrown when |
|-------|-------------|
| `ConfigError` | Missing or invalid constructor config |
| `NetworkError` | `validateNetwork()` detects chainId mismatch |
| `EncryptionError` | `@cofhe/sdk` returns unexpected shape |
| `BatchSizeExceededError` | Caller passes `batchSize > MAX_BATCH_SIZE` |
| `EscrowNotFoundError` | On-chain read for escrow returns `exists == false` |
| `DistributionNotStartedError` | `fundEscrows` called before `startDistribution` |
| `DistributionAlreadyCompleteError` | `fundEscrows` called after all escrows processed |
| `EscrowIdsAlreadySetError` | `createYieldEscrows` re-entrance on a completed distribution |
| `TxFailedError` | Receipt status is `reverted` |
| `InvariantError` | Internal invariant broken — file an issue |

---

## Integration guide

### Frontend (Vue 3 + ZeroDev)

The frontend builds the SDK behind a singleton `getSdk()` in `frontend/src/services/sdk.ts`. The sender is the ZeroDev kernel client, so all writes are gasless UserOps authenticated by a WebAuthn passkey:

```typescript
// frontend/src/services/sdk.ts (simplified)
import { MuHavenClient } from '@muhaven/sdk';
import { createZeroDevSender } from '@/providers/zerodev/sender';

export async function getSdk() {
  const kernelClient = await walletStore.ensureConnected();
  const cofheClient  = await fheStore.ensureReady();
  return new MuHavenClient({
    publicClient,
    sender: createZeroDevSender(kernelClient),
    cofheClient,
    addresses,
    expectedChainId: 421614,
  });
}
```

Session keys (installed in `ZeroDevProvider.installSessionKey()`) let the kernel sign subsequent UserOps without a passkey prompt for the session duration — the SDK is unaware of this; it just calls `sender.write`.

### Node.js agent / backend

The backend distribution worker uses an EOA sender:

```typescript
import { walletClientToSender } from '@muhaven/sdk';

const sdk = new MuHavenClient({
  publicClient,
  sender: walletClientToSender(walletClient),
  cofheClient,
  addresses,
  expectedChainId: Number(process.env.CHAIN_ID),
});
```

All other calls are identical to the frontend — the sender is the only swap point.

### Piecewise vs end-to-end

`distributeYield()` is a convenience wrapper. For long-running issuer jobs where you want resumability, call the three stages separately and persist `distributionId` + `escrowIds` between stages:

```typescript
const { distributionId, txHash: startTx } = await sdk.startDistribution(totalYield);
await db.distributions.update(distributionId, { status: 'started', startTx });

const { escrowIds } = await sdk.createYieldEscrows({ onProgress: logProgress });
await db.distributions.update(distributionId, { status: 'created', escrowIds });

await sdk.fundEscrows(distributionId, escrowIds, { onProgress: logProgress });
await db.distributions.update(distributionId, { status: 'funded' });
```

If `fundEscrows` crashes mid-loop it can be safely re-run — `processBatch` tracks progress on-chain and skips already-funded escrows.

---

## Caveats

1. **Calldata linkage.** `batchCreate` embeds plaintext beneficiaries in `resolverData`. Observers reading calldata can link escrowId ↔ investor at creation time. Events and state emit only escrowId. This is a deliberate trade-off — the alternative (pure FHE beneficiary resolution) would require the YieldGate to decrypt on every claim, breaking gas-identical silent-fail.

2. **Silent-fail events.** `EscrowRedeemed` fires unconditionally on `redeem` / `redeemMultiple`, even when the encrypted owner check fails, the escrow is already redeemed, or the resolver denies. Pollers must verify actual PUSDC movement (or backend yield-record status) before trusting success.

3. **Batch size tuning.** `DEFAULT_BATCH_SIZE` is 50. Practical gas ceilings on Arb Sepolia (~30M block limit): ~50 for `batchCreate` (ZK validation ≈ 300–500k/escrow), ~20–30 for `redeemMultiple` (≈ 1M+/escrow with three FHE ops and a select). Callers exceeding ~100 will OOG before hitting the SDK's `BatchSizeExceededError`.

4. **Chain-id validation.** `validateNetwork()` is cheap and should run immediately after construction. Missing this and the SDK will happily send txs to the wrong chain.

5. **PUSDC euint64 selector mismatch.** MuHavenEscrow and YieldDistributor work around a `cofhe-contracts` v0.1.0 breaking change by using a low-level call with the legacy `uint256` selector when invoking PUSDC. This is transparent to SDK consumers but documented in `development/DEV_WAVE_3/PUSDC_TRANSFER_ISSUE.md` for reference.

---

## Testing

The SDK integration suite lives at the repo root and is driven by the main Hardhat config so it can share fixtures with the contract tests:

```bash
pnpm test test/MuHavenSdk.integration.test.ts
```

`packages/sdk/` itself only ships `build` / `dev` / `clean` / `typecheck` scripts — there is no `pnpm test` inside the package; all SDK tests run from the root.

25 test cases cover:
- Constructor + network validation
- Full `createYieldEscrows` pipeline including event log parsing
- `fundEscrows` batching + resume semantics
- Single + batch claim
- Distribution state machine (NOT_STARTED → IN_PROGRESS → COMPLETE)
- Admin decrypt grant

Tests run against the CoFHE mock environment (`@cofhe/mock-contracts`) — no live testnet needed.
