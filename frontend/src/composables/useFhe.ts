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
   * Connects to the CoFHE coprocessor, loads TFHE WASM, and creates a self-permit.
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

      // Create self-permit for decrypting own values
      const address = walletStore.address
      if (address) {
        await client.permits.getOrCreateSelfPermit()
      }

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
    const client = await ensureReady()
    const { FheTypes } = await import('@cofhe/sdk')

    return client
      .decryptForView(ctHash, FheTypes.Uint128)
      .execute() as Promise<bigint>
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
    getRawClient,
    destroy,
  }
}
