import { storeToRefs } from 'pinia'
import { createWalletClient, http, type Address } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { arbitrumSepolia } from 'viem/chains'
import { useFheStore } from '@/stores/fhe'
import { useWalletStore } from '@/stores/wallet'
import type { EncryptableItem, EncryptedItemInput } from '@cofhe/sdk'

/**
 * useFhe — FHE client composable. Wave 3.5 migration (ADR-021 + PERMIT_DECRYPT_LIFECYCLE.md).
 *
 * Generates a per-session ephemeral EOA at first use, holds the private key in
 * memory only (never persisted), and connects the CoFHE client with that EOA
 * as the permit signer. Every Wave 3.5 contract write passes `ephemeralEOA` as
 * a trailing parameter so on-chain `FHE.allow(handle, ephemeralEOA)` grants
 * decrypt rights to the EOA — permit signatures are plain ECDSA and always
 * verifiable, sidestepping the ERC-1271 counterfactual-kernel issue that
 * required the Wave 3 defer-and-retry workaround.
 */

type CofheClient = Awaited<ReturnType<typeof import('@cofhe/sdk/web').createCofheClient>>

// ── Module-level singletons ─────────────────────────────────────────────
// The cofhe client + ephemeral key live outside Pinia to avoid deep
// reactivity on complex stateful objects. The store only tracks flags.

let cofheClient: CofheClient | null = null
let initPromise: Promise<void> | null = null
let ephemeralPrivateKey: `0x${string}` | null = null
let ephemeralAddress: Address | null = null

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'

// ── Lazy SDK imports ────────────────────────────────────────────────────

async function loadSdk() {
  const [{ createCofheClient, createCofheConfig }, { arbSepolia }] = await Promise.all([
    import('@cofhe/sdk/web'),
    import('@cofhe/sdk/chains'),
  ])
  return { createCofheClient, createCofheConfig, arbSepolia }
}

async function loadEncryptable() {
  const { Encryptable } = await import('@cofhe/sdk')
  return Encryptable
}

export type { EncryptableItem, EncryptedItemInput }

// ── Ephemeral EOA plumbing ──────────────────────────────────────────────

function buildEphemeralWalletClient(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey)
  return createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(RPC_URL),
  })
}

function ensureEphemeralKey(): { privateKey: `0x${string}`; address: Address } {
  if (!ephemeralPrivateKey || !ephemeralAddress) {
    ephemeralPrivateKey = generatePrivateKey()
    ephemeralAddress = privateKeyToAccount(ephemeralPrivateKey).address
  }
  return { privateKey: ephemeralPrivateKey, address: ephemeralAddress }
}

// ── Composable ──────────────────────────────────────────────────────────

export function useFhe() {
  const fheStore = useFheStore()
  const walletStore = useWalletStore()
  const { isReady, isInitializing, error, currentStep } = storeToRefs(fheStore)

  /**
   * Initialize the CoFHE client against an in-memory ephemeral EOA.
   *
   * The publicClient comes from the kernel's provider (chain bound), but the
   * signer is the ephemeral EOA — so permit signatures are ECDSA and always
   * verifiable. Encryption inputs are also signed by the ephemeral EOA; the
   * contract-side verification is prover-identity-only, not tx-sender-bound.
   *
   * Idempotent. Concurrent callers share the in-flight init promise.
   */
  async function initialize(): Promise<void> {
    if (cofheClient) return
    if (initPromise) return initPromise
    initPromise = doInitialize()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
  }

  async function doInitialize(): Promise<void> {
    fheStore.setInitializing()

    // Lazy-reconnect the kernel provider so we can grab a publicClient. The
    // ephemeral EOA-side walletClient does not need the kernel, but the
    // cofhe client binds to the kernel's publicClient for chain/RPC access.
    try {
      await walletStore.ensureConnected()
    } catch (e) {
      fheStore.setError('Wallet not connected')
      throw new Error(
        `Wallet not connected — cannot initialize FHE client (${e instanceof Error ? e.message : 'unknown'})`,
      )
    }

    const clients = walletStore.getViemClients()
    if (!clients) {
      fheStore.setError('Wallet not connected')
      throw new Error('Wallet not connected — cannot initialize FHE client')
    }

    try {
      const { privateKey } = ensureEphemeralKey()
      const ephemeralWalletClient = buildEphemeralWalletClient(privateKey)

      const { createCofheClient, createCofheConfig, arbSepolia } = await loadSdk()
      const config = createCofheConfig({ supportedChains: [arbSepolia] })
      const client = createCofheClient(config)

      // Connect with kernel's publicClient + ephemeral EOA walletClient.
      // Permits now sign ECDSA; the kernel is not a permit signer anymore.
      await client.connect(
        clients.publicClient as any,
        ephemeralWalletClient as any,
      )

      // Create the self-permit eagerly. The ephemeral EOA has no counterfactual
      // problem — it's a plain EOA, so the permit is valid at signing time.
      await client.permits.getOrCreateSelfPermit()

      cofheClient = client
      fheStore.setReady()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'FHE initialization failed'
      fheStore.setError(msg)
      throw e
    }
  }

  async function ensureReady(): Promise<CofheClient> {
    if (cofheClient) return cofheClient
    if (initPromise) {
      await initPromise
      if (cofheClient) return cofheClient
    }
    await initialize()
    if (!cofheClient) throw new Error('FHE client not initialized')
    return cofheClient
  }

  /**
   * Return the current session's ephemeral EOA address. Materialises the key
   * on first call. Callers pass this as the trailing `ephemeralEOA` argument
   * on every Wave 3.5 mutation (ADR-021).
   */
  function getEphemeralEOA(): Address {
    const { address } = ensureEphemeralKey()
    return address
  }

  /** Detect TN HTTP 403 — returned for unknown / zero ctHashes. */
  function is403Error(e: unknown): boolean {
    const raw = e instanceof Error ? e.message : String(e)
    return /HTTP 403/.test(raw) || /403 \(Forbidden\)/.test(raw) || /Forbidden/i.test(raw)
  }

  // ── Encryption helpers ────────────────────────────────────────────────

  async function encryptUint128(value: bigint): Promise<EncryptedItemInput> {
    const client = await ensureReady()
    const Encryptable = await loadEncryptable()
    try {
      const [result] = await client
        .encryptInputs([Encryptable.uint128(value)])
        .onStep((step: string) => { fheStore.currentStep = step })
        .execute()
      return result as unknown as EncryptedItemInput
    } finally {
      fheStore.currentStep = null
    }
  }

  async function encryptUint64(value: bigint): Promise<EncryptedItemInput> {
    const client = await ensureReady()
    const Encryptable = await loadEncryptable()
    try {
      const [result] = await client
        .encryptInputs([Encryptable.uint64(value)])
        .onStep((step: string) => { fheStore.currentStep = step })
        .execute()
      return result as unknown as EncryptedItemInput
    } finally {
      fheStore.currentStep = null
    }
  }

  async function encryptAddress(addr: string): Promise<EncryptedItemInput> {
    const client = await ensureReady()
    const Encryptable = await loadEncryptable()
    try {
      const [result] = await client
        .encryptInputs([Encryptable.address(addr)])
        .onStep((step: string) => { fheStore.currentStep = step })
        .execute()
      return result as unknown as EncryptedItemInput
    } finally {
      fheStore.currentStep = null
    }
  }

  async function encryptBatch(items: EncryptableItem[]): Promise<EncryptedItemInput[]> {
    const client = await ensureReady()
    try {
      const results = await client
        .encryptInputs(items)
        .onStep((step: string) => { fheStore.currentStep = step })
        .execute()
      return results as unknown as EncryptedItemInput[]
    } finally {
      fheStore.currentStep = null
    }
  }

  // ── Decryption helpers ────────────────────────────────────────────────

  async function decryptUint128ForView(
    ctHash: bigint | string,
    tokenAddress?: `0x${string}`,
  ): Promise<bigint> {
    // Default: withRefresh = true. Used for MuHavenToken balance handles
    // which Phase 7 `refreshDecryptGrant` can re-bind to the session EOA.
    // `tokenAddress` is required when decrypting Wave 3.5 per-RWA tokens
    // (TBILL1 / GOLD1) — the refresh fallback dispatches the
    // `refreshDecryptGrant` tx to that contract. Omit on Wave 3 single-
    // token decrypts (defaults to `addresses.muHavenToken`).
    return decryptForView(ctHash, 128, { tokenAddress })
  }

  async function decryptUint64ForView(ctHash: bigint | string): Promise<bigint> {
    // Legacy PUSDC handles live in a contract we don't own; self-service
    // refresh is not applicable. Disable the fallback so a 403 surfaces
    // directly. For Wave 3.5 mhUSDC handles, callers should use
    // `decryptMhUsdcForView` instead — that path does refresh-on-403 via
    // `MuHavenStable.refreshDecryptGrant` (ADR-041, mirror of ADR-042).
    return decryptForView(ctHash, 64, { withRefresh: false })
  }

  /**
   * Phase 7.5 — decrypt an mhUSDC (`MuHavenStable`) `euint64` handle for
   * UI display. On 403, calls `MuHavenStable.refreshDecryptGrant` once
   * with the active ephemeral EOA and retries — closes the same kernel-
   * only-grant gap that ADR-042 closes for `MuHavenToken`.
   *
   * Returns 0n for a zero handle (matches `decryptForView` short-circuit).
   * If the initial decrypt 403s and the wrapper isn't configured for
   * this build, the refresh path throws — there's nothing else to try.
   */
  async function decryptMhUsdcForView(ctHash: bigint | string): Promise<bigint> {
    return decryptForView(ctHash, 64, { withRefresh: true, kind: 'muHavenStable' })
  }

  /**
   * Phase 9.A · Option Z follow-up — decrypt a HISTORICAL audit handle
   * (the encrypted amount carried in a `MuHavenStable.Wrap` / `Unwrap`
   * event). Differs from `decryptMhUsdcForView` in the 403 fallback:
   * `refreshDecryptGrant` only re-grants the LIVE balance handle, but
   * audit handles are frozen-in-time — the grant must be re-stamped on
   * the specific historical handle, which is what
   * `MuHavenStable.refreshAuditGrant(handle, eph)` does.
   *
   * The contract gates `refreshAuditGrant` on
   * `FHE.isAllowed(handle, msg.sender)`, so only the rightful kernel
   * (which had `FHE.allow(amount, msg.sender)` stamped at wrap time)
   * passes. Strangers decoding someone else's audit row from /activity
   * still 403.
   */
  async function decryptAuditHandleForView(ctHash: bigint | string): Promise<bigint> {
    return decryptForView(ctHash, 64, { withRefresh: true, kind: 'mhUsdcAudit' })
  }

  /**
   * Decrypt an encrypted handle for UI display. Returns `0n` immediately for
   * a zero handle — the TN 403s on unregistered ctHashes and a zero value is
   * the expected "no confidential state yet" reading.
   *
   * No Wave 3 kernel-permit defer-and-retry — that workaround (M1/M2 in
   * `PERMIT_DECRYPT_LIFECYCLE.md`) is retired; permit signing uses the
   * ephemeral EOA, which is always a valid ECDSA signer.
   *
   * Wave 3.5 Phase 7 adds a DIFFERENT fallback shape: when the TN 403s on a
   * MuHavenToken balance handle, try `refreshDecryptGrant(ephemeralEOA)`
   * once and retry. This closes the `PERMIT_DECRYPT_LIFECYCLE §8 Q4` gap —
   * the balance holder's ACL grant was valid for a prior session EOA that
   * no longer exists (or never existed, for P2P recipients). See
   * `development/DEV_WAVE_3_5/DEV_LOG.md` 2026-04-24 Phase 7 entry.
   *
   * Callers can opt out of the refresh via `{ withRefresh: false }` — used
   * by the PUSDC decrypt path (where the token for the refresh doesn't
   * apply) and by unit tests that want raw 403 behaviour.
   */
  async function decryptForView(
    ctHash: bigint | string,
    bits: 64 | 128,
    opts: {
      withRefresh?: boolean
      tokenAddress?: `0x${string}`
      kind?: 'muHavenToken' | 'muHavenStable' | 'mhUsdcAudit'
    } = {},
  ): Promise<bigint> {
    const hashAsBigInt = typeof ctHash === 'bigint' ? ctHash : BigInt(ctHash)
    if (hashAsBigInt === 0n) return 0n

    const client = await ensureReady()
    const { FheTypes } = await import('@cofhe/sdk')
    const utype = bits === 64 ? FheTypes.Uint64 : FheTypes.Uint128

    const runDecrypt = () =>
      client.decryptForView(ctHash, utype).execute() as Promise<bigint>

    // Default `kind` — uint128 = MuHavenToken (Phase 7), uint64 = legacy
    // PUSDC (no refresh). Callers wanting the mhUSDC path pass
    // `kind: 'muHavenStable'` (or use `decryptMhUsdcForView`).
    const kind: 'muHavenToken' | 'muHavenStable' | 'mhUsdcAudit' | 'none' =
      opts.kind ?? (bits === 128 ? 'muHavenToken' : 'none')

    try {
      return await runDecrypt()
    } catch (e) {
      if (is403Error(e) && opts.withRefresh !== false && kind !== 'none') {
        // First defence — TN propagation lag. The on-chain `FHE.allow` was
        // already stamped on this handle at mint/transfer time per ADR-021,
        // but the Threshold Network reads ACL state with a multi-second sync
        // window. A click-Reveal that races the wrap tx confirmation gets
        // 403'd even though the grant exists on-chain. Sleeping ~2s and
        // re-trying the decrypt usually clears it without an on-chain tx.
        // Only fall through to the refresh-grant tx if this also 403s
        // (which means the current ephemeralEOA genuinely has no grant —
        // typically a cross-reload mismatch with the wrap-time EOA).
        const TN_PROPAGATION_DELAY_MS = 2000
        await new Promise(r => setTimeout(r, TN_PROPAGATION_DELAY_MS))
        try {
          return await runDecrypt()
        } catch (e2) {
          if (!is403Error(e2)) throw e2
          // Still 403 after the propagation window — fall through to the
          // on-chain refresh below.
        }

        // Second defence — refresh the ACL grant on-chain to the current
        // ephemeralEOA, then retry. Costs an on-chain tx but is silent
        // when `refreshDecryptGrant` is in `SESSION_PERMISSIONS` (it is,
        // for both MuHavenToken and MuHavenStable).
        try {
          const { address } = ensureEphemeralKey()
          if (kind === 'muHavenToken') {
            const { refreshDecryptGrant } = await import(
              '@/services/contracts/TokenService'
            )
            // Pass the per-RWA-token address when the caller knows it.
            // Wave 3.5 holdings live on per-token contracts (TBILL1,
            // GOLD1, …); refreshing the grant on the wrong contract is
            // a no-op against the actual handle. Falls back to the
            // Wave 3 default inside `refreshDecryptGrant` when omitted.
            await refreshDecryptGrant(
              address as `0x${string}`,
              opts.tokenAddress,
            )
          } else if (kind === 'muHavenStable') {
            const { refreshDecryptGrant, isAvailable } = await import(
              '@/services/contracts/MuHavenStableService'
            )
            if (!isAvailable()) {
              throw new Error(
                'MuHavenStable wrapper not configured for this build — '
                + 'cannot self-refresh ACL on the mhUSDC handle.',
              )
            }
            await refreshDecryptGrant(address as `0x${string}`)
          } else if (kind === 'mhUsdcAudit') {
            // Audit-row decrypt — the handle is a HISTORICAL Wrap/Unwrap
            // amount (frozen in the past). `refreshDecryptGrant` only
            // re-grants the live balance, so it'd be a no-op here. Use
            // `refreshAuditGrant(handle, eph)` instead — the contract's
            // `FHE.isAllowed(handle, msg.sender)` gate keeps strangers
            // out, so we don't need a separate auth check at the call site.
            const { refreshAuditGrant, isAvailable } = await import(
              '@/services/contracts/MuHavenStableService'
            )
            if (!isAvailable()) {
              throw new Error(
                'MuHavenStable wrapper not configured for this build — '
                + 'cannot self-refresh ACL on the audit handle.',
              )
            }
            // The cofhe SDK accepts both bigint and 0x-hex for ctHash,
            // but the contract's `refreshAuditGrant` expects a bytes32
            // hex string. Normalise either input shape.
            const handleHex = (
              typeof ctHash === 'string'
                ? ctHash
                : `0x${ctHash.toString(16).padStart(64, '0')}`
            ) as `0x${string}`
            await refreshAuditGrant(handleHex, address as `0x${string}`)
          }
          return await runDecrypt()
        } catch (refreshErr) {
          console.warn('[useFhe] refreshDecryptGrant fallback failed', refreshErr)
        }
      }
      if (is403Error(e)) {
        throw new Error(
          'Fhenix Threshold Network rejected the decrypt request (HTTP 403). '
          + 'This usually means the encrypted value does not exist on-chain yet, '
          + 'or the current session EOA has no ACL grant on this handle.',
        )
      }
      throw e
    }
  }

  async function getRawClient(): Promise<CofheClient> {
    return ensureReady()
  }

  /** Tear down the cofhe client + wipe the ephemeral key on logout. */
  function destroy(): void {
    if (cofheClient) {
      cofheClient.disconnect()
      cofheClient = null
    }
    ephemeralPrivateKey = null
    ephemeralAddress = null
    fheStore.reset()
  }

  return {
    // state
    isReady,
    isInitializing,
    error,
    currentStep,
    // actions
    initialize,
    getEphemeralEOA,
    encryptUint128,
    encryptUint64,
    encryptAddress,
    encryptBatch,
    decryptUint128ForView,
    decryptUint64ForView,
    decryptMhUsdcForView,
    decryptAuditHandleForView,
    getRawClient,
    destroy,
  }
}
