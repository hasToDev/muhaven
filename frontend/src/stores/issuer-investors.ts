import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as RegistryService from '@/services/contracts/RegistryService'
import * as KYCService from '@/services/contracts/KYCService'

export interface OnChainInvestor {
  address: `0x${string}`
  isEligible: boolean
  isWhitelisted: boolean
  isAccredited: boolean
}

const PAGE_SIZE = 20n

export const useIssuerInvestorsStore = defineStore('issuer-investors', () => {
  const investors = ref<OnChainInvestor[]>([])
  const totalCount = ref(0)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)
  const hasMore = ref(false)
  const kycFilter = ref<'all' | 'eligible' | 'ineligible'>('all')
  const searchQuery = ref('')

  const filteredInvestors = computed(() => {
    let result = investors.value

    // KYC filter
    if (kycFilter.value === 'eligible') {
      result = result.filter(i => i.isEligible)
    } else if (kycFilter.value === 'ineligible') {
      result = result.filter(i => !i.isEligible)
    }

    // Search by address
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      result = result.filter(i => i.address.toLowerCase().includes(q))
    }

    return result
  })

  const stats = computed(() => {
    const total = investors.value.length
    const eligible = investors.value.filter(i => i.isEligible).length
    const accredited = investors.value.filter(i => i.isAccredited).length
    const ineligible = total - eligible
    return {
      total: totalCount.value || total,
      eligible,
      accredited,
      ineligible,
      eligibilityRate: total > 0 ? Math.round((eligible / total) * 100) : 0,
    }
  })

  async function enrichWithKYC(addresses: `0x${string}`[]): Promise<OnChainInvestor[]> {
    // Batch KYC checks — run in parallel per address
    const results = await Promise.allSettled(
      addresses.map(async (addr) => {
        const [isEligible, isWhitelisted, isAccredited] = await Promise.all([
          KYCService.isEligible(addr),
          KYCService.isWhitelisted(addr),
          KYCService.isAccredited(addr),
        ])
        return { address: addr, isEligible, isWhitelisted, isAccredited }
      }),
    )

    return results
      .filter((r): r is PromiseFulfilledResult<OnChainInvestor> => r.status === 'fulfilled')
      .map(r => r.value)
  }

  async function load() {
    loading.value = true
    error.value = null

    try {
      // Get total count from on-chain
      const count = await RegistryService.investorCount()
      totalCount.value = Number(count)

      if (totalCount.value === 0) {
        investors.value = []
        loaded.value = true
        return
      }

      // Load first page
      const addresses = await RegistryService.getInvestorsPaginated(0n, PAGE_SIZE)
      investors.value = await enrichWithKYC(addresses)
      hasMore.value = investors.value.length < totalCount.value

      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load investors'
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (loadingMore.value || !hasMore.value) return
    loadingMore.value = true

    try {
      const offset = BigInt(investors.value.length)
      const addresses = await RegistryService.getInvestorsPaginated(offset, PAGE_SIZE)

      if (addresses.length === 0) {
        hasMore.value = false
        return
      }

      const enriched = await enrichWithKYC(addresses)
      investors.value.push(...enriched)
      hasMore.value = investors.value.length < totalCount.value
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load more investors'
    } finally {
      loadingMore.value = false
    }
  }

  function reset() {
    investors.value = []
    totalCount.value = 0
    loading.value = false
    loadingMore.value = false
    error.value = null
    loaded.value = false
    hasMore.value = false
    kycFilter.value = 'all'
    searchQuery.value = ''
  }

  return {
    investors,
    totalCount,
    loading,
    loadingMore,
    error,
    loaded,
    hasMore,
    kycFilter,
    searchQuery,
    filteredInvestors,
    stats,
    load,
    loadMore,
    reset,
  }
})
