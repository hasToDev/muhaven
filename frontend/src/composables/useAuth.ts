import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAppStore } from '@/stores/app'
import {
  ApiError,
  authApi,
  type StoredTokens,
  type UserRole,
  type TokenResponse,
} from '@/services/api'
import { useRouter } from 'vue-router'

/**
 * Phase 9.A · role guardrail. Backend rejects login when the
 * submitted role doesn't match the wallet's registered role with
 * a structured 403 carrying:
 *   `{ status: 403, body: { details: { code: 'ROLE_MISMATCH',
 *      registeredRole: 'investor' | 'issuer' } } }`.
 * The login form catches this class and auto-flips its role toggle.
 */
export class RoleMismatchError extends Error {
  constructor(public readonly registeredRole: UserRole) {
    super(`Wallet registered as ${registeredRole}`)
    this.name = 'RoleMismatchError'
  }
}

function isRoleMismatch(err: unknown): RoleMismatchError | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null
  const body = err.body as { details?: { code?: string; registeredRole?: string } } | null
  const detail = body?.details
  if (detail?.code !== 'ROLE_MISMATCH') return null
  if (detail.registeredRole !== 'investor' && detail.registeredRole !== 'issuer') return null
  return new RoleMismatchError(detail.registeredRole)
}

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

/**
 * Phase 9.A · Expansion (F2). Wipe every Pinia store that holds
 * user-scoped data so the next sign-in (logout → login OR silent
 * JWT-expiry → relogin-as-different-user) doesn't inherit the prior
 * session's cached state. The latent bug pattern: pages that gate
 * `onMounted` with `if (store.loaded) return` never re-fetch after a
 * re-login, so the prior user's tokens / portfolio / activity rows
 * render for the wrong wallet. Dynamic imports keep these out of the
 * auth-only bundle path. Best-effort — a missing module (store never
 * instantiated this session) is ignored.
 */
async function tearDownUserStores(): Promise<void> {
  await Promise.allSettled([
    import('@/stores/issuer-onboarding').then((m) => m.useIssuerOnboardingStore().tearDown()),
    import('@/stores/issuer-tokens').then((m) => m.useIssuerTokensStore().reset()),
    import('@/stores/issuer-investors').then((m) => m.useIssuerInvestorsStore().reset()),
    import('@/stores/issuer-compliance').then((m) => m.useIssuerComplianceStore().reset()),
    import('@/stores/issuer-distribution').then((m) => m.useIssuerDistributionStore().reset()),
    import('@/stores/epochs').then((m) => m.useEpochsStore().reset()),
    import('@/stores/portfolio').then((m) => m.usePortfolioStore().reset()),
    import('@/stores/activity').then((m) => m.useActivityStore().reset()),
    import('@/stores/marketplace').then((m) => m.useMarketplaceStore().reset()),
  ])
}

/**
 * Decode the role claim from a JWT access token. The backend embeds
 * `role` in the payload (verify-wallet.use-case → JwtService.generateTokenPair).
 * Used on login when the client didn't pre-pick a role and needs to
 * pin `appStore.role` + the stored token's role to whatever the
 * server returned.
 */
function decodeRoleFromJwt(accessToken: string): UserRole | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    if (decoded.role === 'investor' || decoded.role === 'issuer') return decoded.role
    return null
  } catch {
    return null
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
   *
   * `role` is REQUIRED on register (the backend has no existing user
   * record to defer to) and OPTIONAL on login (the wallet's stored role
   * is the source of truth; the verify response carries it back via the
   * JWT payload).
   */
  async function login(
    mode: 'login' | 'register',
    role: UserRole | undefined,
    username?: string,
  ): Promise<void> {
    if (mode === 'register' && !role) {
      throw new Error('Role is required for registration')
    }
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
        'Sign in to MuHaven - your confidential RWA portfolio.',
      )
      const signature = await walletStore.signMessage(message)

      // Step 4: Verify with backend → receive JWT
      let tokenRes: TokenResponse
      try {
        tokenRes = await authApi.verify({
          wallet_address: addr,
          message,
          signature,
          // Omit `role` on login when undefined — the backend uses the
          // wallet's stored role. Always send on register so the new
          // user record gets the user's pick.
          ...(role !== undefined ? { role } : {}),
          wallet_provider: 'zerodev',
        })
      } catch (verifyErr) {
        // Phase 9.A · role guardrail — surface ROLE_MISMATCH as a typed
        // error so the login form can auto-flip its role toggle to the
        // registered role without inspecting raw HTTP body.
        const mismatch = isRoleMismatch(verifyErr)
        if (mismatch) throw mismatch
        throw verifyErr
      }

      // Phase 9.A · Expansion (F2). Wipe user-scoped store caches
      // BEFORE setting the new tokens — covers the silent-JWT-expiry
      // path where `useAuth.logout()` never ran (no explicit signout)
      // but the user is now authenticating as a different wallet. If
      // we skipped this and just relied on the logout teardown, the
      // first /tokens / /portfolio mount post-relogin would render
      // the prior user's cached rows.
      await tearDownUserStores()

      // Step 5: Store tokens and update state. On register the role we
      // sent is canonical; on login we read it back from the JWT
      // payload (server-side source of truth).
      const effectiveRole: UserRole =
        role ?? decodeRoleFromJwt(tokenRes.access_token) ?? 'investor'
      const stored = tokenResponseToStored(tokenRes, addr, effectiveRole)
      authStore.setTokens(stored)
      appStore.setRole(effectiveRole)

      // Phase 9.A · Expansion (F2). Fetch /me to populate
      // `issuerStatus` so the LoginPage redirect + router guards can
      // route an unregistered issuer to /apply-issuer. Awaited so the
      // caller's redirect logic sees the resolved status. For a fresh
      // register (first-ever login of a new passkey), the user row was
      // just created server-side with `issuerStatus='unregistered'`;
      // /me returns that immediately.
      await authStore.fetchUserMeta()

      // FHE client is initialized lazily on first encrypt/decrypt call
      // (via useFhe.ensureReady()) to avoid the self-permit passkey prompt
      // during the register/login flow.
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
      // Tear down FHE client (dynamic import to access the module-level singleton)
      try {
        const { useFhe } = await import('@/composables/useFhe')
        useFhe().destroy()
      } catch { /* FHE may not have been initialized */ }
      await tearDownUserStores()
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
      // Phase 9.A · Expansion (F2). Carry the cached issuer status
      // across the refresh so router guards stay coherent.
      stored.issuer_status = authStore.issuerStatus
      authStore.setTokens(stored)
      return true
    } catch {
      authStore.clearAuth()
      return false
    }
  }

  /**
   * Initialize auth on app load.
   * Hydrates from localStorage. If tokens are valid, restores session.
   * If expired, attempts refresh. If all fails, user stays unauthenticated.
   *
   * Side effect: kicks off `/users/me` to populate `issuerStatus` (Phase
   * 9.A · F2). The fetch promise lives on the auth store so the router
   * `beforeEach` can await it and avoid flashing a guarded page before
   * the redirect resolves. Awaited here so the very first navigation
   * already sees the resolved status.
   */
  async function initialize(): Promise<void> {
    if (authStore.hydrate()) {
      // Phase 9.A · role guardrail. Sync `appStore.role` to the
      // hydrated `authStore.role` so navigation chrome (Sidebar /
      // TopNav / mobile bar) renders the correct role on every
      // reload. Without this, `appStore.role` defaults to
      // 'investor' and the path-watcher (now removed) was the
      // legacy compensation for the gap.
      if (authStore.role) appStore.setRole(authStore.role)
      // Tokens loaded from storage and still valid — restore wallet address
      // without triggering a passkey prompt. The provider reconnects lazily
      // via ensureConnected() when the user performs an on-chain action.
      // FHE client also initializes lazily on first encrypt/decrypt.
      walletStore.restoreAddress()
      await authStore.fetchUserMeta()
      return
    }

    // Tokens expired or missing — try refresh
    const refreshed = await refreshToken()
    if (refreshed) {
      if (authStore.role) appStore.setRole(authStore.role)
      walletStore.restoreAddress()
      await authStore.fetchUserMeta()
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
    initialize,
  }
}
