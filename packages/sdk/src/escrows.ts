import type { Address, Hash, PublicClient, WalletClient } from 'viem'
import type { CofheLikeClient, EncryptedInput, ProgressCallback } from './types.js'
import { BatchSizeExceededError, ConfigError, InvariantError } from './errors.js'
import { muhavenEscrowAbi } from './abi/muhavenEscrow.js'
import { investorRegistryAbi } from './abi/investorRegistry.js'
import { paginate } from './internal/batching.js'
import { encryptAddresses } from './internal/encryption.js'
import { encodeYieldGateResolverData } from './internal/encoding.js'
import { writeAndWait, parseEscrowCreatedIds } from './internal/contract.js'
import { MAX_BATCH_SIZE } from './constants.js'

/**
 * Fetch the full investor list from InvestorRegistry, paginated.
 * Reads `investorCount` once, then loops `getInvestorsPaginated(offset, size)`.
 */
export async function fetchAllInvestors(
  publicClient: PublicClient,
  registry: Address,
  pageSize = 100,
): Promise<Address[]> {
  const count = await publicClient.readContract({
    address: registry,
    abi: investorRegistryAbi,
    functionName: 'investorCount',
  })
  const total = Number(count)
  if (total === 0) return []

  const result: Address[] = []
  for (let offset = 0; offset < total; offset += pageSize) {
    const limit = Math.min(pageSize, total - offset)
    const page = await publicClient.readContract({
      address: registry,
      abi: investorRegistryAbi,
      functionName: 'getInvestorsPaginated',
      args: [BigInt(offset), BigInt(limit)],
    }) as readonly Address[]
    result.push(...page)
  }

  return result
}

/**
 * Encrypt a batch of investor addresses and submit a single `batchCreate`
 * call to MuHavenEscrow. Returns the escrowIds extracted from receipt logs
 * in the order they were created (matches investor order in the batch).
 */
export async function batchCreateEscrows(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  cofheClient: CofheLikeClient
  muhavenEscrow: Address
  yieldGate: Address
  investors: Address[]
}): Promise<{ escrowIds: bigint[]; txHash: Hash }> {
  const { publicClient, walletClient, cofheClient, muhavenEscrow, yieldGate, investors } = args
  if (investors.length === 0) throw new ConfigError('investors array is empty')
  if (investors.length > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError(investors.length, MAX_BATCH_SIZE)
  }

  // Encrypt all investor addresses in one ZK-proof batch.
  const encrypted: EncryptedInput[] = await encryptAddresses(cofheClient, investors)

  // Per-escrow resolverData: ABI-encoded plaintext beneficiary address.
  // NOTE: calldata is public, so this links escrowId ↔ investor at creation
  // time (documented trade-off in Phase 19B). The privacy gain is that
  // events + stored state emit only escrowId, so passive analysis via logs
  // alone does not reveal the mapping.
  const resolverData = investors.map(encodeYieldGateResolverData)

  // Shape encrypted inputs into the tuple viem expects for InEaddress[].
  const owners = encrypted.map(e => ({
    ctHash: e.ctHash,
    securityZone: e.securityZone,
    utype: e.utype,
    signature: e.signature,
  }))

  const { hash, logs } = await writeAndWait({
    publicClient,
    walletClient,
    address: muhavenEscrow,
    abi: muhavenEscrowAbi,
    functionName: 'batchCreate',
    args: [owners, yieldGate, resolverData],
    operation: 'MuHavenEscrow.batchCreate',
  })

  const escrowIds = parseEscrowCreatedIds(logs, muhavenEscrowAbi, muhavenEscrow)

  // Invariant: count of EscrowCreated events == investors.length.
  if (escrowIds.length !== investors.length) {
    throw new InvariantError(
      `MuHavenEscrow.batchCreate emitted ${escrowIds.length} EscrowCreated events for ${investors.length} inputs`,
    )
  }

  return { escrowIds, txHash: hash }
}

/**
 * Top-level orchestrator: read all investors, split into batches, encrypt
 * each batch, submit batchCreate, collect escrowIds.
 *
 * Returns escrowIds in the same order as the investors registry pagination.
 */
export async function createYieldEscrowsFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  cofheClient: CofheLikeClient
  muhavenEscrow: Address
  yieldGate: Address
  investorRegistry: Address
  batchSize: number
  onProgress?: ProgressCallback
}): Promise<{ escrowIds: bigint[]; txHashes: Hash[] }> {
  const {
    publicClient, walletClient, cofheClient,
    muhavenEscrow, yieldGate, investorRegistry,
    batchSize, onProgress,
  } = args

  if (batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError(batchSize, MAX_BATCH_SIZE)
  }

  const investors = await fetchAllInvestors(publicClient, investorRegistry)
  if (investors.length === 0) {
    return { escrowIds: [], txHashes: [] }
  }

  const batches = paginate(investors.length, batchSize)
  const escrowIds: bigint[] = []
  const txHashes: Hash[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    const slice = investors.slice(batch.offset, batch.offset + batch.size)

    onProgress?.({
      stage: 'encrypt',
      current: i,
      total: batches.length,
      message: `Encrypting batch ${i + 1}/${batches.length} (${slice.length} investors)`,
    })

    const { escrowIds: ids, txHash } = await batchCreateEscrows({
      publicClient, walletClient, cofheClient,
      muhavenEscrow, yieldGate,
      investors: slice,
    })

    escrowIds.push(...ids)
    txHashes.push(txHash)

    onProgress?.({
      stage: 'batchCreate',
      current: i + 1,
      total: batches.length,
      message: `Created ${ids.length} escrows (batch ${i + 1}/${batches.length})`,
      txHash,
    })
  }

  return { escrowIds, txHashes }
}
