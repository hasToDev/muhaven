import type { Address, Hash } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError } from '../errors.js'
import { muHavenStableAbi } from '../abi/muHavenStable.js'
import { writeAndWait, parseWithdrawClaimId } from '../internal/contract.js'
import { encryptUint64 } from '../internal/encryption.js'
import { requireContext, requireEphemeralEOA } from './_context.js'

/**
 * Wave 3.5 Phase 7.5 — `MuHavenStable` client.
 *
 * MuHavenStable is the confidential-USDC wrapper that replaces every Wave
 * 3.5 use of legacy PUSDC (per `MHUSD_WRAPPER_PLAN.md` + ADR-041). It
 * exposes a modern `euint64` ABI plus an ephemeralEOA-aware ACL grant on
 * every mutation, so investor decrypt works in the kernel + ephemeral-EOA
 * model without the legacy PUSDC's kernel-only grant.
 *
 * Pre-flight (caller responsibility):
 *   - For `wrap`: caller has called `legacyPusdc.setOperator(mhUSDC, until)`
 *     so the wrapper can pull legacy PUSDC via ADR-008's
 *     `confidentialTransferFrom(address,address,uint256)` selector.
 *   - For `transferFrom`: caller has been granted operator via
 *     `MuHavenStable.setOperator(spender, until)` by the source holder.
 *
 * Encrypted views (`confidentialBalanceOf`, `confidentialTotalSupply`)
 * return on-chain `euint64` handles. Pass them to your cofhe client's
 * `decryptForView` to reveal the plaintext — only the holder's kernel +
 * the active session's ephemeralEOA have ACL grants, so a stranger
 * looking at the chain can't decrypt.
 */
export class StableClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'muHavenStable', address })
    this.ctx = context
    this.address = address
  }

  // ── Wrap / unwrap ────────────────────────────────────────────────────

  /**
   * Wrap legacy PUSDC into mhUSDC. Pulls `amount` from the caller via the
   * legacy operator path, mints equivalent mhUSDC to the caller, and
   * grants `FHE.allow(newBalance, ephemeralEOA)` so the active session
   * decrypts cleanly.
   */
  async wrap(
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting wrap amount',
    })

    const enc = await encryptUint64(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'wrap',
      args: [
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ephemeralEOA,
      ],
      operation: 'MuHavenStable.wrap',
    })

    opts?.onProgress?.({
      stage: 'wrap',
      current: 1,
      total: 1,
      // User-facing string — CLAUDE.md naming rule: never surface "PUSDC".
      message: 'Wrapped into mhUSDC',
      txHash: hash,
    })

    return hash
  }

  /**
   * Unwrap mhUSDC back to legacy PUSDC. Silent-fails to zero on
   * insufficient mhUSDC balance — observers can't infer the holder's
   * actual balance from gas usage. The follow-up legacy-PUSDC transfer
   * uses the silent-fail-bounded amount so the 1:1 invariant is
   * preserved on every leg.
   */
  async unwrap(
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting unwrap amount',
    })

    const enc = await encryptUint64(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'unwrap',
      args: [
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ephemeralEOA,
      ],
      operation: 'MuHavenStable.unwrap',
    })

    opts?.onProgress?.({
      stage: 'unwrap',
      current: 1,
      total: 1,
      // User-facing string — CLAUDE.md naming rule: never surface "PUSDC".
      message: 'mhUSDC unwrapped',
      txHash: hash,
    })

    return hash
  }

  /**
   * Wave 5 W3 Phase 9 — direct USDC → mhUSDC wrap. Pulls `amount` cleartext
   * USDC straight into the wrapper's reserve and mints `amount` of
   * trivially-encrypted mhUSDC 1:1. Unlike {@link wrap} (which pulls legacy
   * PUSDC), this takes raw USDC, so it needs NO client-side `encryptUint64`
   * step — the amount is public (the USDC ERC-20 Transfer log reveals it).
   *
   * Pre-flight (caller responsibility): `usdc.approve(muHavenStable, amount)`
   * — the wrapper pulls via `safeTransferFrom`. The amount is bounded by
   * `type(uint64).max` (mhUSDC's encrypted type is `euint64`).
   *
   * mhUSDC balances, transfers, and withdrawals stay confidential — only the
   * deposit edge is public, matching the legacy 2-step wrap's boundary.
   */
  async wrapUsdc(
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'wrap',
      current: 0,
      total: 1,
      message: 'Wrapping USDC into mhUSDC',
    })

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'wrapUsdc',
      args: [amount, ephemeralEOA],
      operation: 'MuHavenStable.wrapUsdc',
    })

    opts?.onProgress?.({
      stage: 'wrap',
      current: 1,
      total: 1,
      message: 'USDC wrapped into mhUSDC',
      txHash: hash,
    })

    return hash
  }

  // ── Direct USDC exit (Wave 5 W3 — two-phase async, no PUSDC) ─────────

  /**
   * Phase 1 of a direct mhUSDC → USDC withdrawal. Burns `min(balance, amount)`
   * mhUSDC (clamp-to-balance — an over-request withdraws the full balance, and
   * a deliberately-large `amount` does "withdraw all") and requests async
   * coprocessor decryption, returning the `claimId` of the new pending claim.
   *
   * Settle later with {@link claimUsdc} once {@link withdrawDecryptResult}
   * reports `ready`. Unlike {@link unwrap} (which returns legacy PUSDC), this
   * pays real USDC from the wrapper's reserve — PUSDC never enters the user's
   * path. `claimId` is null only if the receipt carried no `WithdrawRequested`
   * (defensive; a successful withdraw always emits one).
   */
  async withdrawToUsdc(
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<{ hash: Hash; claimId: bigint | null }> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting withdrawal amount',
    })

    const enc = await encryptUint64(this.ctx.cofheClient, amount)

    const { hash, logs } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'withdrawToUsdc',
      args: [
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ephemeralEOA,
      ],
      operation: 'MuHavenStable.withdrawToUsdc',
    })

    const claimId = parseWithdrawClaimId(logs, muHavenStableAbi, this.address)

    opts?.onProgress?.({
      stage: 'unwrap',
      current: 1,
      total: 1,
      message: 'Withdrawal requested — awaiting decryption, then claim',
      txHash: hash,
    })

    return { hash, claimId }
  }

  /**
   * Phase 2 of a direct withdrawal. Once the coprocessor result is ready
   * (poll {@link withdrawDecryptResult}), settles claim `claimId`: transfers
   * the decrypted USDC (1:1, 6-dp) from the reserve to the claim's recipient.
   * Permissionless — anyone may call it; funds always go to the recorded
   * recipient (so a backend auto-claim poller can settle on the user's behalf).
   */
  async claimUsdc(
    claimId: bigint,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (claimId <= 0n) throw new ConfigError(`claimId must be > 0, got ${claimId}`)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'claimUsdc',
      args: [claimId],
      operation: 'MuHavenStable.claimUsdc',
    })

    opts?.onProgress?.({
      stage: 'unwrap',
      current: 1,
      total: 1,
      message: 'USDC withdrawal settled',
      txHash: hash,
    })

    return hash
  }

  /** Current USDC reserve balance held by the wrapper (0 if unset). */
  async usdcReserveBalance(): Promise<bigint> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'usdcReserveBalance',
    })) as bigint
  }

  /** The configured USDC reserve token (zero address until the owner sets it). */
  async usdcReserveToken(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'usdc',
    })) as Address
  }

  /** Whether the settlement kill-switch is engaged (`claimUsdc` reverts). */
  async claimsPaused(): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'claimsPaused',
    })) as boolean
  }

  /** The pending/settled withdrawal claim for `claimId` (`to` is zero if none). */
  async getWithdrawClaim(claimId: bigint): Promise<{
    to: Address
    handle: `0x${string}`
    amount: bigint
    claimed: boolean
  }> {
    const c = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'getWithdrawClaim',
      args: [claimId],
    })) as { to: Address; handle: `0x${string}`; amount: bigint; claimed: boolean }
    return c
  }

  /** An account's pending (unsettled) withdrawal claim ids — for re-discovery. */
  async getUserWithdrawClaims(account: Address): Promise<readonly bigint[]> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'getUserWithdrawClaims',
      args: [account],
    })) as readonly bigint[]
  }

  /**
   * Poll the coprocessor decrypt result for a withdrawal `claimId`. Returns
   * `{ amount, ready }` — `ready` flips true once decryption completes, at
   * which point `claimUsdc(claimId)` will settle. `(0n, false)` for an
   * unknown claim.
   */
  async withdrawDecryptResult(claimId: bigint): Promise<{ amount: bigint; ready: boolean }> {
    const [amount, ready] = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'withdrawDecryptResult',
      args: [claimId],
    })) as [bigint, boolean]
    return { amount, ready }
  }

  // ── Confidential transfers ──────────────────────────────────────────

  /** Transfer `amount` mhUSDC from caller to `to`. Silent-fails on insufficient balance. */
  async transfer(
    to: Address,
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting transfer amount',
    })

    const enc = await encryptUint64(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'transfer',
      args: [
        to,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ephemeralEOA,
      ],
      operation: 'MuHavenStable.transfer',
    })

    opts?.onProgress?.({
      stage: 'transfer',
      current: 1,
      total: 1,
      message: `mhUSDC transferred to ${to}`,
      txHash: hash,
    })

    return hash
  }

  /** Transfer `amount` mhUSDC from `from` to `to`. Caller must be operator on `from`. */
  async transferFrom(
    from: Address,
    to: Address,
    amount: bigint,
    ephemeralEOA: Address,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (amount <= 0n) throw new ConfigError(`amount must be > 0, got ${amount}`)
    if (amount > (1n << 64n) - 1n) {
      throw new ConfigError(`amount exceeds 2^64 - 1, got ${amount}`)
    }
    requireEphemeralEOA(ephemeralEOA)

    opts?.onProgress?.({
      stage: 'encrypt',
      current: 0,
      total: 1,
      message: 'Encrypting transferFrom amount',
    })

    const enc = await encryptUint64(this.ctx.cofheClient, amount)

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'transferFrom',
      args: [
        from,
        to,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        ephemeralEOA,
      ],
      operation: 'MuHavenStable.transferFrom',
    })

    opts?.onProgress?.({
      stage: 'transfer',
      current: 1,
      total: 1,
      message: `mhUSDC moved from ${from} to ${to}`,
      txHash: hash,
    })

    return hash
  }

  // ── Operator model ───────────────────────────────────────────────────

  /**
   * Grant `operator` operator rights on the caller's mhUSDC balance until
   * `until` (uint48 unix timestamp). Required before another address can
   * call `transferFrom(caller, ...)`.
   */
  async setOperator(operator: Address, until: bigint): Promise<Hash> {
    if (until < 0n) throw new ConfigError(`until must be >= 0, got ${until}`)
    if (until > (1n << 48n) - 1n) {
      throw new ConfigError(`until exceeds uint48 max, got ${until}`)
    }
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'setOperator',
      args: [operator, Number(until)],
      operation: 'MuHavenStable.setOperator',
    })
    return hash
  }

  /**
   * Re-grant FHE ACL on the caller's current mhUSDC balance handle to
   * `ephemeralEOA`. Mirrors `MuHavenToken.refreshDecryptGrant` (ADR-042) —
   * use this when a fresh kernel session needs to decrypt without first
   * issuing a write op against the wrapper.
   */
  async refreshDecryptGrant(ephemeralEOA: Address): Promise<Hash> {
    requireEphemeralEOA(ephemeralEOA)
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'refreshDecryptGrant',
      args: [ephemeralEOA],
      operation: 'MuHavenStable.refreshDecryptGrant',
    })
    return hash
  }

  // ── Views ─────────────────────────────────────────────────────────────

  /**
   * Encrypted balance handle (`euint64` ctHash, hex-encoded `bytes32`)
   * for `account`. Pass to your cofhe client's `decryptForView` — only
   * the holder's kernel + the active session's ephemeralEOA have ACL
   * grants, so a stranger can't decrypt.
   */
  async confidentialBalanceOf(account: Address): Promise<`0x${string}`> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'confidentialBalanceOf',
      args: [account],
    })) as `0x${string}`
  }

  /** Encrypted total-supply handle (`euint64` ctHash, hex-encoded `bytes32`). */
  async confidentialTotalSupply(): Promise<`0x${string}`> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'confidentialTotalSupply',
    })) as `0x${string}`
  }

  /** Operator status check. Returns `true` if `until > block.timestamp`. */
  async isOperator(holder: Address, spender: Address): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'isOperator',
      args: [holder, spender],
    })) as boolean
  }

  /** Underlying legacy PUSDC pointer (rotatable; check the on-chain owner). */
  async legacyPusdc(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'legacyPusdc',
    })) as Address
  }

  /** Emergency pause flag — when true every mutation reverts. */
  async paused(): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'paused',
    })) as boolean
  }

  /** Governance owner (multi-sig in production). */
  async owner(): Promise<Address> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: muHavenStableAbi,
      functionName: 'owner',
    })) as Address
  }
}
