import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ZeroDevProvider } from '@/providers/zerodev/zerodev.provider'
import type { IWalletProvider, Call } from '@/providers/wallet-provider.interface'

const STORAGE_KEY = 'muhaven-wallet'

export const useWalletStore = defineStore('wallet', () => {
  const address = ref<string | null>(null)
  const connecting = ref(false)
  const error = ref<string | null>(null)

  let provider: IWalletProvider | null = null

  const connected = computed(() => !!address.value && !!provider)

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
    return provider.sendUserOperation(calls)
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

  /** Attempt to restore session from localStorage on app init. Fails silently. */
  async function tryReconnect(): Promise<void> {
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

  return {
    // state
    address,
    connecting,
    connected,
    error,
    // actions
    connect,
    register,
    disconnect,
    signMessage,
    sendUserOperation,
    tryReconnect,
  }
})
