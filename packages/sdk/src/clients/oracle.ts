import type { Address, Hash } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError } from '../errors.js'
import { priceOracleAbi } from '../abi/oracle.js'
import { writeAndWait } from '../internal/contract.js'
import { requireContext } from './_context.js'

/**
 * Oracle client — reads against any `IPriceOracle`, writes against
 * `IIssuerControlledOracle` (cleartext NAV publication + deviation-gate
 * accept/reject). `ChainlinkFunctionsOracle.requestNAV` is on the same
 * ABI so the backend NAV cron can drive both impls through one client.
 *
 * `getNAV` + `isFresh` are the two hot-path reads callers use to:
 *   1. Surface NAV + staleness to investors pre-purchase.
 *   2. Refuse to send a purchase/redeem when `isFresh == false` (the
 *      contract will revert with `StaleNAV` anyway, but SDK-side bailout
 *      saves a signed tx).
 */
export class OracleClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'oracle', address })
    this.ctx = context
    this.address = address
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /**
   * Latest (NAV, updatedAt) for `token`. NAV is cleartext (regulatorily
   * public per `IPriceOracle` natspec).
   */
  async getNAV(token: Address): Promise<{ nav: bigint; updatedAt: bigint }> {
    const raw = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'getNAV',
      args: [token],
    })) as readonly [bigint, bigint]
    return { nav: raw[0], updatedAt: raw[1] }
  }

  async getMaxStaleness(token: Address): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'getMaxStaleness',
      args: [token],
    })) as bigint
  }

  /**
   * Consolidated freshness predicate per `IPriceOracle`: true iff NAV is
   * non-zero and within staleness, AND the L2 sequencer is up past its
   * grace window (ADR-014). Prefer this over `getNAV` + manual staleness
   * math — implementations that integrate a sequencer feed bake the extra
   * check in here.
   */
  async isFresh(token: Address): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'isFresh',
      args: [token],
    })) as boolean
  }

  async getPendingNAV(token: Address): Promise<{ pendingNAV: bigint; pendingUpdatedAt: bigint }> {
    const raw = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'getPendingNAV',
      args: [token],
    })) as readonly [bigint, bigint]
    return { pendingNAV: raw[0], pendingUpdatedAt: raw[1] }
  }

  async getMaxDeviationBps(token: Address): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'getMaxDeviationBps',
      args: [token],
    })) as bigint
  }

  async getNavWriter(token: Address): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'getNavWriter',
      args: [token],
    })) as Address
  }

  async isSequencerUp(): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'isSequencerUp',
    })) as boolean
  }

  // ── Writes (IIssuerControlledOracle) ─────────────────────────────────

  /**
   * Publish a new cleartext NAV. The per-token `navWriter` is the only
   * caller accepted on-chain. Over-deviation values park in `pendingNAV`
   * rather than committing — callers can poll `getPendingNAV` afterwards.
   */
  async setNAV(
    token: Address,
    newNAV: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (newNAV <= 0n) throw new ConfigError(`newNAV must be > 0, got ${newNAV}`)
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'setNAV',
      args: [token, newNAV],
      operation: 'IssuerControlledOracle.setNAV',
    })
    opts?.onProgress?.({
      stage: 'setNAV',
      current: 1,
      total: 1,
      message: `NAV published for ${token}`,
      txHash: hash,
    })
    return hash
  }

  /** Owner-only: accept a deviation-parked NAV as the new canonical quote. */
  async acceptPendingNAV(
    token: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'acceptPendingNAV',
      args: [token],
      operation: 'IssuerControlledOracle.acceptPendingNAV',
    })
    opts?.onProgress?.({
      stage: 'acceptPendingNAV',
      current: 1,
      total: 1,
      message: `Pending NAV accepted for ${token}`,
      txHash: hash,
    })
    return hash
  }

  /** Owner-only: reject a deviation-parked NAV. */
  async rejectPendingNAV(
    token: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'rejectPendingNAV',
      args: [token],
      operation: 'IssuerControlledOracle.rejectPendingNAV',
    })
    opts?.onProgress?.({
      stage: 'rejectPendingNAV',
      current: 1,
      total: 1,
      message: `Pending NAV rejected for ${token}`,
      txHash: hash,
    })
    return hash
  }

  /**
   * `ChainlinkFunctionsOracle.requestNAV` — kicks off a Functions request
   * for `token`. Returns the function-level request id for receipt parsing;
   * the fulfilled NAV lands via `handleOracleFulfillment` later. Safe to call
   * against non-Chainlink oracles — they will revert, surfacing as
   * `TxFailedError`.
   */
  async requestNAV(
    token: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: priceOracleAbi,
      functionName: 'requestNAV',
      args: [token],
      operation: 'ChainlinkFunctionsOracle.requestNAV',
    })
    opts?.onProgress?.({
      stage: 'requestNAV',
      current: 1,
      total: 1,
      message: `NAV request kicked off for ${token}`,
      txHash: hash,
    })
    return hash
  }
}
