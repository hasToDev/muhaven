import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  tokensApi,
  issuerApi,
  type TokenResponseDto,
  type IssuerStatsDto,
} from '@/services/api'
import * as RegistryService from '@/services/contracts/RegistryService'
import * as YieldService from '@/services/contracts/YieldService'
import { DistributionStatus } from '@/services/contracts/types'

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

export interface DistributionHistoryItem {
  distributionId: number
  token: string
  totalAmount: string | null
  investors: number
  status: 'pending' | 'processing' | 'complete'
  escrowsCreated: number
}

export const useIssuerTokensStore = defineStore('issuer-tokens', () => {
  const tokens = ref<IssuerTokenView[]>([])
  const rawTokens = ref<TokenResponseDto[]>([])
  const stats = ref<IssuerStatsDto | null>(null)
  const distributions = ref<DistributionHistoryItem[]>([])
  const onChainInvestorCount = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  const activeTokenCount = computed(() =>
    tokens.value.filter(t => t.status === 'active').length,
  )

  const aggregateStats = computed(() => ({
    totalAUM: stats.value?.total_aum ?? null,
    totalInvestors: onChainInvestorCount.value ?? stats.value?.total_investors ?? 0,
    weightedAPY: stats.value?.weighted_apy ?? null,
    activeTokens: activeTokenCount.value,
  }))

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

  async function loadDistributionHistory() {
    try {
      const count = await YieldService.distributionCount()
      const total = Number(count)
      if (total === 0) return

      // Load most recent distributions (up to 10) in parallel
      const start = Math.max(0, total - 10)
      const ids = Array.from({ length: total - start }, (_, k) => total - 1 - k)

      const results = await Promise.allSettled(
        ids.map(async (i): Promise<DistributionHistoryItem> => {
          const dist = await YieldService.getDistribution(BigInt(i))
          return {
            distributionId: i,
            token: dist.token,
            totalAmount: null, // Encrypted — issuer sees only aggregate
            investors: Number(dist.investorCount),
            status: dist.status === DistributionStatus.COMPLETED
              ? 'complete'
              : dist.status === DistributionStatus.IN_PROGRESS
                ? 'processing'
                : 'pending',
            escrowsCreated: Number(dist.escrowsCreated),
          }
        }),
      )

      distributions.value = results
        .filter((r): r is PromiseFulfilledResult<DistributionHistoryItem> => r.status === 'fulfilled')
        .map(r => r.value)
    } catch {
      // Distribution history is non-critical — don't block the page
    }
  }

  function reset() {
    tokens.value = []
    rawTokens.value = []
    stats.value = null
    distributions.value = []
    onChainInvestorCount.value = null
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    tokens,
    rawTokens,
    stats,
    distributions,
    onChainInvestorCount,
    loading,
    error,
    loaded,
    activeTokenCount,
    aggregateStats,
    load,
    loadDistributionHistory,
    reset,
  }
})
