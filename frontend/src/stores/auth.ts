import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getStoredTokens,
  setStoredTokens,
  clearStoredTokens,
  usersApi,
  type IssuerStatus,
  type MeTelegramLinkDto,
  type StoredTokens,
  type UserRole,
} from '@/services/api'

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null)
  const refreshToken = ref<string | null>(null)
  const expiresAt = ref<number>(0)
  const role = ref<UserRole>('investor')
  const walletAddress = ref<string | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  // Phase 9.A · Expansion (F2) — issuer onboarding gate. The JWT does
  // not carry `issuerStatus`; it's fetched from `/v1/users/me` after
  // login and on app hydrate. Default `unregistered` matches the
  // backend default and keeps router guards safe before the fetch
  // resolves.
  const issuerStatus = ref<IssuerStatus>('unregistered')
  const issuerDisplayName = ref<string | null>(null)
  // Plan A (2026-05-15) — current Telegram-link summary (or null when
  // unlinked). Populated from /me on hydrate + after a fresh link
  // consume. The sidebar pill + the LinkTelegramModal's linked-state
  // branch both read from here.
  const telegramLink = ref<MeTelegramLinkDto | null>(null)
  // Cache of the `/me` fetch promise. Router guards await this on
  // every navigation; reusing the resolved promise means we only hit
  // /me once per session (fresh login, or page reload). Cleared on
  // logout. Callers that need to invalidate (e.g. after wizard
  // completion) call `setIssuerStatus()` directly with the new value.
  let userMetaPromise: Promise<void> | null = null

  const isAuthenticated = computed(
    () => !!accessToken.value && Date.now() < expiresAt.value,
  )

  /** Hydrate from localStorage on app init */
  function hydrate(): boolean {
    const tokens = getStoredTokens()
    if (!tokens) return false

    // Token expired — clear and return false
    if (Date.now() >= tokens.expires_at) {
      clearStoredTokens()
      return false
    }

    accessToken.value = tokens.access_token
    refreshToken.value = tokens.refresh_token
    expiresAt.value = tokens.expires_at
    walletAddress.value = tokens.wallet_address || null
    role.value = tokens.role || 'investor'
    // Phase 9.A · Expansion (F2). Cached status survives page reload
    // so an approved issuer doesn't briefly hit the /apply-issuer
    // redirect while /me is in flight. Defaults to 'unregistered'
    // for tokens persisted before this field existed.
    issuerStatus.value = tokens.issuer_status ?? 'unregistered'
    return true
  }

  function setTokens(tokens: StoredTokens) {
    accessToken.value = tokens.access_token
    refreshToken.value = tokens.refresh_token
    expiresAt.value = tokens.expires_at
    walletAddress.value = tokens.wallet_address
    role.value = tokens.role
    error.value = null
    if (tokens.issuer_status !== undefined) {
      issuerStatus.value = tokens.issuer_status
    }
    setStoredTokens(tokens)
  }

  function setIssuerStatus(status: IssuerStatus, displayName?: string | null) {
    issuerStatus.value = status
    if (displayName !== undefined) issuerDisplayName.value = displayName
    // Persist to localStorage so the next page-load hydrates with the
    // correct status. Belt-and-suspenders: /me will also confirm.
    const tokens = getStoredTokens()
    if (tokens) setStoredTokens({ ...tokens, issuer_status: status })
  }

  /**
   * Fetch `/users/me` and cache `issuerStatus`. Idempotent and
   * memoized for the session — the resolved promise is reused on
   * every call so the router's `beforeEach` await is free after the
   * first hit. On failure (network / 401) the failed promise is
   * cleared so a later navigation retries; cached status values are
   * preserved (default `unregistered` is safe).
   *
   * Callers that need to invalidate after a known status flip (e.g.
   * the apply-issuer wizard returning `issuer_status: 'approved'`)
   * call `setIssuerStatus()` directly — that's the canonical update
   * path; refetching from /me would just confirm what we already
   * know.
   */
  function fetchUserMeta(): Promise<void> {
    if (userMetaPromise) return userMetaPromise
    if (!accessToken.value) return Promise.resolve()
    const inflight = (async () => {
      try {
        const me = await usersApi.me()
        issuerStatus.value = me.issuer_status
        issuerDisplayName.value = me.issuer_display_name ?? null
        // Plan A — telegram_link is `null` when unset; explicit
        // assignment avoids stale linked-state lingering after a
        // remote unlink.
        telegramLink.value = me.telegram_link ?? null
        // Refresh the localStorage cache so a future reload
        // hydrates with the latest server-side status.
        const tokens = getStoredTokens()
        if (tokens) setStoredTokens({ ...tokens, issuer_status: me.issuer_status })
      } catch {
        // Drop the cached promise on failure so the next navigation
        // retries (transient network blip, brief 401 mid-refresh).
        // The localStorage-cached status from a prior successful
        // fetch is preserved and keeps router guards correct.
        userMetaPromise = null
      }
    })()
    userMetaPromise = inflight
    return inflight
  }

  function clearAuth() {
    accessToken.value = null
    refreshToken.value = null
    expiresAt.value = 0
    walletAddress.value = null
    error.value = null
    issuerStatus.value = 'unregistered'
    issuerDisplayName.value = null
    telegramLink.value = null
    userMetaPromise = null
    clearStoredTokens()
  }

  /**
   * Plan A (2026-05-15) — invalidate the /me promise cache so the
   * next `fetchUserMeta()` call refetches. Used by the LinkTelegramModal
   * after a successful link consume or unlink so the sidebar pill
   * updates without a full reload.
   */
  function invalidateUserMeta() {
    userMetaPromise = null
  }

  return {
    // state
    accessToken,
    refreshToken,
    expiresAt,
    role,
    walletAddress,
    error,
    loading,
    issuerStatus,
    issuerDisplayName,
    telegramLink,
    // computed
    isAuthenticated,
    // actions
    hydrate,
    setTokens,
    setIssuerStatus,
    fetchUserMeta,
    invalidateUserMeta,
    clearAuth,
  }
})
