/**
 * Contract services barrel export.
 *
 * Usage:
 *   import * as TokenService from '@/services/contracts/TokenService'
 *   import * as VaultService from '@/services/contracts/VaultService'
 *   // or
 *   import { TokenService, VaultService } from '@/services/contracts'
 */

export * as TokenService from './TokenService'
export * as VaultService from './VaultService'
export * as RegistryService from './RegistryService'
export * as YieldService from './YieldService'
export * as KYCService from './KYCService'
export * as RiskService from './RiskService'
export * as Erc20Service from './Erc20Service'

// Re-export types and errors for convenience
export type {
  EncryptedInput,
  Distribution,
  YieldDecryptResult,
  BalanceDecryptResult,
  RiskParamsDecryptResult,
  TxHash,
} from './types'
export { DistributionStatus } from './types'
export {
  ContractError,
  ContractReadError,
  UserOpError,
  WalletNotConnectedError,
  DecryptPendingError,
} from './errors'
