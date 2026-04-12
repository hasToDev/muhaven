import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAppStore } from '@/stores/app'
import {
  authApi,
  type StoredTokens,
  type UserRole,
  type TokenResponse,
} from '@/services/api'
import { useRouter } from 'vue-router'

const CHAIN_ID = 421614 // Arbitrum Sepolia
const DOMAIN = window.location.host
const URI = window.location.origin

function buildSiweMessage(address: string, nonce: string, statement: string): string {
  const issuedAt = new Date().toISOString()
  return [
    `${DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${URI}`,
    `Version: 1`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

function tokenResponseToStored(res: TokenResponse, addr: string, role: UserRole): StoredTokens {
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    expires_at: Date.now() + res.expires_in * 1000,
    wallet_address: addr,
    role,
  }
}

export function useAuth() {
  const authStore = useAuthStore()
  const walletStore = useWalletStore()
  const appStore = useAppStore()
  const router = useRouter()

  const { isAuthenticated, role, walletAddress, error, loading } = storeToRefs(authStore)

  /**
   * Full login flow: connect wallet → request nonce → sign SIWE → verify → store JWT.
   * If wallet is already connected, skips the connect step.
   */
  async function login(mode: 'login' | 'register', r: UserRole, username?: string): Promise<void> {
    authStore.loading = true
    authStore.error = null
    try {
      // Step 1: Connect wallet (or register new passkey)
      let addr: string
      if (walletStore.connected && walletStore.address) {
        addr = walletStore.address
      } else if (mode === 'register') {
        if (!username) throw new Error('Username required for registration')
        addr = await walletStore.register(username)
      } else {
        addr = await walletStore.connect()
      }

      // Step 2: Request nonce from backend
      const { nonce } = await authApi.getNonce(addr)

      // Step 3: Build and sign SIWE message
      const message = buildSiweMessage(
        addr,
        nonce,
        'Sign in to MuHaven — your confidential RWA portfolio.',
      )
      const signature = await walletStore.signMessage(message)

      // Step 4: Verify with backend → receive JWT
      const tokenRes = await authApi.verify({
        wallet_address: addr,
        message,
        signature,
        role: r,
        wallet_provider: 'zerodev',
      })

      // Step 5: Store tokens and update state
      const stored = tokenResponseToStored(tokenRes, addr, r)
      authStore.setTokens(stored)
      appStore.setRole(r)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Authentication failed'
      authStore.error = msg
      throw e
    } finally {
      authStore.loading = false
    }
  }

  /** Logout: call backend, clear local state, disconnect wallet, redirect to /login */
  async function logout(): Promise<void> {
    try {
      if (authStore.isAuthenticated) {
        await authApi.logout().catch(() => {})
      }
    } finally {
      authStore.clearAuth()
      await walletStore.disconnect()
      router.push('/login')
    }
  }

  /** Refresh access token using stored refresh token */
  async function refreshToken(): Promise<boolean> {
    const rt = authStore.refreshToken
    if (!rt) return false

    try {
      const tokenRes = await authApi.refresh(rt)
      const stored = tokenResponseToStored(
        tokenRes,
        authStore.walletAddress ?? '',
        authStore.role,
      )
      authStore.setTokens(stored)
      return true
    } catch {
      authStore.clearAuth()
      return false
    }
  }

  /**
   * Switch role via silent re-auth.
   * Wallet is already connected — just sign a new SIWE message with the new role.
   */
  async function switchRole(newRole: UserRole): Promise<void> {
    if (!walletStore.connected || !walletStore.address) {
      throw new Error('Wallet not connected')
    }

    authStore.loading = true
    authStore.error = null
    try {
      const addr = walletStore.address
      const { nonce } = await authApi.getNonce(addr)

      const message = buildSiweMessage(
        addr,
        nonce,
        `Switch to ${newRole} role on MuHaven.`,
      )
      const signature = await walletStore.signMessage(message)

      const tokenRes = await authApi.verify({
        wallet_address: addr,
        message,
        signature,
        role: newRole,
        wallet_provider: 'zerodev',
      })

      const stored = tokenResponseToStored(tokenRes, addr, newRole)
      authStore.setTokens(stored)
      appStore.setRole(newRole)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Role switch failed'
      authStore.error = msg
      throw e
    } finally {
      authStore.loading = false
    }
  }

  /**
   * Initialize auth on app load.
   * Hydrates from localStorage. If tokens are valid, restores session.
   * If expired, attempts refresh. If all fails, user stays unauthenticated.
   */
  async function initialize(): Promise<void> {
    if (authStore.hydrate()) {
      // Tokens loaded from storage and still valid — try to reconnect wallet
      if (walletStore.address || localStorage.getItem('muhaven-wallet')) {
        await walletStore.tryReconnect()
      }
      return
    }

    // Tokens expired or missing — try refresh
    const refreshed = await refreshToken()
    if (refreshed && localStorage.getItem('muhaven-wallet')) {
      await walletStore.tryReconnect()
    }
  }

  return {
    // state
    isAuthenticated,
    role,
    walletAddress,
    error,
    loading,
    // actions
    login,
    logout,
    refreshToken,
    switchRole,
    initialize,
  }
}
