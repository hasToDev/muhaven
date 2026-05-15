import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  issuerApi,
  type TokenResponseDto,
  type IssuerStatsDto,
} from '@/services/api'
import * as RegistryService from '@/services/contracts/RegistryService'

export interface IssuerTokenView {
  address: string
  name: string
  symbol: string
  supply: string
  investors: number | null
  apy: string | null
  schedule: string | null
  status: 'active' | 'paused' | 'winding_down' | 'archived'
  assetClass: string
}

export const useIssuerTokensStore = defineStore('issuer-tokens', () => {
  const tokens = ref<IssuerTokenView[]>([])
  const rawTokens = ref<TokenResponseDto[]>([])
  const stats = ref<IssuerStatsDto | null>(null)
  const onChainInvestorCount = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  // Master-detail selection — survives page reload within the session per
  // user pick Q4 C (D-045). The default token is chosen in `load()` once
  // tokens populate, so callers never have to worry about an unset value.
  const selectedAddress = ref<string | null>(null)

  const activeTokenCount = computed(() =>
    tokens.value.filter(t => t.status === 'active').length,
  )

  const aggregateStats = computed(() => ({
    totalAUM: stats.value?.total_aum ?? null,
    totalInvestors: onChainInvestorCount.value ?? stats.value?.total_investors ?? 0,
    weightedAPY: stats.value?.weighted_apy ?? null,
    activeTokens: activeTokenCount.value,
  }))

  /**
   * Pick a token in the master-detail view. Address is normalized to
   * lowercase before storage so the `selected` computed can do a
   * case-insensitive `find` without worrying about whether the caller
   * passed a checksummed or lowercase address. Matters because
   * ApplyPage's post-deploy "View {SYMBOL}" CTA passes
   * `wizard.tokenAddress` (raw from the SSE deploy event, casing varies
   * by viem version), while `issuerApi.getTokens()` echoes back the
   * Postgres row's `address` field which is canonical-lowercase per
   * the address-case-at-repo-boundary rule.
   *
   * Closes parallel-review HIGH 2026-05-19: pre-fix a checksummed
   * SSE address paired against a lowercase tokens-list silently fell
   * through `find` → `list[0]` fallback → user landed on the WRONG
   * token's detail panel after a successful deploy.
   */
  function selectToken(address: string) {
    selectedAddress.value = address.toLowerCase()
  }

  async function load() {
    loading.value = true
    error.value = null

    // Phase 9.A · multi-issuer scoping. Pulls from `/v1/issuer/tokens`
    // (auth-gated, JWT-derived issuer address) instead of the public
    // catalogue — issuers see only their own tokens. Investor-side
    // marketplace continues to call `tokensApi.getAll()` directly via
    // `useMarketplaceStore`.
    const [tokensRes, statsRes] = await Promise.allSettled([
      issuerApi.getTokens(),
      issuerApi.getStats(),
    ])

    // Tokens are critical — surface the error if this fails
    if (tokensRes.status === 'rejected') {
      error.value = tokensRes.reason instanceof Error
        ? tokensRes.reason.message
        : 'Failed to load tokens'
      loading.value = false
      return
    }

    rawTokens.value = tokensRes.value.tokens
    tokens.value = tokensRes.value.tokens.map(t => ({
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      supply: 'Encrypted',
      investors: null,
      apy: t.apy,
      schedule: t.yield_schedule,
      status: t.status,
      assetClass: t.asset_class,
    }))

    // Default the master-detail selection to the first active token (or
    // first overall) so the right-hand panel always has something to render
    // on initial load. Skip if user already picked one this session.
    if (selectedAddress.value === null && tokens.value.length > 0) {
      const defaultToken = tokens.value.find(t => t.status === 'active') ?? tokens.value[0]
      selectedAddress.value = defaultToken.address
    }

    // Stats and investor count are non-critical — degrade gracefully
    if (statsRes.status === 'fulfilled') {
      stats.value = statsRes.value
    }

    // Phase 9.A · Expansion (F3) — multi-issuer scoping. Pre-F3 this
    // read the platform-wide `RegistryService.investorCount()`, which
    // counts every investor across every issuer (Wave-3 back-compat
    // API). Switched to per-token `holderCount(token)` aggregated over
    // only this issuer's own tokens, deduped by address — matches the
    // /investors page scoping in `issuer-investors.ts`.
    if (rawTokens.value.length > 0) {
      try {
        const perToken = await Promise.all(
          rawTokens.value.map(t =>
            RegistryService.getHoldersPaginated(t.address as `0x${string}`, 0n, 1000n),
          ),
        )
        const seen = new Set<string>()
        for (const list of perToken) {
          for (const h of list) seen.add(h.toLowerCase())
        }
        onChainInvestorCount.value = seen.size
      } catch {
        // Non-critical — leave at null; aggregateStats falls back to
        // `stats.total_investors` and ultimately 0.
      }
    } else {
      onChainInvestorCount.value = 0
    }

    loaded.value = true
    loading.value = false
  }

  function reset() {
    tokens.value = []
    rawTokens.value = []
    stats.value = null
    onChainInvestorCount.value = null
    selectedAddress.value = null
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    tokens,
    rawTokens,
    stats,
    onChainInvestorCount,
    selectedAddress,
    loading,
    error,
    loaded,
    activeTokenCount,
    aggregateStats,
    selectToken,
    load,
    reset,
  }
})
