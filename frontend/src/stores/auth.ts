import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getStoredTokens,
  setStoredTokens,
  clearStoredTokens,
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
    return true
  }

  function setTokens(tokens: StoredTokens) {
    accessToken.value = tokens.access_token
    refreshToken.value = tokens.refresh_token
    expiresAt.value = tokens.expires_at
    walletAddress.value = tokens.wallet_address
    role.value = tokens.role
    error.value = null
    setStoredTokens(tokens)
  }

  function clearAuth() {
    accessToken.value = null
    refreshToken.value = null
    expiresAt.value = 0
    walletAddress.value = null
    error.value = null
    clearStoredTokens()
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
    // computed
    isAuthenticated,
    // actions
    hydrate,
    setTokens,
    clearAuth,
  }
})
