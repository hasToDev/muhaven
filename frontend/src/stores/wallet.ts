import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ZeroDevProvider } from '@/providers/zerodev/zerodev.provider'
import type {
  IWalletProvider,
  Call,
  ViemClients,
  ExportedSessionKey,
  InstallScopedSessionInput,
  ScopedSessionInstallResult,
} from '@/providers/wallet-provider.interface'

const STORAGE_KEY = 'muhaven-wallet'

export const useWalletStore = defineStore('wallet', () => {
  const address = ref<string | null>(null)
  const connecting = ref(false)
  const error = ref<string | null>(null)

  // Reactive mirror of the provider's session-key state. Updated by the
  // store wrapper around sendUserOperation so UI components (TopNav pill,
  // DistributePage hint) stay in sync without polling the provider.
  const sessionKeyActive = ref(false)
  const sessionExpirySec = ref(0)

  let provider: IWalletProvider | null = null

  const connected = computed(() => !!address.value)
  const providerReady = computed(() => !!address.value && !!provider)

  function refreshSessionState(): void {
    if (!provider || typeof provider.hasSessionKey !== 'function') {
      sessionKeyActive.value = false
      sessionExpirySec.value = 0
      return
    }
    sessionKeyActive.value = provider.hasSessionKey()
    sessionExpirySec.value = provider.getSessionExpirySeconds?.() ?? 0
  }

  function persistAddress(addr: string | null) {
    if (addr) {
      localStorage.setItem(STORAGE_KEY, addr)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  function getSavedAddress(): string | null {
    return localStorage.getItem(STORAGE_KEY)
  }

  async function connect(): Promise<string> {
    connecting.value = true
    error.value = null
    try {
      const p = new ZeroDevProvider()
      const addr = await p.connect()
      provider = p
      address.value = addr
      persistAddress(addr)
      return addr
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      error.value = msg
      throw e
    } finally {
      connecting.value = false
    }
  }

  async function register(username: string): Promise<string> {
    connecting.value = true
    error.value = null
    try {
      const p = new ZeroDevProvider()
      const addr = await p.register(username)
      provider = p
      address.value = addr
      persistAddress(addr)
      return addr
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Registration failed'
      error.value = msg
      throw e
    } finally {
      connecting.value = false
    }
  }

  async function disconnect(): Promise<void> {
    if (provider) {
      await provider.disconnect()
    }
    provider = null
    address.value = null
    error.value = null
    sessionKeyActive.value = false
    sessionExpirySec.value = 0
    persistAddress(null)
  }

  async function signMessage(message: string): Promise<string> {
    await ensureConnected()
    if (!provider) throw new Error('No wallet connected')
    return provider.signMessage(message)
  }

  async function sendUserOperation(calls: Call[]): Promise<string> {
    await ensureConnected()
    if (!provider) throw new Error('No wallet connected')
    try {
      return await provider.sendUserOperation(calls)
    } finally {
      refreshSessionState()
    }
  }

  async function installSessionKey(): Promise<void> {
    await ensureConnected()
    if (!provider || typeof provider.installSessionKey !== 'function') {
      throw new Error('Session keys not supported by this provider')
    }
    try {
      await provider.installSessionKey()
    } finally {
      refreshSessionState()
    }
  }

  /**
   * Wave 4 Q1 — surface the session-key private half once for out-of-band
   * copy (install on the broker via `muhaven-broker update --session <key>`,
   * or paste into the daemon's `MUHAVEN_BROKER_SESSION_KEY`). Mints
   * a fresh in-memory record if none exists; does NOT trigger an on-chain
   * UserOp. Returns null when the underlying provider has no session
   * support (currently only ZeroDevProvider implements it).
   */
  async function exportSessionKey(): Promise<ExportedSessionKey | null> {
    await ensureConnected()
    if (!provider || typeof provider.exportSessionKeyPrivateHalf !== 'function') {
      throw new Error('Session keys not supported by this provider')
    }
    try {
      return await provider.exportSessionKeyPrivateHalf()
    } finally {
      refreshSessionState()
    }
  }

  /**
   * Wave 5 Path D Slice 1 Pickup A — mint a Scoped session key.
   *
   * Returns the freshly-minted ephemeral EOA's private half + the
   * locally-computed `permissionId` so the caller can:
   *   1. POST the snapshot to `/api/v1/agent/policy/scoped-session`, and
   *   2. surface the privateKey via SessionKeyRevealModal as a one-paste
   *      `muhaven-broker update --session <key>` command (raw key still
   *      offered for env-var / stdin workflows).
   *
   * Independent from `installSessionKey()` (legacy in-tab path) —
   * `sessionKeyActive` / `sessionExpirySec` track only the in-tab key
   * (Scoped lives on a separate signer EOA the broker owns).
   */
  async function installScopedSessionKey(
    opts: InstallScopedSessionInput,
  ): Promise<ScopedSessionInstallResult | null> {
    await ensureConnected()
    if (!provider || typeof provider.installScopedSessionKey !== 'function') {
      throw new Error('Scoped session keys not supported by this provider')
    }
    return provider.installScopedSessionKey(opts)
  }

  let reconnectPromise: Promise<void> | null = null

  async function ensureConnected(): Promise<void> {
    if (provider) return
    if (!getSavedAddress()) throw new Error('No wallet connected')

    if (reconnectPromise) {
      await reconnectPromise
      return
    }

    reconnectPromise = reconnect()
    try {
      await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function reconnect(): Promise<void> {
    const p = new ZeroDevProvider()
    const addr = await p.connect()
    provider = p
    address.value = addr
    persistAddress(addr)
  }

  /** Restore wallet address from localStorage without triggering a passkey prompt. */
  function restoreAddress(): void {
    const saved = getSavedAddress()
    if (saved) address.value = saved
  }

  /** Attempt to restore session from localStorage on app init. Fails silently. */
  async function tryReconnect(): Promise<void> {
    // Already connected — skip reconnect (avoids extra passkey prompt after register/login)
    if (provider && address.value) return

    const saved = getSavedAddress()
    if (!saved) return

    connecting.value = true
    try {
      await reconnect()
    } catch {
      // Passkey prompt was dismissed or session expired — clear stale state
      persistAddress(null)
      address.value = null
    } finally {
      connecting.value = false
    }
  }

  function getViemClients(): ViemClients | null {
    if (!provider) return null
    return provider.getViemClients()
  }

  return {
    // state
    address,
    connecting,
    connected,
    providerReady,
    error,
    sessionKeyActive,
    sessionExpirySec,
    // actions
    connect,
    register,
    disconnect,
    signMessage,
    sendUserOperation,
    installSessionKey,
    exportSessionKey,
    installScopedSessionKey,
    getViemClients,
    restoreAddress,
    tryReconnect,
    refreshSessionState,
    // Exposed so callers that need viem clients (e.g. useFhe.initialize)
    // can lazy-reconnect the provider after a page reload — same pattern
    // signMessage and sendUserOperation use internally.
    ensureConnected,
  }
})
