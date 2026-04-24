import type { Address, Hash } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError } from '../errors.js'
import { muhavenSubscriptionAbi } from '../abi/subscription.js'
import { writeAndWait } from '../internal/contract.js'
import { encryptUint128 } from '../internal/encryption.js'
import { requireContext, requireEphemeralEOA } from './_context.js'

/**
 * Wave 3.5 atomic buy/sell client — wraps `MuHavenSubscription.purchase` and
 * `MuHavenSubscription.redeem`. Every mutation takes the caller's
 * `ephemeralEOA` per ADR-021 and a cleartext `maxSharesHint` per ADR-004.
 *
 * Pre-flight (caller responsibility, matches FLOWS §F2):
 *   - Investor has set `PUSDC.setOperator(subscription, ttl)` (one-time per
 *     session for the purchase leg; redeem leg uses the treasury's
 *     immutable operator grant to Subscription).
 *   - Investor has set `MuHavenToken.setOperator(subscription, ttl)` if the
 *     SDK consumer also plans to call `MuHavenToken` methods through the
 *     subscription flow.
 *   - Investor already holds enough PUSDC (purchase) or fhERC-20 shares
 *     (redeem) — both legs silent-fail to zero otherwise.
 */
export class SubscriptionClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'subscription', address })
    this.ctx = context
    this.address = address
  }

  /**
   * Atomic purchase: encrypt `shares`, submit `purchase(token, encShares,
   * maxSharesHint, ephemeralEOA)`, wait for the tx, return the hash.
   *
   * @param token           Wave 3.5 RWA token address (must be active).
   * @param shares          Cleartext share amount to purchase. Must be > 0
   *                        and <= maxSharesHint.
   * @param maxSharesHint   Cleartext upper bound (ADR-004). Over-hint
   *                        purchases silent-fail to zero on-chain.
   * @param ephemeralEOA    Session signer that will decrypt the resulting
   *                        balance handle (ADR-021).
   */
  async purchase(
    token: Address,
    shares: bigint,
    maxSharesHint: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (shares <= 0n) throw new ConfigError(`shares must be > 0, got ${shares}`)
    if (maxSharesHint <= 0n) throw new ConfigError(`maxSharesHint must be > 0, got ${maxSharesHint}`)
    if (shares > maxSharesHint) {
      throw new ConfigError(
        `shares (${shares}) > maxSharesHint (${maxSharesHint}); on-chain purchase would silent-fail`,
      )
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting share amount',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, shares)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenSubscriptionAbi,
      functionName: 'purchase',
      args: [
        token,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        maxSharesHint,
        ephemeralEOA,
      ],
      operation: 'MuHavenSubscription.purchase',
    })

    opts?.onProgress?.({
      stage: 'purchase',
      current: 1,
      total: 1,
      message: `Purchased shares on ${token}`,
      txHash: hash,
    })

    return hash
  }

  /**
   * Atomic instant redeem. On cap-overflow the contract silently escalates
   * to `RedemptionQueue.submitFor` and emits `EscalatedToQueue(..., requestId)`
   * + `Redeemed(escalated=true)`. Callers that want to know whether the
   * request escalated should parse the emitted events from the receipt.
   */
  async redeem(
    token: Address,
    shares: bigint,
    maxSharesHint: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (shares <= 0n) throw new ConfigError(`shares must be > 0, got ${shares}`)
    if (maxSharesHint <= 0n) throw new ConfigError(`maxSharesHint must be > 0, got ${maxSharesHint}`)
    if (shares > maxSharesHint) {
      throw new ConfigError(
        `shares (${shares}) > maxSharesHint (${maxSharesHint}); on-chain redeem would silent-fail`,
      )
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting share amount',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, shares)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenSubscriptionAbi,
      functionName: 'redeem',
      args: [
        token,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        maxSharesHint,
        ephemeralEOA,
      ],
      operation: 'MuHavenSubscription.redeem',
    })

    opts?.onProgress?.({
      stage: 'redeemInstant',
      current: 1,
      total: 1,
      message: `Redeem submitted on ${token}`,
      txHash: hash,
    })

    return hash
  }

  // ── Views ─────────────────────────────────────────────────────────────

  /** Remaining PUSDC capacity for instant redeem in the current epoch. */
  async getInstantCapRemaining(token: Address): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muhavenSubscriptionAbi,
      functionName: 'getInstantCapRemaining',
      args: [token],
    })) as bigint
  }

  /** Current instant-redeem epoch index. */
  async getCurrentEpoch(token: Address): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muhavenSubscriptionAbi,
      functionName: 'getCurrentEpoch',
      args: [token],
    })) as bigint
  }
}
