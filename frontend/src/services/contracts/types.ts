/**
 * Shared TypeScript types for contract services.
 */

/**
 * Encrypted input struct matching Solidity's InEuint128 / InEuint64.
 * Field names match @cofhe/sdk's EncryptedItemInput exactly — SDK output
 * can be passed directly to service functions without mapping.
 * `signature` is `string` (not `0x${string}`) to match the SDK default generic.
 */
export interface EncryptedInput {
  ctHash: bigint
  securityZone: number
  utype: number
  signature: string
}

/** Distribution status enum (mirrors Solidity DistributionStatus) */
export enum DistributionStatus {
  PENDING = 0,
  IN_PROGRESS = 1,
  COMPLETED = 2,
}

/** Distribution data returned by YieldDistributor.getDistribution() */
export interface Distribution {
  token: `0x${string}`
  encTotalYield: `0x${string}` // bytes32 handle
  encPerInvestorYield: `0x${string}` // bytes32 handle
  investorCount: bigint
  processedCount: bigint
  escrowsCreated: bigint
  status: DistributionStatus
}

/** Balance decrypt result */
export interface BalanceDecryptResult {
  result: bigint
  decrypted: boolean
}

/** Risk params decrypt result */
export interface RiskParamsDecryptResult {
  maxDrawdownBps: bigint
  minYieldBps: bigint
  driftToleranceBps: bigint
  maxDailySpend: bigint
  allDecrypted: boolean
}

/** Transaction hash */
export type TxHash = `0x${string}`
