import type { Address, Hash } from 'viem'
import type { MuHavenClientContext, ProgressCallback } from '../types.js'
import { ConfigError } from '../errors.js'
import { identityRegistryAbi } from '../abi/identityRegistry.js'
import { writeAndWait } from '../internal/contract.js'
import { requireContext } from './_context.js'

/**
 * MuHavenIdentityRegistry client — ERC-3643-shaped KYC gate (ADR-011).
 *
 * Hot-path reads: `isVerified`, `devMode`, `countryOf`, `isAccredited`.
 * Admin writes: dev-mode toggle + whitelist management.
 *
 * The production-mode claim-issuance surface (`addClaim` / `removeClaim`)
 * is deliberately NOT exposed yet — Wave 3.5 runs in dev-mode and claim
 * issuance is handled off-band through the registry owner multisig. Callers
 * can reach it via direct `publicClient.writeContract` if needed.
 */
export class IdentityRegistryClient {
  readonly address: Address
  private readonly ctx: MuHavenClientContext

  constructor(context: MuHavenClientContext, address: Address) {
    requireContext(context, { addressLabel: 'identityRegistry', address })
    this.ctx = context
    this.address = address
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /** True if `account` is KYC-eligible. */
  async isVerified(account: Address): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'isVerified',
      args: [account],
    })) as boolean
  }

  /** Current state of the ADR-023 dev-mode bypass. */
  async devMode(): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'devMode',
    })) as boolean
  }

  /** True once `disableDevModeForever()` has run. */
  async devModeDisabled(): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'devModeDisabled',
    })) as boolean
  }

  /** ISO-3166 numeric country code for `account` (0 = unset). */
  async countryOf(account: Address): Promise<number> {
    const raw = (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'countryOf',
      args: [account],
    })) as number | bigint
    return Number(raw)
  }

  async isAccredited(account: Address): Promise<boolean> {
    return (await this.ctx.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'isAccredited',
      args: [account],
    })) as boolean
  }

  // ── Writes ────────────────────────────────────────────────────────────

  /**
   * Bulk-add accounts to the whitelist. Used during the Wave 3 → Wave 3.5
   * cutover to auto-recognise Wave 3 investors per `MIGRATION.md`.
   */
  async addWhitelisted(
    accounts: Address[],
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    if (accounts.length === 0) throw new ConfigError('accounts list is empty')

    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'addWhitelisted',
      args: [accounts],
      operation: 'MuHavenIdentityRegistry.addWhitelisted',
    })
    opts?.onProgress?.({
      stage: 'addWhitelisted',
      current: accounts.length,
      total: accounts.length,
      message: `Whitelisted ${accounts.length} account(s)`,
      txHash: hash,
    })
    return hash
  }

  async removeWhitelisted(account: Address): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'removeWhitelisted',
      args: [account],
      operation: 'MuHavenIdentityRegistry.removeWhitelisted',
    })
    return hash
  }

  /** Toggle the dev-mode bypass. Reverts once `disableDevModeForever` has run. */
  async setDevMode(
    enabled: boolean,
    opts?: { onProgress?: ProgressCallback },
  ): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'setDevMode',
      args: [enabled],
      operation: 'MuHavenIdentityRegistry.setDevMode',
    })
    opts?.onProgress?.({
      stage: 'setDevMode',
      current: 1,
      total: 1,
      message: `devMode = ${enabled}`,
      txHash: hash,
    })
    return hash
  }

  /**
   * Irreversibly disable dev-mode. ADR-023 latch — no setter can re-enable
   * dev-mode after this tx lands.
   */
  async disableDevModeForever(): Promise<Hash> {
    const { hash } = await writeAndWait({
      publicClient: this.ctx.publicClient,
      sender: this.ctx.sender,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: 'disableDevModeForever',
      args: [],
      operation: 'MuHavenIdentityRegistry.disableDevModeForever',
    })
    return hash
  }
}
