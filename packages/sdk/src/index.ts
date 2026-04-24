// ── Wave 3 legacy (yield-distribution pipeline) ─────────────────────────
export { MuHavenClient, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from './client.js'
export { DistributionStatus } from './yield.js'
export { fetchAllInvestors } from './escrows.js'

// ── Sender / context plumbing ───────────────────────────────────────────
export { walletClientToSender } from './sender.js'
export type { MuHavenSender } from './sender.js'

// ── Shared types ────────────────────────────────────────────────────────
export type {
  MuHavenClientConfig,
  MuHavenAddresses,
  MuHavenClientContext,
  CofheLikeClient,
  EncryptedInput,
  ProgressCallback,
  ProgressEvent,
  ProgressStage,
  CreateEscrowsResult,
  FundEscrowsResult,
  DistributeYieldResult,
} from './types.js'

// ── Errors ──────────────────────────────────────────────────────────────
export {
  MuHavenError,
  ConfigError,
  NetworkError,
  EscrowNotFoundError,
  EncryptionError,
  BatchSizeExceededError,
  DistributionNotStartedError,
  DistributionAlreadyCompleteError,
  EscrowIdsAlreadySetError,
  TxFailedError,
  InvariantError,
} from './errors.js'

// ── Wave 3 ABIs ─────────────────────────────────────────────────────────
export { muhavenEscrowAbi } from './abi/muhavenEscrow.js'
export { yieldDistributorAbi } from './abi/yieldDistributor.js'
export { investorRegistryAbi } from './abi/investorRegistry.js'

// ── Wave 3.5 ABIs ───────────────────────────────────────────────────────
export { muhavenSubscriptionAbi } from './abi/subscription.js'
export { muhavenTreasuryAbi } from './abi/treasury.js'
export { redemptionQueueAbi } from './abi/redemptionQueue.js'
export { yieldSnapshotAbi } from './abi/yieldSnapshot.js'
export { priceOracleAbi } from './abi/oracle.js'
export { identityRegistryAbi } from './abi/identityRegistry.js'
export { tokenRegistryAbi } from './abi/tokenRegistry.js'

// ── Wave 3.5 clients ────────────────────────────────────────────────────
export { SubscriptionClient } from './clients/subscription.js'
export { TreasuryClient } from './clients/treasury.js'
export {
  RedemptionQueueClient,
  type QueueRequest,
} from './clients/redemptionQueue.js'
export {
  YieldSnapshotClient,
  type EpochView,
} from './clients/yieldSnapshot.js'
export { OracleClient } from './clients/oracle.js'
export { IdentityRegistryClient } from './clients/identityRegistry.js'
