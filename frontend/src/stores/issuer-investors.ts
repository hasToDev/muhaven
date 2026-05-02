import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as RegistryService from '@/services/contracts/RegistryService'
import * as KYCService from '@/services/contracts/KYCService'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'

export interface OnChainInvestor {
  address: `0x${string}`
  isEligible: boolean
  isWhitelisted: boolean
  isAccredited: boolean
  /** Token symbols the investor holds for this issuer (deduped, lower-case match). */
  heldSymbols: string[]
}

const HOLDERS_PAGE = 200n

export const useIssuerInvestorsStore = defineStore('issuer-investors', () => {
  const investors = ref<OnChainInvestor[]>([])
  const totalCount = ref(0)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)
  /** Per-token universe: union covers everything we walked, so loadMore is a no-op today. */
  const hasMore = ref(false)
  const kycFilter = ref<'all' | 'eligible' | 'ineligible'>('all')
  const searchQuery = ref('')
  /** Symbols of the issuer's tokens we walked — used for the scoping caption. */
  const scopedTokenSymbols = ref<string[]>([])

  const filteredInvestors = computed(() => {
    let result = investors.value

    if (kycFilter.value === 'eligible') {
      result = result.filter(i => i.isEligible)
    } else if (kycFilter.value === 'ineligible') {
      result = result.filter(i => !i.isEligible)
    }

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

  async function enrichWithKYC(
    holders: Array<{ address: `0x${string}`; heldSymbols: string[] }>,
  ): Promise<OnChainInvestor[]> {
    const results = await Promise.allSettled(
      holders.map(async (h) => {
        const [isEligible, isWhitelisted, isAccredited] = await Promise.all([
          KYCService.isEligible(h.address),
          KYCService.isWhitelisted(h.address),
          KYCService.isAccredited(h.address),
        ])
        return {
          address: h.address,
          isEligible,
          isWhitelisted,
          isAccredited,
          heldSymbols: h.heldSymbols,
        }
      }),
    )

    return results
      .filter((r): r is PromiseFulfilledResult<OnChainInvestor> => r.status === 'fulfilled')
      .map(r => r.value)
  }

  /**
   * Walk every page of `getHoldersPaginated(token, ...)` for one token.
   */
  async function fetchAllHolders(token: `0x${string}`): Promise<`0x${string}`[]> {
    const collected: `0x${string}`[] = []
    let offset = 0n
    while (true) {
      const page = await RegistryService.getHoldersPaginated(token, offset, HOLDERS_PAGE)
      collected.push(...page)
      if (BigInt(page.length) < HOLDERS_PAGE) break
      offset += BigInt(page.length)
    }
    return collected
  }

  async function load() {
    loading.value = true
    error.value = null

    try {
      // Phase 9.A · Expansion (F3) — multi-issuer scoping.
      // Pre-F3 this called the platform-wide `investorCount()` +
      // `getInvestorsPaginated()`, which returns every investor in the
      // global set (Wave-3 back-compat API) — issuer A would see issuer
      // B's investors. Switched to the Wave-3.5 per-token API
      // (`holderCount(token)` + `getHoldersPaginated(token, ...)`) and
      // walk the union over only this issuer's own tokens.
      const tokensStore = useIssuerTokensStore()
      if (!tokensStore.loaded) await tokensStore.load()
      const issuerTokens = tokensStore.rawTokens.map(t => ({
        address: t.address as `0x${string}`,
        symbol: t.symbol,
      }))

      if (issuerTokens.length === 0) {
        investors.value = []
        totalCount.value = 0
        scopedTokenSymbols.value = []
        loaded.value = true
        return
      }

      // Walk every token in parallel; aggregate into a holder→symbols map
      // so we can show which of the issuer's tokens an investor holds.
      const perToken = await Promise.all(
        issuerTokens.map(async ({ address, symbol }) => ({
          symbol,
          holders: await fetchAllHolders(address),
        })),
      )

      const byHolder = new Map<string, { address: `0x${string}`; heldSymbols: Set<string> }>()
      for (const { symbol, holders } of perToken) {
        for (const holder of holders) {
          const key = holder.toLowerCase()
          let bucket = byHolder.get(key)
          if (!bucket) {
            bucket = { address: holder, heldSymbols: new Set<string>() }
            byHolder.set(key, bucket)
          }
          bucket.heldSymbols.add(symbol)
        }
      }

      const holders = Array.from(byHolder.values()).map(b => ({
        address: b.address,
        heldSymbols: Array.from(b.heldSymbols).sort(),
      }))
      investors.value = await enrichWithKYC(holders)
      totalCount.value = investors.value.length
      hasMore.value = false
      scopedTokenSymbols.value = issuerTokens.map(t => t.symbol).sort()
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load investors'
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    // No-op today — `load()` walks the per-token universe in full. Kept
    // as a stable hook so the UI's "Load more" button can be re-wired
    // when we move to lazy pagination at scale.
    if (loadingMore.value || !hasMore.value) return
    loadingMore.value = true
    try {
      hasMore.value = false
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
    scopedTokenSymbols.value = []
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
    scopedTokenSymbols,
    filteredInvestors,
    stats,
    load,
    loadMore,
    reset,
  }
})
