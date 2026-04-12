/**
 * Typed fetch wrapper for MuHaven backend API.
 * Zero dependencies — uses native fetch with token injection and 401 refresh.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://nagreg.hasto.dev/api/v1'

const TOKEN_KEY = 'muhaven-auth-tokens'

// ── Auth API types ──────────────────────────────────────────────────

export type UserRole = 'investor' | 'issuer'
export type WalletProvider = 'zerodev' | 'walletconnect' | 'injected'

export interface NonceResponse {
  nonce: string
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
}

// ── Token storage ───────────────────────────────────────────────────

export interface StoredTokens {
  access_token: string
  refresh_token: string
  expires_at: number // unix ms
  wallet_address: string
  role: UserRole
}

export function getStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(TOKEN_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setStoredTokens(tokens: StoredTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
}

export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export interface VerifyWalletRequest {
  wallet_address: string
  message: string
  signature: string
  role: UserRole
  wallet_provider?: WalletProvider
  email?: string
}

// ── Fetch wrapper ───────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`)
    this.name = 'ApiError'
  }
}

let refreshPromise: Promise<StoredTokens | null> | null = null

async function refreshAccessToken(): Promise<StoredTokens | null> {
  const tokens = getStoredTokens()
  if (!tokens?.refresh_token) return null

  try {
    const res = await fetch(`${BASE_URL}/auth/tokens/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    })

    if (!res.ok) {
      clearStoredTokens()
      return null
    }

    const data: TokenResponse = await res.json()
    const stored: StoredTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      wallet_address: tokens.wallet_address,
      role: tokens.role,
    }
    setStoredTokens(stored)
    return stored
  } catch {
    clearStoredTokens()
    return null
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  auth?: boolean
  headers?: Record<string, string>
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = false, headers: extra } = opts

  const headers: Record<string, string> = { ...extra }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (auth) {
    const tokens = getStoredTokens()
    if (tokens?.access_token) {
      headers['Authorization'] = `Bearer ${tokens.access_token}`
    }
  }

  let res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  // 401 → try refresh once, then retry
  if (res.status === 401 && auth) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken()
    }
    const refreshed = await refreshPromise
    refreshPromise = null

    if (refreshed) {
      headers['Authorization'] = `Bearer ${refreshed.access_token}`
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    }
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null)
    throw new ApiError(res.status, errorBody)
  }

  // 204 No Content
  if (res.status === 204) return undefined as T

  return res.json()
}

// ── Auth endpoints ──────────────────────────────────────────────────

export const authApi = {
  getNonce(walletAddress: string): Promise<NonceResponse> {
    return request('/auth/wallet/nonce', {
      method: 'POST',
      body: { wallet_address: walletAddress },
    })
  },

  verify(data: VerifyWalletRequest): Promise<TokenResponse> {
    return request('/auth/wallet/verify', {
      method: 'POST',
      body: data,
    })
  },

  refresh(refreshToken: string): Promise<TokenResponse> {
    return request('/auth/tokens/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })
  },

  logout(): Promise<void> {
    return request('/auth/tokens/', {
      method: 'DELETE',
      auth: true,
    })
  },
}
