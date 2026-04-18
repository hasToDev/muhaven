import type { Address, Hash, PublicClient, WalletClient } from 'viem'

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

export interface MuHavenClientConfig {
  publicClient: PublicClient
  walletClient: WalletClient
  /** Initialized cofhe client from `@cofhe/sdk/node` or `@cofhe/sdk/web`. */
  cofheClient: CofheLikeClient
  addresses: MuHavenAddresses
  /** Expected chainId. If set, reads on init and throws on mismatch. */
  expectedChainId?: number
  /** Default batch size for createYieldEscrows + fundEscrows (1..200). */
  defaultBatchSize?: number
}

export type ProgressStage =
  | 'encrypt'
  | 'batchCreate'
  | 'setEscrowIds'
  | 'processBatch'
  | 'startDistribution'
  | 'redeem'

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
