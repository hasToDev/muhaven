import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  tokensApi,
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

  function selectToken(address: string) {
    selectedAddress.value = address
  }

  async function load() {
    loading.value = true
    error.value = null

    // Fetch backend data + on-chain data in parallel
    const [tokensRes, statsRes, investorCount] = await Promise.allSettled([
      tokensApi.getAll(),
      issuerApi.getStats(),
      RegistryService.investorCount(),
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

    if (investorCount.status === 'fulfilled') {
      onChainInvestorCount.value = Number(investorCount.value)
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
