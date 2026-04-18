# @muhaven/sdk

TypeScript SDK for orchestrating the MuHaven confidential yield-distribution
pipeline. Wraps `MuHavenEscrow` + `YieldDistributor` + `InvestorRegistry` in a
single `MuHavenClient` that handles:

- Batch FHE address encryption (single ZK proof per batch)
- Two-phase escrow creation (`batchCreate` ZK-validated + `fundFrom` accumulator)
- Full distribution lifecycle (`startDistribution` → create → fund → redeem)
- Event-log parsing for escrowIds + distributionIds
- Progress callbacks at every stage

Environment-agnostic: works in Node scripts and in the browser. Accepts any
viem `WalletClient` (ZeroDev Kernel / passkey, MetaMask, TrustWallet,
WalletConnect, or raw `privateKeyToAccount`).

## Install

Within the MuHaven monorepo, the SDK is wired as a workspace package. In
external consumers:

```bash
pnpm add @muhaven/sdk viem @cofhe/sdk
```

## Quickstart — Node

```ts
import { MuHavenClient } from '@muhaven/sdk'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node'
import { arbSepolia } from '@cofhe/sdk/chains'
import { createPublicClient, createWalletClient, http } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http() })
const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chain: arbitrumSepolia,
  transport: http(),
})

const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }))
await cofheClient.connect(publicClient, walletClient)

const sdk = new MuHavenClient({
  publicClient, walletClient, cofheClient,
  addresses: {
    muhavenEscrow: '0x...',
    yieldDistributor: '0x...',
    investorRegistry: '0x...',
    yieldGate: '0x...',
  },
  expectedChainId: 421614,
})

await sdk.validateNetwork()

// High-level: distribute 10,000 PUSDC across all registered investors.
const result = await sdk.distributeYield(10_000_000_000n, {
  batchSize: 50,
  onProgress: (e) => console.log(`[${e.stage}] ${e.current}/${e.total} ${e.message ?? ''}`),
})

console.log(`Distribution ${result.distributionId} complete`)
console.log(`Created ${result.escrowIds.length} escrows`)
```

## Quickstart — Browser (ZeroDev passkey)

```ts
import { MuHavenClient } from '@muhaven/sdk'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web'
import { arbSepolia } from '@cofhe/sdk/chains'

// Bring your own viem clients from the wallet provider (ZeroDev / MetaMask / etc.)
const { publicClient, walletClient } = wallet.getViemClients()

const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }))
await cofheClient.connect(publicClient, walletClient)

const sdk = new MuHavenClient({
  publicClient, walletClient, cofheClient,
  addresses: contracts.addresses,
})

// Investor claims all pending yields.
const txHash = await sdk.claimYieldBatch([1n, 5n, 12n])
```

## API

### `new MuHavenClient(config)`

Constructs a client. Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `publicClient` | ✓ | viem `PublicClient` for reads |
| `walletClient` | ✓ | viem `WalletClient` for writes (has `account`) |
| `cofheClient` | ✓ | Connected `@cofhe/sdk` client |
| `addresses` | ✓ | `{ muhavenEscrow, yieldDistributor, investorRegistry, yieldGate }` |
| `expectedChainId` | | If set, `validateNetwork()` throws on mismatch |
| `defaultBatchSize` | | Batch size for create / fund loops. Default `50`, max `200` |

### `sdk.distributeYield(totalYield, opts?)` — High-level pipeline

Encrypts `totalYield` → `startDistribution` → `createYieldEscrows` →
`fundEscrows`. Single call for issuer flows.

### `sdk.createYieldEscrows(opts?)`

Reads all investors from the registry, batch-encrypts addresses, submits
`MuHavenEscrow.batchCreate`, parses `EscrowCreated` logs to return `escrowIds`
in registry order.

### `sdk.fundEscrows(distributionId, escrowIds, opts?)`

Attaches `escrowIds` to the distribution via `setEscrowIds`, then loops
`processBatch` until the distribution completes.

### `sdk.claimYield(escrowId)` / `sdk.claimYieldBatch(escrowIds)`

Investor-side redemption. Single or batched.

> **Silent-fail contract:** `MuHavenEscrow` emits `EscrowRedeemed` regardless of
> whether the encrypted canRedeem gate passed. Callers must verify the
> resulting encrypted `isRedeemed` flag or observe PUSDC balance movement
> before treating a claim as successful. See `MuHavenEscrow.redeem` NatSpec
> for the threat model.

### `sdk.startDistribution(totalYield, opts?)`

Lower-level: encrypts `totalYield` and submits `startDistribution` only.
Returns the new `distributionId`.

### Progress events

All orchestrating methods accept `opts.onProgress`. Events carry
`{ stage, current, total, message?, txHash? }` where `stage` is one of
`'encrypt' | 'startDistribution' | 'batchCreate' | 'setEscrowIds' |
'processBatch' | 'redeem'`.

## Error types

All errors extend `MuHavenError`:

- `ConfigError` — invalid constructor arguments
- `NetworkError` — chainId mismatch on `validateNetwork()`
- `EscrowNotFoundError` — escrowId does not exist
- `EncryptionError` — CoFHE encryption failed
- `BatchSizeExceededError` — batch > `MAX_BATCH_SIZE` (200)
- `DistributionNotStartedError` — distribution does not exist
- `DistributionAlreadyCompleteError` — distribution already funded
- `EscrowIdsAlreadySetError` — `setEscrowIds` already called
- `TxFailedError` — on-chain tx reverted or receipt failed

## ABIs

The SDK re-exports minimal ABI fragments for convenience:

```ts
import { muhavenEscrowAbi, yieldDistributorAbi, investorRegistryAbi } from '@muhaven/sdk'
```

## Build

```bash
pnpm build        # dual ESM + CJS via tsup
pnpm dev          # watch mode
pnpm typecheck    # tsc --noEmit
```

Output: `dist/index.{js,cjs,d.ts,d.cts}`.

## Tests

SDK integration tests live in the monorepo root: `test/MuHavenSdk.integration.test.ts`.
Run from the repo root:

```bash
pnpm test test/MuHavenSdk.integration.test.ts
```

22 tests cover: constructor validation, `createYieldEscrows` (batching, progress,
empty registry), `startDistribution`, `fundEscrows` (length mismatch, already
set, unknown distribution), claim flows, `distributeYield` end-to-end, and
`DistributionStatus` enum parity.

## Versioning

`0.1.0` — initial release, shipped with MuHaven Wave 3 (Phase 19C).
Internal/workspace package — not published to npm during hackathon.
