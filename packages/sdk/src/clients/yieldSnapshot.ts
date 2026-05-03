import type { Address, Hash } from 'viem'
import { parseEventLogs } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError, InvariantError } from '../errors.js'
import { yieldSnapshotAbi } from '../abi/yieldSnapshot.js'
import { writeAndWait } from '../internal/contract.js'
import { encryptUint128 } from '../internal/encryption.js'
import { requireContext, requireEphemeralEOA } from './_context.js'
import { paginate } from '../internal/batching.js'

/**
 * Epoch snapshot view as returned by `getEpoch`. Encrypted aggregates are
 * `bytes32` handles — use the frontend's permit flow to decrypt when the
 * issuer has been granted access.
 */
export interface EpochView {
  token: Address
  snapshotStartTs: bigint
  snapshotEndTs: bigint
  finalized: boolean
  funded: boolean
  encTotalYield: `0x${string}`
  encTotalSupply: `0x${string}`
  encRatio: `0x${string}`
  claimExpiry: bigint
  holderCount: bigint
  /**
   * Phase 9.B / Option A — issuer-provided cleartext per-share yield
   * rate. `floor(totalYield / totalSupply)` in PUSDC-base-units per
   * share-base-unit. Zero for legacy pre-Option-A epochs (claimYield
   * falls back to the encRatio path for those). Public on-chain by
   * design; per-investor balances and shares stay encrypted.
   */
  ratePerShare: bigint
}

/**
 * Wave 3.5 pull-based yield client (ADR-005).
 *
 * Issuer flow: `openEpoch` → `snapshotBatch` (paginated) → `finalizeSnapshot`
 * → `fundEpoch` → investors call `claimYield` → `sweepExpired` after the
 * claim window closes.
 */
export class YieldSnapshotClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'yieldSnapshot', address })
    this.ctx = context
    this.address = address
  }

  // ── Issuer cold path ─────────────────────────────────────────────────

  /** Allocate a new epoch for `token`. Returns the new `epochId`. */
  async openEpoch(
    token: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<{ epochId: bigint; txHash: Hash }> {
    const { hash, logs } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'openEpoch',
      args: [token],
      operation: 'YieldSnapshot.openEpoch',
    })

    const events = parseEventLogs({
      abi: yieldSnapshotAbi as any,
      eventName: 'EpochOpened',
      logs,
    })
    const match = events.find(
      log => log.address.toLowerCase() === this.address.toLowerCase(),
    )
    if (!match) {
      throw new InvariantError('YieldSnapshot.openEpoch emitted no EpochOpened event')
    }
    const epochId = (match as unknown as { args: { epochId: bigint } }).args.epochId

    opts?.onProgress?.({
      stage: 'openEpoch',
      current: 1,
      total: 1,
      message: `Epoch ${epochId} opened for ${token}`,
      txHash: hash,
    })

    return { epochId, txHash: hash }
  }

  /**
   * Capture a paginated batch of investors into the epoch snapshot.
   * Idempotent per (epochId, investor) — duplicate calls silently skip.
   */
  async snapshotBatch(
    epochId: bigint,
    investors: Address[],
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (investors.length === 0) throw new ConfigError('investors list is empty')

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'snapshotBatch',
      args: [epochId, investors],
      operation: 'YieldSnapshot.snapshotBatch',
    })

    opts?.onProgress?.({
      stage: 'snapshotBatch',
      current: investors.length,
      total: investors.length,
      message: `Snapshot batch of ${investors.length} applied to epoch ${epochId}`,
      txHash: hash,
    })

    return hash
  }

  /**
   * Helper: split a large investor list into `batchSize`-sized slices and
   * submit each via `snapshotBatch`. Returns every tx hash for receipt
   * accounting in tests / deploy logs.
   */
  async snapshotAll(
    epochId: bigint,
    investors: Address[],
    opts?: { batchSize?: number; onProgress?: ProgressCallback },
  ): Promise<Hash[]> {
    const batchSize = opts?.batchSize ?? 50
    if (batchSize <= 0) {
      throw new ConfigError(`batchSize must be > 0, got ${batchSize}`)
    }
    if (investors.length === 0) return []

    const batches = paginate(investors.length, batchSize)
    const hashes: Hash[] = []
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!
      const slice = investors.slice(b.offset, b.offset + b.size)
      const hash = await this.snapshotBatch(epochId, slice, {
        onProgress: (e) => opts?.onProgress?.({
          ...e,
          current: b.offset + e.current,
          total: investors.length,
          message: `Batch ${i + 1}/${batches.length} — ${e.message ?? ''}`,
        }),
      })
      hashes.push(hash)
    }
    return hashes
  }

  /** Lock the snapshot phase for an epoch. Reverts on empty snapshot. */
  async finalizeSnapshot(
    epochId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'finalizeSnapshot',
      args: [epochId],
      operation: 'YieldSnapshot.finalizeSnapshot',
    })
    opts?.onProgress?.({
      stage: 'finalizeSnapshot',
      current: 1,
      total: 1,
      message: `Epoch ${epochId} finalised`,
      txHash: hash,
    })
    return hash
  }

  /**
   * Pull PUSDC from the issuer and store the per-share yield rate
   * for the epoch. Caller MUST have granted `YieldSnapshot` operator
   * access on PUSDC beforehand (`pusdc.setOperator(yieldSnapshot,
   * ttl)`).
   *
   * Phase 9.B / Option A (2026-05-04): the third arg `ratePerShare`
   * is the issuer's off-chain `floor(totalYield / totalSupply)`. It
   * is stored cleartext on-chain and used in `claimYield` via a
   * depth-1 trivial encryption — sidestepping the deep `encRatio`
   * ancestry that empirically stalled cofhe TN's resolution path.
   * See `PHASE9A_CHAIN_LENGTH_BLOCKER.md > Option A`. MUST be > 0.
   *
   * Privacy boundary: per-share rate is publicly readable on-chain.
   * Per-investor balances and per-claim shares stay encrypted.
   */
  async fundEpoch(
    epochId: bigint,
    totalYield: bigint,
    ratePerShare: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (totalYield <= 0n) throw new ConfigError(`totalYield must be > 0, got ${totalYield}`)
    if (ratePerShare <= 0n) throw new ConfigError(`ratePerShare must be > 0, got ${ratePerShare}`)
    if (ratePerShare > (1n << 128n) - 1n) {
      throw new ConfigError(`ratePerShare overflows uint128, got ${ratePerShare}`)
    }

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting total yield',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, totalYield)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'fundEpoch',
      args: [
        epochId,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ratePerShare,
      ],
      operation: 'YieldSnapshot.fundEpoch',
    })

    opts?.onProgress?.({
      stage: 'fundEpoch',
      current: 1,
      total: 1,
      message: `Epoch ${epochId} funded`,
      txHash: hash,
    })

    return hash
  }

  /**
   * Sweep unclaimed PUSDC back to the issuer after the claim window. Single-
   * shot — subsequent calls revert with `AlreadySwept`.
   */
  async sweepExpired(
    epochId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'sweepExpired',
      args: [epochId],
      operation: 'YieldSnapshot.sweepExpired',
    })
    opts?.onProgress?.({
      stage: 'sweepExpired',
      current: 1,
      total: 1,
      message: `Epoch ${epochId} swept`,
      txHash: hash,
    })
    return hash
  }

  // ── Investor hot path ────────────────────────────────────────────────

  /**
   * Claim the caller's proportional share of a funded epoch. Idempotent —
   * re-calls revert with `AlreadyClaimed`. Reverts with `NotSnapshotted`
   * when the caller was not included in the snapshot.
   */
  async claimYield(
    epochId: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    requireEphemeralEOA(ephemeralEOA)
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'claimYield',
      args: [epochId, ephemeralEOA],
      operation: 'YieldSnapshot.claimYield',
    })
    opts?.onProgress?.({
      stage: 'claimYield',
      current: 1,
      total: 1,
      message: `Yield claimed on epoch ${epochId}`,
      txHash: hash,
    })
    return hash
  }

  /**
   * Re-stamp the ACL grant on a previously-issued audit handle (the
   * `amount` field of a past `YieldClaimed` event) to a new ephemeralEOA.
   * Cross-session decrypt path — the originating claim's eph is gone
   * after a session rotation, but the kernel that owned the claim still
   * has a durable ACL grant on the handle (granted at claim time via
   * `FHE.allow(handle, msg.sender)`). Mirror of
   * `MuHavenStable.refreshAuditGrant` (ADR-042).
   *
   * The contract gates this on `FHE.isAllowed(handle, msg.sender)`, so
   * only the rightful kernel passes — strangers passing in someone
   * else's audit handle bounce with `NotAuditHandleOwner`.
   */
  async refreshAuditGrant(
    handle: `0x${string}`,
    ephemeralEOA: Address,
  ): Promise<Hash> {
    requireEphemeralEOA(ephemeralEOA)
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'refreshAuditGrant',
      args: [handle, ephemeralEOA],
      operation: 'YieldSnapshot.refreshAuditGrant',
    })
    return hash
  }

  // ── Views ─────────────────────────────────────────────────────────────

  async getEpoch(epochId: bigint): Promise<EpochView> {
    const raw = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'getEpoch',
      args: [epochId],
    })) as EpochView
    return raw
  }

  /** Encrypted per-investor snapshot handle for an epoch. */
  async getSnapshotBalance(
    epochId: bigint,
    investor: Address,
  ): Promise<`0x${string}`> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'getSnapshotBalance',
      args: [epochId, investor],
    })) as `0x${string}`
  }

  async hasClaimed(epochId: bigint, investor: Address): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'hasClaimed',
      args: [epochId, investor],
    })) as boolean
  }

  async getCurrentEpoch(token: Address): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'currentEpoch',
      args: [token],
    })) as bigint
  }

  async isSwept(epochId: bigint): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: yieldSnapshotAbi,
      functionName: 'isSwept',
      args: [epochId],
    })) as boolean
  }
}
