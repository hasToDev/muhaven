import type { Address, Hash } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError } from '../errors.js'
import { muhavenTreasuryAbi } from '../abi/treasury.js'
import { writeAndWait } from '../internal/contract.js'
import { encryptUint128 } from '../internal/encryption.js'
import { requireContext } from './_context.js'

/**
 * Wave 3.5 per-token PUSDC custodian client. One treasury instance per RWA
 * token. Issuer-facing — investors never touch these methods directly.
 *
 * `deposit`/`withdraw` are silent-fail (ADR-029): withdraw below `minFloat`
 * truncates to `max(0, float - minFloat)` rather than reverting. Issuers
 * verify the actual PUSDC transfer via PUSDC event logs, not via this API.
 */
export class TreasuryClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'treasury', address })
    this.ctx = context
    this.address = address
  }

  /**
   * Emit a `TreasuryDeposited` marker event. In practice issuers transfer
   * PUSDC directly to the treasury address; this is an analytics hook.
   */
  async deposit(
    amount: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting deposit marker amount',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'deposit',
      args: [{
        ctHash: enc.ctHash,
        securityZone: enc.securityZone,
        utype: enc.utype,
        signature: enc.signature,
      }],
      operation: 'MuHavenTreasury.deposit',
    })

    opts?.onProgress?.({
      stage: 'deposit',
      current: 1,
      total: 1,
      message: 'Treasury deposit marker emitted',
      txHash: hash,
    })

    return hash
  }

  /**
   * Withdraw PUSDC, silent-failed against `minFloat`. Actual amount sent
   * is `min(amount, max(0, float - minFloat))` — off-chain reconcile via
   * PUSDC event logs.
   */
  async withdraw(
    amount: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting withdraw amount',
    })

    const enc = await encryptUint128(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'withdraw',
      args: [{
        ctHash: enc.ctHash,
        securityZone: enc.securityZone,
        utype: enc.utype,
        signature: enc.signature,
      }],
      operation: 'MuHavenTreasury.withdraw',
    })

    opts?.onProgress?.({
      stage: 'withdraw',
      current: 1,
      total: 1,
      message: 'Treasury withdraw submitted',
      txHash: hash,
    })

    return hash
  }

  // ── Admin ─────────────────────────────────────────────────────────────

  async setMinFloat(newMin: bigint): Promise<Hash> {
    if (newMin < 0n) throw new ConfigError(`newMin must be >= 0, got ${newMin}`)
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'setMinFloat',
      args: [newMin],
      operation: 'MuHavenTreasury.setMinFloat',
    })
    return hash
  }

  async setIssuer(newIssuer: Address): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'setIssuer',
      args: [newIssuer],
      operation: 'MuHavenTreasury.setIssuer',
    })
    return hash
  }

  // ── Views ─────────────────────────────────────────────────────────────

  async getMinFloat(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'getMinFloat',
    })) as bigint
  }

  async getToken(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'token',
    })) as Address
  }

  async getIssuer(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muhavenTreasuryAbi,
      functionName: 'issuer',
    })) as Address
  }
}
