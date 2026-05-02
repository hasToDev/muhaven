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
  // Phase 9.A · role guardrail. Optional on login (the backend uses
  // the wallet's stored role); required on register (backend throws
  // 400 when omitted for a new wallet).
  role?: UserRole
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

export interface TokenResponseDto {
  id: string
  address: string
  name: string
  symbol: string
  issuer_address: string
  /**
   * Phase 9.A · Expansion (F3) — issuer display name from KYB submission.
   * Null when the issuer wallet predates the F2 wizard onboarding (older
   * demo issuers); UI falls back to a formatted address.
   */
  issuer_display_name: string | null
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

/**
 * Phase 9.A · Option Z (Option C single-source) — `/activity` reads
 * `tax_events` only. New shape covers buy/sell/yield + cash-conversion
 * (wrap/unwrap) rows. Wrap/Unwrap rows carry the encrypted amount handle
 * in `metadata.encrypted_amount_handle`; the frontend decrypts via permit
 * on click.
 */
export type ActivityItemType =
  | 'buy'
  | 'sell'
  | 'sell-queued'
  | 'yield'
  | 'wrap'
  | 'unwrap'
  | 'fee'
  // Phase 9.A · Option Z follow-up — P2P share transfers. Two rows per
  // qualifying event (sender + recipient), keyed in tax_events by
  // holder_address with `metadata.direction` distinguishing the
  // perspective.
  | 'transfer-out'
  | 'transfer-in'

export interface ActivityItemMetadata {
  /** 'wrap' | 'unwrap' | 'transfer' | 'instant' | 'queued' | 'escalated_to_queue' */
  kind?: string
  /**
   * Phase 9.A · Option Z follow-up — Transfer rows: 'outbound' (sender's
   * row) or 'inbound' (recipient's row).
   */
  direction?: 'outbound' | 'inbound'
  /**
   * Phase 9.A · Option Z follow-up — Transfer rows: the OTHER party's
   * address (recipient on outbound, sender on inbound).
   */
  counterparty?: string
  /**
   * bytes32 hex — encrypted amount handle. Wrap/Unwrap rows: cofhe
   * euint64. Transfer rows: cofhe euint128 (per-RWA share amount).
   */
  encrypted_amount_handle?: string | null
  /** Ephemeral EOA recorded at the wrap/unwrap call site (informational). */
  ephemeral_eoa?: string | null
  /** Free-form additional fields the backend may attach; never amounts. */
  [k: string]: unknown
}

export interface ActivityItemDto {
  id: string
  type: ActivityItemType
  status: 'confirmed' | 'queued' | 'claimed' | 'pending'
  token_address: string | null
  amount: string | null // always null post-Option-Z — values stay encrypted
  timestamp: string
  /** On-chain tx hash. Always present post-Option-Z (every row is from tax_events). */
  tx_hash: string
  metadata?: ActivityItemMetadata | null
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
    return request('/auth/tokens', {
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

  addPosition(tokenAddress: string, tokenSymbol: string): Promise<{ status: string }> {
    return request('/portfolio', {
      method: 'POST',
      auth: true,
      body: { token_address: tokenAddress, token_symbol: tokenSymbol },
    })
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

  /**
   * Phase 9.A · multi-issuer scoping. Returns ONLY the tokens whose
   * `rwa_tokens.issuer_address` matches the connected kernel (server
   * derives the address from the JWT; client cannot pass a different
   * value). Drives the issuer Tokens dashboard + the Distribute
   * page's token dropdown.
   *
   * Investor-side `/marketplace` continues to call the public
   * `tokensApi.getAll()` — investors must see every active token.
   */
  getTokens(): Promise<{ tokens: TokenResponseDto[] }> {
    return request('/issuer/tokens', { auth: true })
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

// ── Issuer onboarding (Phase 9.A · Expansion F2) ───────────────────

export type IssuerStatus = 'unregistered' | 'pending' | 'approved' | 'suspended'

export interface ApplyIssuerRequest {
  display_name: string
  jurisdiction: string
  contact_email: string
  attestation: 'kyb_skipped'
}

export interface ApplyIssuerResponse {
  user: {
    id: string
    wallet_address: string
    role: 'issuer'
    issuer_status: 'approved'
    issuer_display_name: string
    issuer_jurisdiction: string
    issuer_approved_at: string
  }
  tokens: TokenResponse
}

export type DeployStepKey =
  | 'deploy_token'
  | 'deploy_queue'
  | 'deploy_treasury'
  | 'wire_token_pointers'
  | 'authorize_investor_registry'
  | 'authorize_compliance_callers'
  | 'configure_oracle'
  | 'register_token'

export const DEPLOY_STEPS: readonly DeployStepKey[] = [
  'deploy_token',
  'deploy_queue',
  'deploy_treasury',
  'wire_token_pointers',
  'authorize_investor_registry',
  'authorize_compliance_callers',
  'configure_oracle',
  'register_token',
]

export interface DeployTokenRequest {
  symbol: string
  name: string
  asset_class: AssetClass
  initial_nav: string
  min_investment: string
  yield_schedule: 'monthly' | 'quarterly' | 'annual'
}

export interface DeployTokenAccepted {
  deploy_id: string
  status: 'running'
}

export interface DeployTokenStatus {
  id: string
  symbol: string
  status: 'running' | 'succeeded' | 'failed'
  last_step: DeployStepKey | null
  result_token_address: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export interface DeployStreamEvent {
  step: DeployStepKey | 'finalize'
  status: 'pending' | 'sent' | 'mined' | 'succeeded' | 'failed'
  txHash?: string
  contractAddress?: string
  resultTokenAddress?: string
  errorMessage?: string
  ts: string
}

/**
 * Phase 9.A · Expansion (F2) — typed error for the apply endpoint's
 * 403 HAS_INVESTOR_ACTIVITY response. Mirrors `RoleMismatchError`'s
 * shape; the wizard intercepts to show a "register a new kernel"
 * banner instead of a raw `403`.
 */
export class HasInvestorActivityError extends Error {
  constructor(public readonly source: 'portfolios' | 'tax_events') {
    super(`Wallet has investor activity (${source})`)
    this.name = 'HasInvestorActivityError'
  }
}

export const issuerOnboardingApi = {
  apply(req: ApplyIssuerRequest): Promise<ApplyIssuerResponse> {
    return request('/issuer/apply', {
      method: 'POST',
      body: req,
      auth: true,
    })
  },

  startDeploy(req: DeployTokenRequest): Promise<DeployTokenAccepted> {
    return request('/issuer/tokens/deploy', {
      method: 'POST',
      body: req,
      auth: true,
    })
  },

  getDeploy(deployId: string): Promise<DeployTokenStatus> {
    return request(`/issuer/tokens/deploy/${deployId}`, { auth: true })
  },

  /**
   * Open an SSE channel for a deploy. EventSource doesn't accept
   * Authorization headers, so the access token rides on the URL query
   * (`?access_token=…`). The backend handler accepts both forms.
   *
   * Returns the EventSource and a parsed-event handler. Caller is
   * responsible for `.close()` on unmount.
   */
  streamDeploy(
    deployId: string,
    onEvent: (event: DeployStreamEvent) => void,
    onError?: (err: Event) => void,
  ): EventSource {
    const tokens = getStoredTokens()
    const token = tokens?.access_token ?? ''
    const url = `${BASE_URL}/issuer/tokens/deploy/${deployId}/events?access_token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    const parse = (raw: MessageEvent) => {
      try {
        onEvent(JSON.parse(raw.data))
      } catch {
        // ignore malformed events (heartbeat comments don't fire as message)
      }
    }
    es.addEventListener('step', parse as EventListener)
    es.addEventListener('finalize', parse as EventListener)
    if (onError) es.addEventListener('error', onError)
    return es
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

// ── Demo endpoints ─────────────────────────────────────────────────

export interface WhitelistSelfResult {
  whitelisted: boolean
  accredited: boolean
  whitelistTxHash: string | null
  accreditTxHash: string | null
  alreadyComplete: boolean
  // Demo shortcut: investor-granted MINTER_ROLE on MuHavenToken so the
  // current DepositPage encrypted-mint path (`TokenService.mint`) works.
  // In Wave 3.5 this is removed — Subscription holds MINTER_ROLE and
  // investors never do.
  minterGranted: boolean
  minterTxHash: string | null
  minterError: string | null
}

export const demoApi = {
  whitelistSelf(): Promise<WhitelistSelfResult> {
    return request('/demo/whitelist-self', {
      method: 'POST',
      body: {},
      auth: true,
    })
  },
}
