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

// ── Response types ──────────────────────────────────────────────────

export interface LatestNavDto {
  nav: string
  apy: string | null
  total_aum: string | null
  yield_rate: string | null
  source: string
  source_type: string
  source_timestamp: string | null
  fetched_at: string
}

export type AssetClass = 'treasury' | 'money_market' | 'private_credit' | 'real_estate' | 'other'
export type TokenStatus = 'active' | 'paused' | 'winding_down' | 'archived'
export type YieldStatus = 'pending' | 'claimable' | 'claimed' | 'expired'

export interface TokenResponseDto {
  id: string
  address: string
  name: string
  symbol: string
  issuer_address: string
  apy: string | null
  yield_schedule: string | null
  kyc_tier: number
  asset_class: AssetClass
  min_investment: string | null
  status: TokenStatus
  created_at: string
  updated_at: string
  latest_nav: LatestNavDto | null
}

export interface NavSnapshotDto {
  nav: string
  apy: string | null
  total_aum: string | null
  yield_rate: string | null
  source: string
  source_type: string
  source_timestamp: string | null
  fetched_at: string
}

export interface PortfolioPositionDto {
  token_address: string
  token_symbol: string
  last_synced_at: string | null
}

export interface YieldRecordDto {
  id: string
  distribution_id: number
  escrow_id: string | null
  token_address: string
  amount: string | null
  status: YieldStatus
  claimed_at: string | null
  created_at: string
}

export interface ActivityItemDto {
  id: string
  type: 'yield' | 'escrow'
  status: string
  token_address: string | null
  amount: string | null
  timestamp: string
}

export interface BalanceDto {
  wallet_address: string
  balance: string
  formatted_balance: string
  currency: string
  chain_id: number
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

// ── Token endpoints (public) ────────────────────────────────────────

export const tokensApi = {
  getAll(): Promise<{ tokens: TokenResponseDto[] }> {
    return request('/tokens')
  },

  getByAddress(address: string): Promise<TokenResponseDto> {
    return request(`/tokens/${address}`)
  },

  getNavHistory(
    address: string,
    range?: '1m' | '3m' | '6m' | '1y',
  ): Promise<{ snapshots: NavSnapshotDto[] }> {
    const params = range ? `?range=${range}` : ''
    return request(`/tokens/${address}/nav-history${params}`)
  },

  getLatestNav(address: string): Promise<NavSnapshotDto> {
    return request(`/tokens/${address}/nav/latest`)
  },
}

// ── Portfolio endpoint (auth) ───────────────────────────────────────

export const portfolioApi = {
  get(): Promise<{ positions: PortfolioPositionDto[]; total_tokens: number }> {
    return request('/portfolio', { auth: true })
  },
}

// ── Yields endpoint (auth) ──────────────────────────────────────────

export const yieldsApi = {
  getAll(opts?: {
    limit?: number
    offset?: number
    status?: YieldStatus
  }): Promise<{ items: YieldRecordDto[]; total: number }> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    if (opts?.status) params.set('status', opts.status)
    const qs = params.toString()
    return request(`/yields${qs ? `?${qs}` : ''}`, { auth: true })
  },
}

// ── Activity endpoint (auth) ────────────────────────────────────────

export const activityApi = {
  getAll(opts?: {
    limit?: number
    offset?: number
  }): Promise<{ items: ActivityItemDto[]; has_more: boolean }> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request(`/activity${qs ? `?${qs}` : ''}`, { auth: true })
  },
}

// ── Balance endpoint (auth) ─────────────────────────────────────────

export const balanceApi = {
  get(): Promise<BalanceDto> {
    return request('/balance', { auth: true })
  },
}

// ── Issuer response types ──────────────────────────────────────────

export interface IssuerStatsDto {
  total_aum: string | null
  total_investors: number
  weighted_apy: string | null
  active_tokens: number
  total_tokens: number
  total_yield_distributed: string | null
}

export interface PrepareDistributionDto {
  token_address: string
  amount: string
}

export interface PrepareDistributionResult {
  token_address: string
  token_name: string
  amount: string
}

export interface PrepareWhitelistResult {
  address: string
}

// ── Issuer endpoints (auth + issuer role) ──────────────────────────

export const issuerApi = {
  getStats(): Promise<IssuerStatsDto> {
    return request('/issuer/stats', { auth: true })
  },

  prepareDistribution(data: PrepareDistributionDto): Promise<PrepareDistributionResult> {
    return request('/issuer/distribute', {
      method: 'POST',
      body: data,
      auth: true,
    })
  },

  addToWhitelist(addresses: string[]): Promise<PrepareWhitelistResult> {
    return request('/issuer/whitelist', {
      method: 'POST',
      body: { addresses },
      auth: true,
    })
  },

  removeFromWhitelist(address: string): Promise<void> {
    return request(`/issuer/whitelist/${address}`, {
      method: 'DELETE',
      auth: true,
    })
  },
}

// ── Agent response types ───────────────────────────────────────────

export type AgentCardType = 'action' | 'data' | 'form' | 'status' | 'insight'

export interface AgentHistoryMessage {
  role: 'user' | 'agent'
  text: string
}

export interface AgentChatRequest {
  message: string
  history?: AgentHistoryMessage[]
  stream?: boolean
}

export interface AgentChatResponse {
  response: {
    text: string
    card_type?: AgentCardType
    card_data?: Record<string, unknown>
  }
}

// ── Agent endpoint (auth) ──────────────────────────────────────────

export const agentApi = {
  chat(data: AgentChatRequest): Promise<AgentChatResponse> {
    return request('/agent/chat', {
      method: 'POST',
      body: data,
      auth: true,
    })
  },
}
