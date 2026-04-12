import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { tokensApi, type TokenResponseDto, type AssetClass } from '@/services/api'

export const useMarketplaceStore = defineStore('marketplace', () => {
  const tokens = ref<TokenResponseDto[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  // Filters
  const searchQuery = ref('')
  const assetClassFilter = ref<AssetClass | ''>('')
  const statusFilter = ref<'active' | ''>('active')

  const filtered = computed(() => {
    let result = tokens.value

    if (statusFilter.value) {
      result = result.filter(t => t.status === statusFilter.value)
    }

    if (assetClassFilter.value) {
      result = result.filter(t => t.asset_class === assetClassFilter.value)
    }

    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      result = result.filter(
        t => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q),
      )
    }

    return result
  })

  const assetClasses = computed(() => {
    const classes = new Set(tokens.value.map(t => t.asset_class))
    return Array.from(classes).sort()
  })

  async function load() {
    loading.value = true
    error.value = null

    try {
      const res = await tokensApi.getAll()
      tokens.value = res.tokens
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load tokens'
    } finally {
      loading.value = false
    }
  }

  /** Get a single token by address (from cache or fetch) */
  function getByAddress(address: string): TokenResponseDto | undefined {
    return tokens.value.find(t => t.address.toLowerCase() === address.toLowerCase())
  }

  function reset() {
    tokens.value = []
    searchQuery.value = ''
    assetClassFilter.value = ''
    statusFilter.value = 'active'
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    tokens,
    loading,
    error,
    loaded,
    searchQuery,
    assetClassFilter,
    statusFilter,
    filtered,
    assetClasses,
    load,
    getByAddress,
    reset,
  }
})
