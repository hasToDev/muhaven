import type { Address, Hash, PublicClient, WalletClient } from 'viem'
import type {
  CofheLikeClient,
  MuHavenClientConfig,
  MuHavenAddresses,
  ProgressCallback,
  CreateEscrowsResult,
  FundEscrowsResult,
  DistributeYieldResult,
} from './types.js'
import { ConfigError, NetworkError } from './errors.js'
import { createYieldEscrowsFlow } from './escrows.js'
import {
  fundEscrowsFlow,
  startDistributionFlow,
  DistributionStatus,
} from './yield.js'
import { claimYieldFlow, claimYieldBatchFlow } from './claim.js'
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from './constants.js'

export { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE }

/**
 * MuHavenClient — orchestrates the two-phase yield distribution pipeline:
 *   1. SDK-side batch encryption + MuHavenEscrow.batchCreate (ZK-validated eaddress owners)
 *   2. YieldDistributor.processBatch loop that funds each escrow via fundFrom
 *
 * The client is wallet-agnostic: callers pass in viem PublicClient + WalletClient,
 * which can be backed by ZeroDev Kernel (passkey), MetaMask, TrustWallet,
 * WalletConnect, or a raw private key (for Node scripts).
 *
 * The CoFHE client is also caller-provided (from `@cofhe/sdk/web` in browser,
 * `@cofhe/sdk/node` in Node). This keeps the SDK free of WASM bindings.
 *
 * ### Quickstart (Node)
 *
 * ```ts
 * import { MuHavenClient } from '@muhaven/sdk'
 * import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node'
 * import { arbSepolia } from '@cofhe/sdk/chains'
 * import { createPublicClient, createWalletClient, http } from 'viem'
 * import { arbitrumSepolia } from 'viem/chains'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http() })
 * const walletClient = createWalletClient({
 *   account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
 *   chain: arbitrumSepolia,
 *   transport: http(),
 * })
 *
 * const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }))
 * await cofheClient.connect(publicClient, walletClient)
 *
 * const sdk = new MuHavenClient({
 *   publicClient, walletClient, cofheClient,
 *   addresses: { muhavenEscrow, yieldDistributor, investorRegistry, yieldGate },
 *   expectedChainId: 421614,
 * })
 *
 * await sdk.validateNetwork()
 * ```
 */
export class MuHavenClient {
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly cofheClient: CofheLikeClient
  readonly addresses: MuHavenAddresses
  readonly expectedChainId?: number
  readonly defaultBatchSize: number

  constructor(config: MuHavenClientConfig) {
    if (!config.publicClient) throw new ConfigError('publicClient is required')
    if (!config.walletClient) throw new ConfigError('walletClient is required')
    if (!config.cofheClient) throw new ConfigError('cofheClient is required')
    if (!config.addresses) throw new ConfigError('addresses is required')

    const required: (keyof MuHavenAddresses)[] = [
      'muhavenEscrow',
      'yieldDistributor',
      'investorRegistry',
      'yieldGate',
    ]
    for (const k of required) {
      if (!config.addresses[k]) throw new ConfigError(`addresses.${k} is required`)
    }

    this.publicClient = config.publicClient
    this.walletClient = config.walletClient
    this.cofheClient = config.cofheClient
    this.addresses = config.addresses
    this.expectedChainId = config.expectedChainId
    this.defaultBatchSize = config.defaultBatchSize ?? DEFAULT_BATCH_SIZE

    if (this.defaultBatchSize <= 0 || this.defaultBatchSize > MAX_BATCH_SIZE) {
      throw new ConfigError(
        `defaultBatchSize must be in (0, ${MAX_BATCH_SIZE}], got ${this.defaultBatchSize}`,
      )
    }
  }

  /** Read the connected wallet's address. */
  getAccount(): Address {
    const account = this.walletClient.account
    if (!account) throw new ConfigError('walletClient has no account')
    return account.address
  }

  /**
   * Validate public + wallet clients are on the expected chain.
   * Throws NetworkError on mismatch. No-op if expectedChainId is unset.
   */
  async validateNetwork(): Promise<void> {
    if (this.expectedChainId === undefined) return

    const pubChainId = await this.publicClient.getChainId()
    if (pubChainId !== this.expectedChainId) {
      throw new NetworkError(this.expectedChainId, pubChainId)
    }

    const walletChainId = await this.walletClient.getChainId()
    if (walletChainId !== this.expectedChainId) {
      throw new NetworkError(this.expectedChainId, walletChainId)
    }
  }

  // ── Core methods (implemented in later 19C subtasks) ────────────────

  /**
   * Create a yield escrow for every registered investor.
   *
   * Pipeline per batch:
   *   1. Batch-encrypt K investor addresses via CoFHE (shared ZK proof).
   *   2. Submit `MuHavenEscrow.batchCreate(owners, yieldGate, resolverData)`.
   *   3. Parse `EscrowCreated` events from the receipt to collect escrowIds.
   *
   * The returned `escrowIds` array preserves the order of the investor registry
   * (which is what YieldDistributor.setEscrowIds expects).
   */
  async createYieldEscrows(
    opts?: { batchSize?: number; onProgress?: ProgressCallback },
  ): Promise<CreateEscrowsResult> {
    const batchSize = opts?.batchSize ?? this.defaultBatchSize
    return createYieldEscrowsFlow({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      cofheClient: this.cofheClient,
      muhavenEscrow: this.addresses.muhavenEscrow,
      yieldGate: this.addresses.yieldGate,
      investorRegistry: this.addresses.investorRegistry,
      batchSize,
      onProgress: opts?.onProgress,
    })
  }

  /**
   * Attach `escrowIds` to a distribution and drive processBatch() until the
   * distribution completes. Each iteration funds up to `batchSize` escrows
   * via YieldDistributor → MuHavenEscrow.fundFrom.
   */
  async fundEscrows(
    distributionId: bigint,
    escrowIds: bigint[],
    opts?: { batchSize?: number; onProgress?: ProgressCallback },
  ): Promise<FundEscrowsResult> {
    const batchSize = opts?.batchSize ?? this.defaultBatchSize
    const { batchesProcessed, txHashes } = await fundEscrowsFlow({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      yieldDistributor: this.addresses.yieldDistributor,
      distributionId,
      escrowIds,
      batchSize,
      onProgress: opts?.onProgress,
    })
    return { distributionId, batchesProcessed, txHashes }
  }

  /** Redeem a single escrow. Called by investors from the claim UI. */
  async claimYield(
    escrowId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    return claimYieldFlow({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      muhavenEscrow: this.addresses.muhavenEscrow,
      escrowId,
      onProgress: opts?.onProgress,
    })
  }

  /**
   * Redeem up to MAX_BATCH_SIZE escrows in a single tx via redeemMultiple.
   * On-chain semantics: non-existent IDs are silently skipped.
   */
  async claimYieldBatch(
    escrowIds: bigint[],
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    return claimYieldBatchFlow({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      muhavenEscrow: this.addresses.muhavenEscrow,
      escrowIds,
      onProgress: opts?.onProgress,
    })
  }

  /**
   * Start a new distribution with the issuer's plaintext yield amount.
   * The amount is encrypted SDK-side before submission.
   *
   * **Pre-flight setup (caller responsibility):**
   *   - The issuer wallet must hold at least `totalYield` units of PUSDC.
   *   - The issuer must have granted YieldDistributor operator access via
   *     `pusdc.setOperator(yieldDistributor, expiry)`. Without this,
   *     YieldDistributor's `confidentialTransferFrom` pull call reverts.
   *   - The investor registry must be non-empty (contract rejects zero
   *     `investorCount` with `NoInvestors`).
   */
  async startDistribution(
    totalYield: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<{ distributionId: bigint; txHash: Hash }> {
    return startDistributionFlow({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      cofheClient: this.cofheClient,
      yieldDistributor: this.addresses.yieldDistributor,
      totalYield,
      onProgress: opts?.onProgress,
    })
  }

  /**
   * Full pipeline convenience: encrypt totalYield → startDistribution →
   * createYieldEscrows → fundEscrows. Calls progress callback at every stage.
   *
   * Use this when the caller just wants "distribute N PUSDC across all
   * registered investors" without managing distributionId bookkeeping.
   *
   * **Pre-flight setup (caller responsibility):** see `startDistribution`
   * JSDoc — the issuer must hold PUSDC and have set an operator approval
   * for YieldDistributor before invoking.
   */
  async distributeYield(
    totalYield: bigint,
    opts?: { batchSize?: number; onProgress?: ProgressCallback },
  ): Promise<DistributeYieldResult> {
    const { distributionId, txHash: startTx } = await this.startDistribution(
      totalYield,
      { onProgress: opts?.onProgress },
    )

    // startDistribution reverts on empty registry with NoInvestors — so by
    // here we always have escrowIds to create.
    const { escrowIds, txHashes: createTxHashes } = await this.createYieldEscrows({
      batchSize: opts?.batchSize,
      onProgress: opts?.onProgress,
    })

    const { txHashes: fundTxHashes } = await this.fundEscrows(
      distributionId,
      escrowIds,
      { batchSize: opts?.batchSize, onProgress: opts?.onProgress },
    )

    return {
      distributionId,
      escrowIds,
      createTxHashes: [startTx, ...createTxHashes],
      fundTxHashes,
    }
  }

  /** Re-exported for consumers that want to introspect distribution state. */
  static readonly DistributionStatus = DistributionStatus
}
