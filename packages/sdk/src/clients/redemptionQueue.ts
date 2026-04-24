import type { Address, Hash } from 'viem'
import { parseEventLogs } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError, InvariantError } from '../errors.js'
import { redemptionQueueAbi } from '../abi/redemptionQueue.js'
import { writeAndWait } from '../internal/contract.js'
import { encryptUint128 } from '../internal/encryption.js'
import { paginate } from '../internal/batching.js'
import { requireContext, requireEphemeralEOA } from './_context.js'

/**
 * Queue request shape returned by `getRequest`. The encrypted handles are
 * typed as `bytes32` (cofhe-contracts encodes `euint128` as a stored
 * 32-byte hash); decryption requires a permit via `ephemeralEOA`.
 */
export interface QueueRequest {
  investor: Address
  encShares: `0x${string}`
  encProceeds: `0x${string}`
  epochId: bigint
  ephemeralEOA: Address
  maxSharesHint: bigint
  settled: boolean
  claimed: boolean
  cancelled: boolean
}

/**
 * Wave 3.5 queued-redemption client — one `RedemptionQueue` per token.
 *
 * The `submitFor` trusted-caller entry is deliberately NOT exposed:
 * `MuHavenSubscription.redeem` is the only legitimate caller. Consumers that
 * need to redeem shares call `SubscriptionClient.redeem` and let the contract
 * escalate on cap overflow, or call `submit` directly for explicit queued
 * redemptions.
 */
export class RedemptionQueueClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'redemptionQueue', address })
    this.ctx = context
    this.address = address
  }

  /**
   * Submit shares directly to the queue (bypassing Subscription). The queue
   * pulls shares via `MuHavenToken.pullFromInvestor` at submit time and
   * silent-fail bounds the stored handle to the actually-pulled amount per
   * ADR-036.
   *
   * @returns `requestId` parsed from the emitted `QueueSubmitted` event.
   */
  async submit(
    shares: bigint,
    maxSharesHint: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<{ requestId: bigint; txHash: Hash }> {
    if (shares <= 0n) throw new ConfigError(`shares must be > 0, got ${shares}`)
    if (maxSharesHint <= 0n) throw new ConfigError(`maxSharesHint must be > 0, got ${maxSharesHint}`)
    if (shares > maxSharesHint) {
      throw new ConfigError(
        `shares (${shares}) > maxSharesHint (${maxSharesHint}); on-chain submit would silent-fail`,
      )
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting queued-redeem share amount',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, shares)

    const { hash, logs } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'submit',
      args: [
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        maxSharesHint,
        ephemeralEOA,
      ],
      operation: 'RedemptionQueue.submit',
    })

    const events = parseEventLogs({
      abi: redemptionQueueAbi as any,
      eventName: 'QueueSubmitted',
      logs,
    })
    const match = events.find(
      log => log.address.toLowerCase() === this.address.toLowerCase(),
    )
    if (!match) {
      throw new InvariantError('RedemptionQueue.submit emitted no QueueSubmitted event')
    }
    const requestId = (match as unknown as { args: { requestId: bigint } }).args.requestId

    opts?.onProgress?.({
      stage: 'submitQueued',
      current: 1,
      total: 1,
      message: `Queue request ${requestId} submitted`,
      txHash: hash,
    })

    return { requestId, txHash: hash }
  }

  /** Claim a settled request. Silent-fails on treasury insolvency. */
  async claim(
    requestId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'claim',
      args: [requestId],
      operation: 'RedemptionQueue.claim',
    })

    opts?.onProgress?.({
      stage: 'claimQueued',
      current: 1,
      total: 1,
      message: `Request ${requestId} claimed`,
      txHash: hash,
    })

    return hash
  }

  /**
   * Paginate-process a slice of an epoch. Issuer-only. Callers typically
   * loop `[startIdx..endIdx]` in batches matching on-chain gas limits.
   */
  async processEpoch(
    epochId: bigint,
    startIdx: bigint,
    endIdx: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (startIdx > endIdx) {
      throw new ConfigError(`startIdx (${startIdx}) > endIdx (${endIdx})`)
    }

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'processEpoch',
      args: [epochId, startIdx, endIdx],
      operation: 'RedemptionQueue.processEpoch',
    })

    opts?.onProgress?.({
      stage: 'processEpoch',
      current: Number(endIdx - startIdx),
      total: Number(endIdx - startIdx),
      message: `Processed epoch ${epochId} [${startIdx}..${endIdx})`,
      txHash: hash,
    })

    return hash
  }

  /**
   * Convenience: paginate `[startIdx..endIdx)` into `batchSize`-sized slices
   * and call `processEpoch` for each. Returns every tx hash for receipt
   * accounting. Useful when an epoch has more requests than fit in a single
   * tx's gas budget. If `endIdx` is omitted it is resolved from
   * `getEpochRequests(epochId).length`.
   */
  async processAllEpoch(
    epochId: bigint,
    opts?: {
      startIdx?: bigint
      endIdx?: bigint
      batchSize?: number
      onProgress?: ProgressCallback
    },
  ): Promise<Hash[]> {
    const start = opts?.startIdx ?? 0n
    const end =
      opts?.endIdx ??
      BigInt((await this.getEpochRequests(epochId)).length)
    const batchSize = opts?.batchSize ?? 50
    if (batchSize <= 0) {
      throw new ConfigError(`batchSize must be > 0, got ${batchSize}`)
    }
    if (start > end) {
      throw new ConfigError(`startIdx (${start}) > endIdx (${end})`)
    }
    const total = Number(end - start)
    if (total === 0) return []

    const batches = paginate(total, batchSize)
    const hashes: Hash[] = []
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!
      const sliceStart = start + BigInt(b.offset)
      const sliceEnd = sliceStart + BigInt(b.size)
      const hash = await this.processEpoch(epochId, sliceStart, sliceEnd, {
        onProgress: (e) =>
          opts?.onProgress?.({
            ...e,
            current: b.offset + e.current,
            total,
            message: `Batch ${i + 1}/${batches.length} — ${e.message ?? ''}`,
          }),
      })
      hashes.push(hash)
    }
    return hashes
  }

  /**
   * Issuer-only path for cancelling a mid-queue request when the investor's
   * KYC has been revoked (ADR-027). Preconditions:
   *   - Request not yet settled, claimed, or cancelled.
   *   - `IdentityRegistry.isVerified(investor) == false` at call time.
   */
  async cancelOnKYCRevocation(
    requestId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'cancelOnKYCRevocation',
      args: [requestId],
      operation: 'RedemptionQueue.cancelOnKYCRevocation',
    })

    opts?.onProgress?.({
      stage: 'cancelOnKYCRevocation',
      current: 1,
      total: 1,
      message: `Cancelled request ${requestId}`,
      txHash: hash,
    })

    return hash
  }

  // ── Views ─────────────────────────────────────────────────────────────

  async getToken(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'token',
    })) as Address
  }

  async getTreasury(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'treasury',
    })) as Address
  }

  async getIssuer(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'issuer',
    })) as Address
  }

  async getCurrentEpoch(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'currentEpoch',
    })) as bigint
  }

  async getNextRequestId(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'nextRequestId',
    })) as bigint
  }

  async getRequest(requestId: bigint): Promise<QueueRequest> {
    const raw = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'getRequest',
      args: [requestId],
    })) as {
      investor: Address
      encShares: `0x${string}`
      encProceeds: `0x${string}`
      epochId: bigint
      ephemeralEOA: Address
      maxSharesHint: bigint
      settled: boolean
      claimed: boolean
      cancelled: boolean
    }
    return raw
  }

  async getEpochRequests(epochId: bigint): Promise<readonly bigint[]> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: redemptionQueueAbi,
      functionName: 'getEpochRequests',
      args: [epochId],
    })) as readonly bigint[]
  }
}
