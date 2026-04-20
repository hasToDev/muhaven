import { storeToRefs } from 'pinia'
import { useFheStore } from '@/stores/fhe'
import { useWalletStore } from '@/stores/wallet'
import type { EncryptableItem, EncryptedItemInput } from '@cofhe/sdk'

// ── Module-level singleton ──────────────────────────────────────────
// The cofhe client is a complex stateful object — stored outside Pinia
// to avoid deep reactivity. The store only tracks flags (isReady, error).

type CofheClient = Awaited<ReturnType<typeof import('@cofhe/sdk/web').createCofheClient>>

let cofheClient: CofheClient | null = null
let initPromise: Promise<void> | null = null

// ── Lazy SDK import ─────────────────────────────────────────────────
// Import @cofhe/sdk/web only when needed to avoid loading tfhe WASM
// on pages that don't need FHE (e.g., landing, login).

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

// Re-export for consumers that need to build batch items
export type { EncryptableItem, EncryptedItemInput }

// ── Composable ──────────────────────────────────────────────────────

export function useFhe() {
  const fheStore = useFheStore()
  const walletStore = useWalletStore()

  const { isReady, isInitializing, error, currentStep } = storeToRefs(fheStore)

  /**
   * Initialize the cofhe client.
   * Connects to the CoFHE coprocessor and loads TFHE WASM.
   *
   * Does NOT create a self-permit here — permit creation is deferred to the
   * first `decryptXxxForView` call via `ensurePermit()`. Creating a permit at
   * login time bound it to the kernel's counterfactual address *before* the
   * kernel had any code, which caused Fhenix ACL to reject the signature
   * (`PermissionInvalid_IssuerSignature`) when verifying via ERC-1271 later.
   * Idempotent — if already initialized or in progress, returns the existing promise.
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

    // After a page reload, the provider module-level state is gone even
    // though the wallet address is restored from localStorage. Trigger a
    // lazy passkey reconnect so getViemClients() can produce valid clients.
    // Matches the pattern used by sendUserOperation / signMessage.
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
      const { createCofheClient, createCofheConfig, arbSepolia } = await loadSdk()

      const config = createCofheConfig({
        supportedChains: [arbSepolia],
      })

      const client = createCofheClient(config)

      await client.connect(clients.publicClient as any, clients.walletClient as any)

      // Self-permit creation is deferred — see ensurePermit() below. We used
      // to call `client.permits.getOrCreateSelfPermit()` here, but for ZeroDev
      // kernel accounts this signed a permit against the counterfactual
      // address before the kernel was deployed, which later failed ACL
      // verification via ERC-1271.

      cofheClient = client
      fheStore.setReady()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'FHE initialization failed'
      fheStore.setError(msg)
      throw e
    }
  }

  /** Ensure the client is ready, waiting for init if in progress */
  async function ensureReady(): Promise<CofheClient> {
    if (cofheClient) return cofheClient
    if (initPromise) {
      await initPromise
      if (cofheClient) return cofheClient
    }
    // Not initialized and no init in progress — try now
    await initialize()
    if (!cofheClient) throw new Error('FHE client not initialized')
    return cofheClient
  }

  /**
   * Ensure a valid self-permit exists for the current account, creating one
   * lazily if needed. Called by the decrypt* helpers, never eagerly.
   *
   * Guards: the kernel smart account must have code on-chain before signing
   * the permit — otherwise the signature is bound to an un-deployed address
   * and later fails ACL verification via ERC-1271.
   *
   * When `forceRefresh` is true we remove any existing active permit and
   * sign a fresh one. Used by the decrypt retry path when the first attempt
   * trips `PermissionInvalid_IssuerSignature` (stale counterfactual-era
   * permit from a prior session).
   */
  async function ensurePermit(forceRefresh = false): Promise<void> {
    const client = await ensureReady()

    const address = walletStore.address
    if (!address) throw new Error('Wallet not connected')

    const clients = walletStore.getViemClients()
    if (!clients) throw new Error('Wallet not connected')

    // Verify the kernel has code. Pre-deploy counterfactual signing is the
    // root cause of `PermissionInvalid_IssuerSignature` — bail with a clear
    // message so the UI can prompt the user to make their first tx first.
    const code = await clients.publicClient.getCode({
      address: address as `0x${string}`,
    })
    if (!code || code === '0x') {
      throw new Error(
        'Your smart account is not yet deployed on-chain. Complete your first '
        + 'transaction (e.g. the first encrypted mint) before decrypting — '
        + 'permits signed pre-deploy fail Fhenix ACL verification.',
      )
    }

    if (forceRefresh) {
      const existing = client.permits.getActivePermit()
      if (existing) {
        client.permits.removeActivePermit()
      }
      await client.permits.createSelf({})
      return
    }

    // Idempotent: returns the existing active permit if one is already set.
    await client.permits.getOrCreateSelfPermit()
  }

  /**
   * Detect the ACL signature-verification failure so the decrypt retry path
   * can force a fresh permit and try again. Matches the upstream revert name
   * and selector `0x4c40eccb` from `Permissioned.sol`.
   */
  function isIssuerSignatureError(e: unknown): boolean {
    const raw = e instanceof Error ? e.message : String(e)
    return /PermissionInvalid_IssuerSignature/.test(raw)
      || /0x4c40eccb/.test(raw)
      || /Failed to verify ACL/i.test(raw)
  }

  /** Detect a TN HTTP 403 — signals an unknown / non-existent ctHash. */
  function is403Error(e: unknown): boolean {
    const raw = e instanceof Error ? e.message : String(e)
    return /HTTP 403/.test(raw) || /403 \(Forbidden\)/.test(raw) || /Forbidden/i.test(raw)
  }

  /**
   * Encrypt a uint128 value (for token transfers, mints, approvals).
   * Returns the encrypted input struct matching Solidity's InEuint128.
   */
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

  /**
   * Encrypt a uint64 value (for risk params, yield amounts, PUSDC).
   * Returns the encrypted input struct matching Solidity's InEuint64.
   */
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

  /**
   * Encrypt an address (for escrow creation).
   * Returns the encrypted input struct matching Solidity's InEaddress.
   */
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

  /**
   * Encrypt multiple values in a single batch.
   * More efficient than individual calls — shares ZK proof computation.
   *
   * Usage:
   *   const { Encryptable } = await import('@cofhe/sdk')
   *   const [amt, risk1, risk2] = await encryptBatch([
   *     Encryptable.uint128(1000n),
   *     Encryptable.uint64(500n),
   *     Encryptable.uint64(200n),
   *   ])
   */
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

  /**
   * Decrypt a ciphertext handle for view (UI display only).
   * Uses the self-permit created during initialization.
   * No on-chain transaction needed — purely client-side via CoFHE coprocessor.
   */
  async function decryptUint128ForView(ctHash: bigint | string): Promise<bigint> {
    return decryptForViewWithRetry(ctHash, 128)
  }

  /**
   * Decrypt a euint64 ciphertext handle for view (UI display only).
   * Used for PUSDC confidential balances (6-decimal unsigned 64-bit).
   */
  async function decryptUint64ForView(ctHash: bigint | string): Promise<bigint> {
    return decryptForViewWithRetry(ctHash, 64)
  }

  /**
   * Shared decrypt path with lazy permit + one retry on IssuerSignature.
   * First attempt uses any existing active permit; on ACL-signature failure
   * we invalidate the permit (which was likely signed pre-deploy), create
   * a fresh one against the now-deployed kernel, and retry once.
   *
   * Short-circuits on a zero ctHash — the handle a confidential-balance-style
   * view returns when the account has never received a ciphertext. TN answers
   * 403 for such handles, so skip the network round-trip and return 0n.
   */
  async function decryptForViewWithRetry(
    ctHash: bigint | string,
    bits: 64 | 128,
  ): Promise<bigint> {
    // Zero handle = no ciphertext exists (e.g. PUSDC.confidentialBalanceOf
    // on an account that only holds public PUSDC). Returning 0n matches
    // the semantics the user expects and avoids a TN 403.
    const hashAsBigInt = typeof ctHash === 'bigint' ? ctHash : BigInt(ctHash)
    if (hashAsBigInt === 0n) return 0n

    const client = await ensureReady()
    const { FheTypes } = await import('@cofhe/sdk')
    const utype = bits === 64 ? FheTypes.Uint64 : FheTypes.Uint128

    await ensurePermit(false)

    try {
      return (await client
        .decryptForView(ctHash, utype)
        .execute()) as bigint
    } catch (e) {
      if (isIssuerSignatureError(e)) {
        // Stale permit (counterfactual-era signature). Re-sign against the
        // now-deployed kernel and try once more.
        await ensurePermit(true)
        return (await client
          .decryptForView(ctHash, utype)
          .execute()) as bigint
      }
      // 403 from TN usually means the requested ctHash is unknown to the
      // coprocessor (zero handle, not-yet-committed, or ACL-denied). Translate
      // to a clearer message rather than leaking the raw HTTP status upstream.
      if (is403Error(e)) {
        throw new Error(
          'Fhenix Threshold Network rejected the decrypt request (HTTP 403). '
          + 'This usually means the encrypted value does not exist on-chain yet.',
        )
      }
      throw e
    }
  }

  /**
   * Return the raw cofhe client for consumers that need direct access
   * (e.g. passing to `new MuHavenClient({ cofheClient, ... })`). Ensures
   * the client is initialized + connected before returning.
   */
  async function getRawClient(): Promise<CofheClient> {
    return ensureReady()
  }

  /** Tear down the cofhe client (on logout / disconnect) */
  function destroy(): void {
    if (cofheClient) {
      cofheClient.disconnect()
      cofheClient = null
    }
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
    encryptUint128,
    encryptUint64,
    encryptAddress,
    encryptBatch,
    decryptUint128ForView,
    decryptUint64ForView,
    getRawClient,
    destroy,
  }
}
