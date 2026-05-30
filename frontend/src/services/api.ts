/**
 * Typed fetch wrapper for MuHaven backend API.
 * Zero dependencies — uses native fetch with token injection and 401 refresh.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.muhaven.app/api/v1'

export const TOKEN_KEY = 'muhaven-auth-tokens'

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
  // Phase 9.A · Expansion (F2). Cached so a page-reload doesn't bounce
  // an approved issuer to /apply-issuer while the /me fetch is in
  // flight (or if it fails on a transient network blip). Refreshed
  // every time `/me` resolves and on apply-issuer success. Optional
  // for backward-compat with localStorage payloads written before
  // this field existed.
  issuer_status?: 'unregistered' | 'pending' | 'approved' | 'suspended'
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

/**
 * Custom DOM event fired AFTER `setStoredTokens` writes a fresh token
 * payload to `localStorage`. Long-lived primitives that ride along with
 * a JWT (e.g., the `EventSource` opened by `openclawIntentEventsApi.open`,
 * which encodes `?access_token=…` in the URL and cannot rotate the
 * token mid-connection) listen for this event and tear down + reopen
 * with the latest token. Cross-tab rotation also triggers this on
 * receivers via the native `storage` event, but same-tab rotation does
 * NOT fire `storage` per the spec — hence this explicit dispatch.
 */
export const AUTH_TOKENS_ROTATED_EVENT = 'muhaven:auth-tokens-rotated'

export function setStoredTokens(tokens: StoredTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
  // Same-tab listeners — `storage` event is cross-tab only by spec.
  // A no-op when `window` is undefined (SSR / Node test environments).
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKENS_ROTATED_EVENT))
  }
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
    super(extractApiErrorMessage(status, body))
    this.name = 'ApiError'
  }
}

/**
 * Surface the backend's RFC-7807 problem-detail `title` (or `detail`)
 * as the error message when available so user-facing toasts read
 * "webhook url must be http:// or https://" instead of the unhelpful
 * "API error 400". Falls back to "API error <status>" when the body
 * doesn't carry a structured message.
 *
 * §5 walkthrough operator feedback 2026-05-1?: webhook register form
 * surfaced `API error 400` for the SSRF guard rejection. The friendly
 * message was sitting in `body.title` unused.
 */
function extractApiErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title : null
    const detail = typeof b.detail === 'string' ? b.detail : null
    if (title && detail) return `${title} — ${detail}`
    if (title) return title
    if (detail) return detail
  }
  return `API error ${status}`
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
      // Phase 9.A · Expansion (F2). Preserve cached issuer status
      // across token refresh so the router guard doesn't briefly
      // regress to the default 'unregistered' for an approved
      // issuer mid-session.
      issuer_status: tokens.issuer_status,
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
  /**
   * Wave 5+ per-token YieldSnapshot proxy address (2026-05-23).
   * `null` for legacy tokens deployed before per-token snapshots
   * shipped — those tokens resolve to the singleton snapshot proxy
   * via `getYieldSnapshot()` fallback. Tokens deployed through the
   * F2 wizard always populate this.
   */
  yield_snapshot_address: string | null
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
  /**
   * Event-specific reference id. For yield rows = `epochId` (used by the
   * decoupled-decrypt path on /activity to resolve YieldSnapshot.getEpoch
   * + getSnapshotBalance). For redemption rows = queue request id. Null
   * for wrap/transfer/fee.
   */
  reference_id?: string | null
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

// ── Current user (auth) ─────────────────────────────────────────────

/** Plan A (2026-05-15) — Telegram-link summary surfaced on /me. */
export interface MeTelegramLinkDto {
  linked: true
  telegram_chat_id: string
  telegram_username: string | null
  linked_at: string
}

export interface MeResponseDto {
  id: string
  wallet_address: string
  wallet_provider: string
  role: UserRole
  email?: string
  created_at: string
  // Phase 9.A · Expansion (F2) — drives the issuer onboarding route
  // guard + the conditional sidebar nav item. JWT does not carry this;
  // /me is the source of truth and is fetched on login + on hydrate.
  issuer_status: 'unregistered' | 'pending' | 'approved' | 'suspended'
  issuer_display_name?: string
  issuer_jurisdiction?: string
  issuer_approved_at?: string
  // Plan A — `null` when no active Telegram link. Optional in the wire
  // shape so a frontend that pre-dates Plan A doesn't crash on absence.
  telegram_link?: MeTelegramLinkDto | null
}

export const usersApi = {
  me(): Promise<MeResponseDto> {
    return request('/users/me', { auth: true })
  },
}

// ── Device-code (Wave 4 P3 ADR-3) ──────────────────────────────────

export interface DeviceCodeRequesterMetadata {
  processName: string
  hostname: string
  os: string
}

export interface DeviceAuthorizeResponse {
  status: 'authorized' | 'denied' | 'expired' | 'pending' | 'consumed'
  requesterMetadata: DeviceCodeRequesterMetadata
}

export interface DeviceLookupResponse {
  userCode: string
  requesterMetadata: DeviceCodeRequesterMetadata
  expiresAt: string
}

// ── OpenClaw / Telegram intent (Wave 4 P4) ──────────────────────────

export interface OpenClawIntentSummary {
  intentId: string
  kind: 'buy' | 'claim'
  tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink'
  status: 'pending' | 'confirmed' | 'consumed' | 'denied' | 'expired'
  amountUsd6: string
  payload: { token: string; summary: string; issuerLabel?: string; escrowId?: string }
  intentHash: string
  expiresAt: string
  createdAt: string
}

export interface TelegramLinkIssueResponse {
  linkCode: string
  expiresInSec: number
  botStartUrl: string | null
}

export const openClawApi = {
  lookupIntent(intentId: string): Promise<OpenClawIntentSummary> {
    return request(`/agent/openclaw/intent/lookup?intentId=${encodeURIComponent(intentId)}`, {
      method: 'GET',
      auth: true,
    })
  },

  /**
   * Confirm an intent. For >$5K (passkey_deeplink) tier the backend
   * requires a non-empty `passkeyAssertion` blob — Wave 4 accepts a
   * placeholder string ("wave4-stub"); Wave 5 swaps the value for a
   * real WebAuthn assertion. The wire shape stays stable across the
   * upgrade so callers can be migrated without an API break.
   */
  confirmIntent(
    intentId: string,
    opts?: { passkeyAssertion?: string },
  ): Promise<{ intent: OpenClawIntentSummary }> {
    return request('/agent/openclaw/intent/confirm', {
      method: 'POST',
      auth: true,
      body: {
        intentId,
        ...(opts?.passkeyAssertion ? { passkeyAssertion: opts.passkeyAssertion } : {}),
      },
    })
  },

  denyIntent(intentId: string, reason?: string): Promise<{ intent: { intentId: string; status: string; deniedAt?: string } }> {
    return request('/agent/openclaw/intent/deny', {
      method: 'POST',
      auth: true,
      body: { intentId, ...(reason ? { reason } : {}) },
    })
  },

  issueTelegramLink(): Promise<TelegramLinkIssueResponse> {
    return request('/agent/openclaw/link/issue', {
      method: 'POST',
      auth: true,
    })
  },

  /**
   * Plan A (2026-05-15) — dashboard-driven unlink. With `chatId`
   * unlinks just that chat; without, unlinks every active row owned
   * by the calling user (the typical sidebar-pill UX).
   */
  unlinkTelegram(opts?: { chatId?: string }): Promise<{ unlinkedCount: number }> {
    return request('/agent/openclaw/link/unlink', {
      method: 'POST',
      auth: true,
      body: opts?.chatId ? { telegramChatId: opts.chatId } : {},
    })
  },
}

export const deviceFlowApi = {
  /**
   * Look up a pending device-code's requesterMetadata so the /link page
   * can show process/host/OS BEFORE the user taps Authorize. This is the
   * load-bearing phishing mitigation (ADR-3 D4) — never skip it.
   */
  lookup(userCode: string): Promise<DeviceLookupResponse> {
    return request(`/auth/device/lookup?code=${encodeURIComponent(userCode.toUpperCase())}`, {
      method: 'GET',
      auth: true,
    })
  },

  /**
   * Authorize (or deny) a device-code on behalf of the authenticated user.
   * Used by the dashboard `/link?code=ABCD-1234` route.
   */
  authorize(userCode: string, opts?: { deny?: boolean; denyReason?: string }):
    Promise<DeviceAuthorizeResponse> {
    return request('/auth/device/authorize', {
      method: 'POST',
      auth: true,
      body: {
        userCode: userCode.toUpperCase(),
        ...(opts?.deny ? { deny: true } : {}),
        ...(opts?.denyReason ? { denyReason: opts.denyReason } : {}),
      },
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

// ── Oracle (Wave 5 Q1) — rwa.xyz-sourced metadata + snapshots ────────
//
// Public reads, no auth. Returns canonical case-preserved ticker
// regardless of input case. Backed by the `token_metadata` /
// `oracle_snapshots` / `oracle_timeseries` tables (see
// `backend/src/infrastructure/repository/postgres/schema.ts`). Values
// are returned as strings to preserve `numeric(N,M)` precision —
// callers parse client-side at render time.

export interface OracleUnderlyingTokenDto {
  network: string
  network_id: number | null
  address: string
  decimals: number
  standards: string[] | null
}

export interface OracleSnapshotInlineDto {
  snapshot_at: string
  nav_dollar: string | null
  price_dollar: string | null
  apy_7_day: string | null
  total_asset_value_dollar: string | null
  holding_addresses_count: number | null
}

export interface OracleTokenListItemDto {
  ticker: string
  display_name: string
  description: string | null
  icon_url: string | null
  color_hex: string | null
  is_yield_bearing: boolean
  is_yield_bearing_rwaxyz: boolean
  asset_class_slug: string | null
  asset_class_name: string | null
  issuer_name: string | null
  issuer_country: string | null
  pm_subscription_minimum_dollar: string | null
  pm_subscription_frequency: string | null
  inception_date: string | null
  last_refreshed_at: string
  latest_snapshot: OracleSnapshotInlineDto | null
}

export interface OracleTokenMetadataDto {
  ticker: string
  display_name: string
  description: string | null
  icon_url: string | null
  color_hex: string | null
  website: string | null
  is_yield_bearing: boolean
  is_yield_bearing_rwaxyz: boolean
  distributes_income: boolean | null
  asset_class_slug: string | null
  asset_class_name: string | null
  issuer_name: string | null
  issuer_legal_name: string | null
  issuer_lei: string | null
  issuer_country: string | null
  manager_name: string | null
  jurisdiction_country: string | null
  regulatory_framework: string | null
  governing_body: string | null
  legal_structure: string | null
  inception_date: string | null
  fee_management_bps: number | null
  fee_performance_bps: number | null
  fee_structure_description: string | null
  pm_subscription_frequency: string | null
  pm_subscription_minimum_dollar: string | null
  pm_redemption_frequency: string | null
  pm_kyc_required: boolean | null
  underlying_tokens: OracleUnderlyingTokenDto[] | null
  /**
   * Distinct timeseries measure slugs available for this ticker. The
   * chart's measure toggle disables buttons for slugs not in this set.
   * Empty array means metadata-only state (no timeseries ingested).
   */
  published_measures: string[]
  last_refreshed_at: string
}

export interface OracleSnapshotDto {
  ticker: string
  snapshot_at: string
  source: string
  nav_dollar: string | null
  price_dollar: string | null
  apy_7_day: string | null
  apy_30_day: string | null
  daily_yield_rate: string | null
  yield_to_maturity_percent: string | null
  daily_yield_distributed_dollar: string | null
  hypothetical_10k_performance: string | null
  total_supply_token: string | null
  total_asset_value_dollar: string | null
  market_value_dollar: string | null
  holding_addresses_count: number | null
  top_5_holder_concentration: string | null
  rwaxyz_updated_at: string | null
}

export interface OracleTimeseriesDto {
  ticker: string
  measure_slug: string
  from: string | null
  to: string | null
  count: number
  points: Array<{ date: string; value: string; unit: string | null }>
}

export const oracleApi = {
  list(): Promise<{ tokens: OracleTokenListItemDto[] }> {
    return request('/oracle/tokens')
  },

  getMetadata(ticker: string): Promise<OracleTokenMetadataDto> {
    return request(`/oracle/tokens/${encodeURIComponent(ticker)}/metadata`)
  },

  getLatestSnapshot(ticker: string): Promise<OracleSnapshotDto> {
    return request(`/oracle/tokens/${encodeURIComponent(ticker)}/snapshot/latest`)
  },

  getTimeseries(
    ticker: string,
    measure: string,
    range?: { from?: string; to?: string },
  ): Promise<OracleTimeseriesDto> {
    const params = new URLSearchParams({ measure })
    if (range?.from) params.set('from', range.from)
    if (range?.to) params.set('to', range.to)
    return request(`/oracle/tokens/${encodeURIComponent(ticker)}/timeseries?${params}`)
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
  // Wave 5+ per-token YieldSnapshot binding (2026-05-23) — mirror of
  // the backend's `DeployStepKey` widening. Keeps the wizard's progress
  // rail (DEPLOY_STEP_LABELS in ApplyPage.vue) and the SSE handler's
  // step-name switch in sync with the SSE events the deploy library
  // emits. Order matters: progress rail renders in this order.
  | 'deploy_yield_snapshot'
  | 'grant_trusted_payer'
  | 'wire_token_pointers'
  | 'authorize_investor_registry'
  | 'authorize_compliance_callers'
  | 'configure_oracle'
  | 'register_token'

export const DEPLOY_STEPS: readonly DeployStepKey[] = [
  'deploy_token',
  'deploy_queue',
  'deploy_treasury',
  'deploy_yield_snapshot',
  'grant_trusted_payer',
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

// ── Wave 4 P2 — HavenBot tool surface + streaming chat ────────────
//
// These are the LLM-facing tool endpoints. The chat-stream endpoint
// returns a long-lived SSE response that the `useAgentChat` composable
// consumes via fetch + ReadableStream (NOT EventSource — POST + stream).

export type Tier = 'advisory' | 'confirm-per-action' | 'policy-bound' | 'paused' | 'scoped'
export type Surface = 'havenbot' | 'mcp' | 'openclaw' | 'checkout'

export interface ActionDescriptor {
  kind:
    | 'buy'
    | 'claim'
    | 'rebalance'
    | 'set_policy'
    | 'pause'
    | 'resume'
    // Wave 4 §5 Path C — hosted-checkout session via agent
    | 'create_checkout'
    // Wave 4 P7 issuer-side propose tools. Backend mints these descriptors
    // (see backend/src/application/dto/agent/tool.dto.ts:432+). Phase 2
    // (2026-05-20) adds `distribute_yield` — runner drives the
    // MuHavenClient.distributeYield 3-stage pipeline (startDistribution →
    // createYieldEscrows → fundEscrows) and reports progress via the
    // shared `useAgentDistributeProgress` bus the ConfirmModal subscribes to.
    | 'unpause_token'
    | 'kyc_add'
    | 'kyc_remove'
    | 'distribute_yield'
  toolCallId: string
  confirmTokenId: string
  expiresAtSec: number
  summary: string
  preview: Record<string, unknown>
  sdkCall: {
    contractName: string
    functionName: string
    args: Record<string, unknown>
  }
}

/**
 * Wave 4 §5 Path C — typed mirror of backend's `CommitCreateCheckoutActionPayloadSchema`.
 *
 * Third-pass review (CodeReviewer LOW-3 promoted): frontend's
 * `extractActionPayload` was previously typed as `Record<string, unknown>` —
 * a stray field rename in the propose use-case would silently break every
 * commit with a 403 hash mismatch at runtime. Pin the shape here so any
 * field rename / addition forces a coordinated frontend bump at compile
 * time. Mirror this exactly on backend: `commit-create-checkout.use-case.ts`.
 */
export interface CreateCheckoutActionPayload {
  tool: 'muhaven_propose_create_checkout'
  action: 'create_checkout'
  tokenAddress: string
  amountUsd6: string
  memo: string | null
  successUrl: string | null
  cancelUrl: string | null
  issuerAddress: string
  requestedAtSec: number
}

export type AgentStreamEvent =
  | { type: 'meta'; model: string; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName: string
      ok: boolean
      result?: unknown
      error?: string
    }
  | { type: 'suggestions'; items: AgentSuggestionItem[] }
  | { type: 'done'; finishReason: 'stop' | 'tool_loop_exhausted' | 'error' }
  | { type: 'error'; message: string }

/** Backend-driven ActionCard chip — `label` drives the visible text
 *  + the `handleAction` re-prompt; `variant` styles the chip. The
 *  backend produces these from the most recent tool dispatch outcome
 *  (see `infrastructure/agent/suggestion-builder.ts`) so the chips
 *  reflect what actually happened on the turn. */
export interface AgentSuggestionItem {
  label: string
  variant?: 'primary' | 'secondary' | 'ghost'
}

export interface AgentChatStreamRequest {
  message: string
  history?: AgentHistoryMessage[]
}

export interface CommitToolActionRequest {
  surface?: Surface
  actionKind: 'permit_grant' | 'tier_transition'
  actionPayload: Record<string, unknown>
  confirmToken: string
  txHash: string | null
  metadata?: Record<string, unknown>
}

export interface CommitToolActionResponse {
  consumed: true
  auditEventId: string
}

export const agentToolsApi = {
  /** Open a long-lived SSE stream. Caller iterates the events via
   *  the `events` async generator and aborts via the returned controller. */
  async openChatStream(
    data: AgentChatStreamRequest,
    abortController: AbortController,
  ): Promise<{ events: AsyncGenerator<AgentStreamEvent>; release: () => void }> {
    const tokens = getStoredTokens()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (tokens?.access_token) {
      headers['Authorization'] = `Bearer ${tokens.access_token}`
    }
    const res = await fetch(`${BASE_URL}/agent/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: abortController.signal,
    })
    if (!res.ok || !res.body) {
      const errBody = await res.json().catch(() => null)
      throw new ApiError(res.status, errBody)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    async function* events(): AsyncGenerator<AgentStreamEvent> {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // SSE blocks separate by \n\n. Parse every full block.
          // On user-driven abort (AbortController.abort), partially
          // received blocks in `buf` are silently dropped — by design;
          // the user explicitly cancelled the turn. Reader.read()
          // rejects with AbortError on the next iteration.
          while (true) {
            const idx = buf.indexOf('\n\n')
            if (idx < 0) break
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (!payload) continue
              try {
                yield JSON.parse(payload) as AgentStreamEvent
              } catch {
                // ignore malformed; SSE comments / heartbeats etc.
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    }
    const release = (): void => {
      try {
        abortController.abort()
      } catch {
        /* noop */
      }
    }
    return { events: events(), release }
  },

  // Per-tool REST endpoints — also callable directly (e.g., for
  // the onboarding wizard's first-buy step which doesn't go through
  // the LLM at all).
  portfolioSummary(args: { tokenAddress?: string }): Promise<unknown> {
    return request('/agent/tools/portfolio_summary', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  quote(args: { tokenAddress: string; notionalUsd6: string }): Promise<unknown> {
    return request('/agent/tools/quote', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  proposeBuy(args: {
    tokenAddress: string
    shares: string
    maxSharesHint?: string
  }): Promise<ActionDescriptor> {
    return request('/agent/tools/propose_buy', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  proposeClaim(args: { yieldRecordId: string }): Promise<ActionDescriptor> {
    return request('/agent/tools/propose_claim', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  /**
   * Wave 5 Slice 3 — mint a hash-bound rebalance confirm token over EXPLICIT
   * legs. The browser computes the legs client-side (drift = decrypted
   * balances × public NAV vs. saved targets — see `useRebalance.ts`) and
   * passes them here; the backend hashes the legs into the confirm token so
   * the ConfirmModal preview + audit-commit are cryptographically pinned to
   * exactly what the user approves. (Calling propose_rebalance with NO legs
   * returns a client-compute directive instead — handled in `useAgentChat`.)
   */
  proposeRebalance(args: {
    legs: Array<{
      kind: 'sell' | 'buy'
      tokenAddress: string
      shares: string
      maxSharesHint?: string
    }>
  }): Promise<ActionDescriptor> {
    return request('/agent/tools/propose_rebalance', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  pause(args: { surface?: Surface }): Promise<ActionDescriptor> {
    return request('/agent/tools/pause', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  unsealPosition(args: {
    handle: string
    signerHint?: 'session' | 'master'
  }): Promise<{ tool: 'muhaven_unseal_position'; handle: string; signerHint: string; decryptInstruction: string }> {
    return request('/agent/tools/unseal_position', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  commit(data: CommitToolActionRequest): Promise<CommitToolActionResponse> {
    return request('/agent/tools/commit', {
      method: 'POST',
      body: data,
      auth: true,
    })
  },
}

// ── Wave 4 Q1 — agent policy (tier transition + reveal) ──────────

/**
 * Mirror of backend `AgentUserStateDto` in
 * `backend/src/application/dto/agent/policy.dto.ts`. Source of truth lives
 * on the backend; this shape only carries the fields the dashboard
 * /agent/policy/transition page consumes (tier picker + step-up gates).
 */
export interface AgentUserStateDto {
  userId: string
  surface: Surface
  tier: Tier
  pausedAt: string | null
  pauseTrigger: string | null
  pauseMetadata: Record<string, unknown> | null
  enteredAt: string
  validatorAddress: string | null
  confirmedActionCount: number
  riskQuestionnaireComplete: boolean
  updatedAt: string
}

export interface PolicyStateResponseDto {
  surfaces: AgentUserStateDto[]
}

export interface TierTransitionConfirmation {
  token: string
  actionHash: string
  expiresAt: string
}

/**
 * Backend `/policy/transition` returns one of two shapes depending on
 * whether the requested transition is a step-up (requires passkey-bound
 * confirmation token) or a step-down (auto-applies). The state-machine
 * (see backend `transition-tier.use-case.ts`) decides which is which.
 */
export type RequestTierTransitionResponse =
  | { requiresConfirmation: true; confirmation: TierTransitionConfirmation }
  | { requiresConfirmation: false; state: AgentUserStateDto }

export interface CommitTierTransitionResponse {
  state: AgentUserStateDto
}

export const agentPolicyApi = {
  getState(): Promise<PolicyStateResponseDto> {
    return request('/agent/policy/state', { method: 'GET', auth: true })
  },

  /**
   * Phase 1 of the two-phase transition. Returns either:
   *   - `requiresConfirmation: false` for step-downs (apply immediately), OR
   *   - `requiresConfirmation: true` for step-ups, carrying a single-use
   *     confirmation token the caller must re-post via `commitTransition`.
   */
  requestTransition(args: {
    surface: Surface
    targetTier: Tier
  }): Promise<RequestTierTransitionResponse> {
    return request('/agent/policy/transition', {
      method: 'POST',
      body: { surface: args.surface, targetTier: args.targetTier },
      auth: true,
    })
  },

  /**
   * Phase 2 — re-post with the confirmation token returned in phase 1.
   * Backend re-validates the state machine before consuming the token,
   * so a stale token against a concurrently-changed state still fails.
   */
  commitTransition(args: {
    surface: Surface
    targetTier: Tier
    confirmationToken: string
  }): Promise<CommitTierTransitionResponse> {
    return request('/agent/policy/transition', {
      method: 'POST',
      body: {
        surface: args.surface,
        targetTier: args.targetTier,
        confirmationToken: args.confirmationToken,
      },
      auth: true,
    })
  },

  /**
   * Resume from a paused surface. Per ADR-0 §"Allowed transitions" the
   * post-pause landing is always Advisory — the user must re-traverse
   * Confirm → PolicyBound to regain autonomy. Backend's
   * ResumeAgentUseCase enforces the only-resumable-from-paused gate.
   */
  resume(args: { surface: Surface }): Promise<CommitTierTransitionResponse> {
    return request('/agent/policy/resume', {
      method: 'POST',
      body: { surface: args.surface },
      auth: true,
    })
  },

  /**
   * Wave 5 Path D Slice 1 Pickup A — POST a Scoped policy snapshot to the
   * backend mirror (`agent_scoped_sessions` table). Mirrors
   * `MintScopedSessionDtoSchema` in `backend/src/application/dto/agent/
   * policy.dto.ts` byte-for-byte:
   *   - `snapshot.consentActionHash` MUST be 0x-prefixed (Zod
   *     `HEX_32_BYTE_RE`). Frontend derives it by prepending `0x` to the
   *     Phase-1 ConfirmToken's bare-hex `actionHash`.
   *   - `selectorCaps[i].maxAmount` is in SHARES (selector-native unit
   *     for subscription.purchase per RD-6), NOT mhUSDC base-6.
   *   - `maxPerOpUsd6` is the user-intent mhUSDC base-6 ceiling — distinct
   *     from `selectorCaps[i].maxAmount`.
   *   - `permissionId` is REQUIRED — 4-byte 0x-prefixed lowercase hex
   *     (backend Zod gate `^0x[0-9a-f]{8}$`). Pickup B threads it so
   *     the broker can compose the Kernel v3.1 24-byte nonce-key
   *     composite. History: Pickup A omitted as smoke checkpoint
   *     (`no_permission_id_in_snapshot`); Pickup B closes the gate.
   *   - `surface: 'mcp'` is the operator-confirmed lock — surface is the
   *     autonomy SCOPE (broker / MCP), not the configuration UI.
   *
   * Backend pre-conditions enforced (per `MintScopedSessionUseCase`):
   *   1. user must currently be at tier='scoped' for this surface (commit
   *      `transition` first; this endpoint inherits its confirmation gate);
   *   2. no existing active row for `(userId, surface)`;
   *   3. `validUntilSec > now`;
   *   4. `mintedAtSec` within ±5 min of server now.
   */
  mintScopedSession(args: MintScopedSessionRequest): Promise<MintScopedSessionResponse> {
    return request('/agent/policy/scoped-session', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },

  /**
   * Wave 5 Option D · Commit 4 — read the latest ACTIVE Scoped session
   * for a surface (the backend's `GetActiveScopedSessionUseCase`). Returns
   * `{ session: null }` when none is active. Scoped sessions are always
   * minted under `surface: 'mcp'` (hard-locked at mint), so callers pass
   * `'mcp'`. The GET route's `mcp.read.*` scope is satisfied by the
   * dashboard's passkey JWT via the with-scope legacy-token fallback.
   */
  getActiveScopedSession(args: { surface: Surface }): Promise<GetActiveScopedSessionResponse> {
    return request(
      `/agent/policy/scoped-session?surface=${encodeURIComponent(args.surface)}`,
      { method: 'GET', auth: true },
    )
  },

  /**
   * Wave 5 Option D · Commit 4 — revoke (soft-revoke) a Scoped session by
   * id. Flips the mirror row to `status='revoked'`; the broker daemon
   * still holds the on-disk snapshot until the operator restarts it
   * (surfaced in the revoke UX). The existing DELETE route is
   * ownership-checked server-side (masks others' ids as 404) and emits
   * the `ScopedSessionRevoked` audit event. 409 when already terminal.
   */
  revokeScopedSession(args: { sessionId: string }): Promise<RevokeScopedSessionResponse> {
    return request(
      `/agent/policy/scoped-session/${encodeURIComponent(args.sessionId)}`,
      { method: 'DELETE', auth: true },
    )
  },

  /**
   * Wave 5 Slice 2c — toggle the auto-reinvest opt-in on the caller's
   * active MCP Scoped session (the Autonomy-page switch). POSTs
   * `{ enabled }` to `/agent/reinvest`; the backend flips `reinvest_enabled`
   * + returns the updated session row. 404 when there is no active session
   * to toggle. The keyless `muhaven-reinvest` runner reads this flag via
   * the `should-run` gate, so the loop never claims+buys without consent.
   */
  setReinvestEnabled(args: { enabled: boolean }): Promise<SetReinvestEnabledResponse> {
    return request('/agent/reinvest', {
      method: 'POST',
      body: { enabled: args.enabled },
      auth: true,
    })
  },
}

// ── Wave 5 Path D Slice 1 — Scoped session mint shapes ─────────────

export interface ScopedSelectorCap {
  /** 0x-prefixed 4-byte hex (lowercased on backend). */
  selector: `0x${string}`
  /** 0-based word index after the 4-byte selector. */
  capArgIndex: number | null
  /** uint256 decimal string. Null iff capArgIndex is null. Selector-native
   *  unit (SHARES for subscription.purchase, NOT mhUSDC base-6). */
  maxAmount: string | null
}

export interface PolicySnapshotMintBody {
  sessionId: string
  mode: 'scoped'
  signerAddress: `0x${string}`
  targetContracts: readonly `0x${string}`[]
  selectorCaps: readonly ScopedSelectorCap[]
  /** Epoch seconds — must be > server now. */
  validUntilSec: number
  /** Epoch seconds — must be within ±5min of server now. */
  mintedAtSec: number
  /** 0x-prefixed 32-byte hex; derived client-side from the consumed
   *  ConfirmToken's bare-hex `actionHash` (see
   *  `confirm-token.service.ts:101-104`). */
  consentActionHash?: `0x${string}`
  /** Slice 4 wildcard carrier — optional in Slice 1. */
  consentTextSha256?: `0x${string}`
  /** Pickup B carrier — intentionally omitted in Pickup A. */
  permissionId?: `0x${string}`
  /**
   * Wave 5 Option D · Commit 2 — install material captured at mint
   * time. Backend Zod validates shape + length; `enableData` /
   * `enableSig` get encrypted at rest via pgcrypto (the response
   * never carries them; install-material subroute is the sole
   * reveal point). Optional for back-compat with Pickup-B-only
   * clients that haven't bumped past 0.3.72.
   */
  enableData?: `0x${string}`
  enableSig?: `0x${string}`
  validatorNonce?: number
}

export interface MintScopedSessionRequest {
  snapshot: PolicySnapshotMintBody
  /** uint256 decimal string. mhUSDC base-6 ceiling. */
  maxPerOpUsd6: string
  surface: Surface
}

export interface ScopedSessionResponseDto {
  sessionId: string
  mode: 'scoped'
  userId: string | null
  surface: Surface
  status: 'active' | 'revoked' | 'expired'
  signerAddress: `0x${string}`
  permissionId: `0x${string}` | null
  targetContracts: readonly `0x${string}`[]
  selectorCaps: readonly ScopedSelectorCap[]
  maxPerOpUsd6: string
  totalSpentUsd6: string
  validUntilSec: number
  mintedAtSec: number
  consentActionHash: `0x${string}` | null
  consentTextSha256: `0x${string}` | null
  mintedAt: string
  revokedAt: string | null
  expiredAt: string | null
  /**
   * Wave 5 Option D · Commit 2 — install lifecycle fields surfaced
   * on the standard GET response. enableData / enableSig are NEVER
   * here — only the dedicated install-material subroute exposes them
   * (C3 third commit moved that subroute to user-JWT auth + the
   * `mcp.propose.*` scope; it was briefly broker-callback-service-
   * secret-gated in C2).
   */
  enableStatus?: 'pending' | 'enabled' | 'failed' | null
  validatorEnabledAt?: string | null
  validatorEnabledTxHash?: `0x${string}` | null
  validatorNonce?: number | null
  /**
   * Wave 5 Slice 2 (auto-reinvest) — user opt-in for the headless
   * claim→buy reinvest loop, surfaced from the scoped-session DTO. Default
   * `false`; the Autonomy page toggle flips it via `setReinvestEnabled`.
   * Optional on the wire for back-compat with pre-Slice-2 backends (the
   * pre-cutover prod backend omits it until `db:push` adds the column).
   */
  reinvestEnabled?: boolean
}

export interface MintScopedSessionResponse {
  session: ScopedSessionResponseDto
}

/** Wave 5 Option D · Commit 4 — GET latest-active result. `session` is
 *  null when no active Scoped session exists for the surface. */
export interface GetActiveScopedSessionResponse {
  session: ScopedSessionResponseDto | null
}

/** Wave 5 Option D · Commit 4 — DELETE (revoke) result. Carries the
 *  now-`revoked` row so the caller can confirm the status flip. */
export interface RevokeScopedSessionResponse {
  session: ScopedSessionResponseDto
}

/** Wave 5 Slice 2c — POST /agent/reinvest result. Carries the session row
 *  with the updated `reinvestEnabled` so the toggle can reflect the
 *  committed state without a re-fetch. */
export interface SetReinvestEnabledResponse {
  session: ScopedSessionResponseDto
}

// ── Wave 4 §5 Path D + C — hosted-checkout dashboard ──────────────

export type CheckoutSessionStatus =
  | 'pending'
  | 'funded'
  | 'wrapped'
  | 'purchased'
  | 'settled'
  | 'expired'
  | 'failed'

export type CheckoutStatsRange = '7d' | '30d' | 'all'

export interface CheckoutSessionMetadataDto {
  issuerAddress: string
  tokenAddress: string
  tokenSymbol: string
  issuerLabel: string | null
  description: string
  successUrl: string | null
  cancelUrl: string | null
}

export interface CheckoutSessionListItemDto {
  sessionId: string
  status: CheckoutSessionStatus
  metadata: CheckoutSessionMetadataDto
  buyerAddress: string | null
  purchaseTxHash: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export interface ListCheckoutSessionsResponseDto {
  sessions: CheckoutSessionListItemDto[]
  nextCursor: string | null
}

export interface GetCheckoutSessionResponseDto {
  session: CheckoutSessionListItemDto
}

export interface WebhookEndpointListItemDto {
  endpointId: string
  url: string
  enabledEvents: string[]
  signingSecretHint: string
  disabledAt: string | null
  createdAt: string
}

export interface ListWebhookEndpointsResponseDto {
  endpoints: WebhookEndpointListItemDto[]
}

export interface CheckoutStatsResponseDto {
  range: CheckoutStatsRange
  total: number
  byStatus: Record<string, number>
  conversionRate: number
  daily: Array<{ bucketMs: number; count: number }>
}

export interface CreateCheckoutSessionRequest {
  metadata: CheckoutSessionMetadataDto
  payload: {
    amountUsd6: string
    memo?: string
    referenceId?: string
  }
  ttlSec?: number
}

export interface CreateCheckoutSessionResponse {
  sessionId: string
  url: string
  fragmentKey: string
  status: CheckoutSessionStatus
  expiresAt: string
  createdAt: string
  issuerLabel: string | null
  issuerLabelVerified: boolean
}

export interface RegisterWebhookEndpointRequest {
  url: string
  enabledEvents?: string[]
}

export interface RegisterWebhookEndpointResponse {
  endpointId: string
  url: string
  enabledEvents: string[]
  signingSecret: string
  createdAt: string
}

export const checkoutApi = {
  // ── Sessions ────────────────────────────────────────────────────
  createSession(
    data: CreateCheckoutSessionRequest,
  ): Promise<CreateCheckoutSessionResponse> {
    return request('/checkout/sessions/create', {
      method: 'POST',
      body: data,
      auth: true,
    })
  },
  listSessions(opts: {
    cursor?: string
    status?: CheckoutSessionStatus
    limit?: number
  } = {}): Promise<ListCheckoutSessionsResponseDto> {
    const qs = new URLSearchParams()
    if (opts.cursor) qs.set('cursor', opts.cursor)
    if (opts.status) qs.set('status', opts.status)
    if (opts.limit) qs.set('limit', String(opts.limit))
    const q = qs.toString()
    return request(`/checkout/sessions/list${q ? `?${q}` : ''}`, {
      method: 'GET',
      auth: true,
    })
  },
  getSession(sessionId: string): Promise<GetCheckoutSessionResponseDto> {
    return request(
      `/checkout/sessions/get?id=${encodeURIComponent(sessionId)}`,
      { method: 'GET', auth: true },
    )
  },
  // ── Webhooks ────────────────────────────────────────────────────
  listWebhooks(): Promise<ListWebhookEndpointsResponseDto> {
    return request('/checkout/webhooks/list', { method: 'GET', auth: true })
  },
  registerWebhook(
    data: RegisterWebhookEndpointRequest,
  ): Promise<RegisterWebhookEndpointResponse> {
    return request('/checkout/webhooks/register', {
      method: 'POST',
      body: data,
      auth: true,
    })
  },
  disableWebhook(endpointId: string): Promise<{ endpointId: string; disabledAt: string }> {
    return request('/checkout/webhooks/disable', {
      method: 'POST',
      body: { endpointId },
      auth: true,
    })
  },
  // ── Stats ───────────────────────────────────────────────────────
  getStats(range: CheckoutStatsRange = '7d'): Promise<CheckoutStatsResponseDto> {
    return request(`/checkout/stats?range=${range}`, {
      method: 'GET',
      auth: true,
    })
  },
}

// Wave 4 §5 Path C — HavenBot agent surface tools for create_checkout.
// Sit on `agentToolsApi`-shape but live in checkoutApi for proximity to
// the buyer-URL types that the success path returns.

export interface ProposeCreateCheckoutRequest {
  tokenAddress: string
  amountUsd6: string
  memo?: string
  successUrl?: string
  cancelUrl?: string
}

export interface CommitCreateCheckoutRequest {
  confirmToken: string
  actionPayload: Record<string, unknown>
  surface?: Surface
}

export interface CommitCreateCheckoutResponse {
  consumed: true
  auditEventId: string
  session: {
    sessionId: string
    url: string
    fragmentKey: string
    status: CheckoutSessionStatus
    expiresAt: string
  }
}

export const checkoutAgentApi = {
  proposeCreateCheckout(
    args: ProposeCreateCheckoutRequest,
  ): Promise<ActionDescriptor> {
    return request('/agent/tools/propose_create_checkout', {
      method: 'POST',
      body: args,
      auth: true,
    })
  },
  commitCreateCheckout(
    args: CommitCreateCheckoutRequest,
  ): Promise<CommitCreateCheckoutResponse> {
    return request('/agent/tools/commit_create_checkout', {
      method: 'POST',
      body: args,
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

// ── Wave 4 P9 — public metrics ────────────────────────────────────

export interface PublicMetricsTokenDto {
  address: string
  symbol: string
  status: string
}

export interface PublicMetricsDailyCount {
  day: string
  count: number
}

export interface PublicMetricsTokenCount {
  tokenAddress: string
  symbol: string
  count: number
}

export interface PublicMetricsWrapUnwrapByDay {
  day: string
  wrap: number
  unwrap: number
}

export interface PublicMetricsRedemptionByDay {
  day: string
  instant: number
  queued: number
  escalated: number
}

export interface PublicMetricsNavPoint {
  timestamp: string
  nav: string
}

export interface PublicMetricsNavSeries {
  tokenAddress: string
  symbol: string
  points: PublicMetricsNavPoint[]
}

export interface PublicMetricsDto {
  generatedAt: string
  tokens: PublicMetricsTokenDto[]
  purchases: {
    total: number
    byDay: PublicMetricsDailyCount[]
    byToken: PublicMetricsTokenCount[]
  }
  yieldDistributions: {
    total: number
    byDay: PublicMetricsDailyCount[]
  }
  wrapUnwrap: {
    wrapTotal: number
    unwrapTotal: number
    byDay: PublicMetricsWrapUnwrapByDay[]
  }
  redemptions: {
    total: number
    instant: number
    queued: number
    escalatedToQueue: number
    byDay: PublicMetricsRedemptionByDay[]
  }
  navHistory: PublicMetricsNavSeries[]
}

export const publicMetricsApi = {
  // Public endpoint — no auth header. Backend caches for 60s, so
  // polling at <60s interval is intentional waste; the page reloads
  // on mount + button-driven refresh only.
  get(): Promise<PublicMetricsDto> {
    return request<PublicMetricsDto>('/public/metrics')
  },
}

// ─────────────────────────────────────────────────────────────────────
// Wave 4 P4 — OpenClaw intent SSE events (back-to-dashboard auto-fire)
// ─────────────────────────────────────────────────────────────────────

export type OpenClawIntentEventType =
  | 'open'
  | 'intent_confirmed'
  | 'intent_consumed'
  | 'intent_denied'

export interface OpenClawIntentSseEvent {
  type: OpenClawIntentEventType
  intentId?: string
  payload?: {
    kind: 'buy' | 'claim'
    tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink'
    source?: 'telegram_inline' | 'mini_app' | 'dashboard_passkey'
    tokenAddress: string
    amountUsd6: string
  }
}

export const openclawIntentEventsApi = {
  /**
   * Open the per-user SSE channel for OpenClaw intent state changes.
   * Mirrors `agentToolsApi.openChatStream`'s shape but uses the native
   * `EventSource` because the connection is GET-only + long-lived.
   *
   * Auth via `?access_token=…` query param — EventSource cannot set
   * Authorization headers. Bounded by JWT TTL + per-user fan-out scope
   * (a stolen URL only reveals the victim's own intent state changes).
   *
   * Returns the EventSource directly so callers can `addEventListener`
   * + `close()` on lifecycle. Caller is responsible for closing.
   */
  open(
    onEvent: (evt: OpenClawIntentSseEvent) => void,
    onError?: (err: Event) => void,
  ): EventSource | null {
    const tokens = getStoredTokens()
    const token = tokens?.access_token
    if (!token) return null
    const url = `${BASE_URL}/agent/openclaw/intent/events?access_token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    const handler = (raw: MessageEvent) => {
      if (typeof raw.data !== 'string' || raw.data.length === 0) return
      try {
        const data = JSON.parse(raw.data) as OpenClawIntentSseEvent
        onEvent(data)
      } catch {
        // Heartbeat lines start with `:` and don't fire as `message`,
        // so we never reach here on a heartbeat. JSON parse failures
        // on a real event are silently dropped — the next event is
        // just a few seconds away.
      }
    }
    // Backend emits `open` once on subscribe, then per-state-flip
    // `intent_*` events. Listen on every named event we care about.
    es.addEventListener('open', handler as EventListener)
    es.addEventListener('intent_confirmed', handler as EventListener)
    es.addEventListener('intent_consumed', handler as EventListener)
    es.addEventListener('intent_denied', handler as EventListener)
    if (onError) es.addEventListener('error', onError)
    return es
  },
}
