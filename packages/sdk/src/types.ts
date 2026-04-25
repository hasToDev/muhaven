import type { Address, Hash, PublicClient } from 'viem'
import type { MuHavenSender } from './sender.js'

/**
 * Structural type for the `@cofhe/sdk` client (web or node build).
 *
 * Captures only the surface the SDK calls into, so we don't import a
 * WASM-linked module at the type level (keeps tsc fast + env-agnostic).
 * Intentionally narrow — typos on method names should fail to compile.
 */
export interface CofheLikeClient {
  encryptInputs(items: unknown[]): {
    onStep(cb: (step: string) => void): {
      execute(): Promise<unknown[]>
    }
    execute(): Promise<unknown[]>
  }
}

/**
 * Shape produced by `cofheClient.encryptInputs([...]).execute()` per item,
 * matching Solidity's `InEuint*` / `InEaddress` tuple:
 *
 *   tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
 */
export interface EncryptedInput {
  ctHash: bigint
  securityZone: number
  utype: number
  signature: `0x${string}`
}

export interface MuHavenAddresses {
  muhavenEscrow: Address
  yieldDistributor: Address
  investorRegistry: Address
  yieldGate: Address
}

/**
 * Shared construction context for Wave 3.5 clients. Every Wave 3.5 client
 * (`SubscriptionClient`, `TreasuryClient`, `RedemptionQueueClient`,
 * `YieldSnapshotClient`, `OracleClient`, `IdentityRegistryClient`) takes
 * this plus its own contract address. Consumers usually build one context
 * and hand it to every client, so reads and writes share one public + sender
 * + cofhe triple. Chain-mismatch validation is a consumer concern — check
 * `publicClient.getChainId()` / `sender.getChainId()` before issuing writes.
 */
export interface MuHavenClientContext {
  publicClient: PublicClient
  sender: MuHavenSender
  cofheClient: CofheLikeClient
}

export interface MuHavenClientConfig {
  publicClient: PublicClient
  /**
   * Pluggable transaction sender. For a standard viem `WalletClient`,
   * wrap with `walletClientToSender(walletClient)` (shipped from the SDK).
   * For ERC-4337 bundler-backed senders (e.g. ZeroDev passkey kernels),
   * consumers implement `MuHavenSender` against their bundler SDK.
   */
  sender: MuHavenSender
  /** Initialized cofhe client from `@cofhe/sdk/node` or `@cofhe/sdk/web`. */
  cofheClient: CofheLikeClient
  addresses: MuHavenAddresses
  /** Expected chainId. If set, reads on init and throws on mismatch. */
  expectedChainId?: number
  /** Default batch size for createYieldEscrows + fundEscrows (1..200). */
  defaultBatchSize?: number
}

export type ProgressStage =
  // Wave 3 yield-distribution pipeline
  | 'encrypt'
  | 'batchCreate'
  | 'setEscrowIds'
  | 'processBatch'
  | 'startDistribution'
  | 'redeem'
  | 'grantAdminDecrypt'
  // Wave 3.5 atomic-flow stages (see PRODUCTION_DESIGN/FLOWS.md)
  | 'purchase'
  | 'redeemInstant'
  | 'submitQueued'
  | 'claimQueued'
  | 'processEpoch'
  | 'cancelOnKYCRevocation'
  | 'openEpoch'
  | 'snapshotBatch'
  | 'finalizeSnapshot'
  | 'fundEpoch'
  | 'claimYield'
  | 'sweepExpired'
  | 'deposit'
  | 'withdraw'
  | 'setNAV'
  | 'acceptPendingNAV'
  | 'rejectPendingNAV'
  | 'requestNAV'
  | 'addWhitelisted'
  | 'setDevMode'
  // Wave 3.5 Phase 7.5 — MuHavenStable wrapper
  | 'wrap'
  | 'unwrap'
  | 'transfer'

export interface ProgressEvent {
  stage: ProgressStage
  current: number
  total: number
  message?: string
  txHash?: Hash
}

export type ProgressCallback = (event: ProgressEvent) => void

export interface CreateEscrowsResult {
  escrowIds: bigint[]
  txHashes: Hash[]
}

export interface FundEscrowsResult {
  distributionId: bigint
  batchesProcessed: number
  txHashes: Hash[]
}

export interface DistributeYieldResult {
  distributionId: bigint
  escrowIds: bigint[]
  createTxHashes: Hash[]
  fundTxHashes: Hash[]
}
