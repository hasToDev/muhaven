import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  oracleApi,
  type OracleTokenListItemDto,
  type OracleTokenMetadataDto,
  type OracleSnapshotDto,
} from '@/services/api'

/**
 * Wave 5 Q1 — oracle-tracked RWA catalog. Backed by the
 * `/api/v1/oracle/tokens` family of endpoints (rwa.xyz-sourced
 * reference data). Replaces the on-chain `rwa_tokens` catalog as the
 * marketplace source.
 *
 * Caching:
 *  - List → kept in `tokens` until `reset()`. Re-fetch via `load()`.
 *  - Per-ticker metadata + latest snapshot → kept in keyed maps.
 *    Backend Cache-Control headers do the heavy lifting at the edge;
 *    this client-side cache just deduplicates within a session.
 */
export const useOracleTokensStore = defineStore('oracle-tokens', () => {
  const tokens = ref<OracleTokenListItemDto[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  // Per-ticker caches for the detail page. Map preserves insertion
  // order, which doesn't matter here but is cheap.
  const metadataByTicker = ref<Map<string, OracleTokenMetadataDto>>(new Map())
  const snapshotByTicker = ref<Map<string, OracleSnapshotDto>>(new Map())

  // Filters — mirror the previous marketplace store's shape so the
  // page doesn't have to rewrite its filter UI.
  const searchQuery = ref('')
  const assetClassFilter = ref<string>('')
  const yieldFilter = ref<'all' | 'yield' | 'non-yield'>('all')

  const filtered = computed(() => {
    let result = tokens.value

    if (yieldFilter.value === 'yield') {
      result = result.filter((t) => t.is_yield_bearing)
    } else if (yieldFilter.value === 'non-yield') {
      result = result.filter((t) => !t.is_yield_bearing)
    }

    if (assetClassFilter.value) {
      result = result.filter((t) => t.asset_class_slug === assetClassFilter.value)
    }

    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      result = result.filter(
        (t) =>
          t.ticker.toLowerCase().includes(q) ||
          t.display_name.toLowerCase().includes(q) ||
          (t.issuer_name?.toLowerCase().includes(q) ?? false),
      )
    }

    return result
  })

  // Unique asset-class slugs available in the loaded catalog —
  // populates the filter dropdown without hard-coding the rwa.xyz
  // taxonomy.
  const assetClasses = computed(() => {
    const map = new Map<string, string>()
    for (const t of tokens.value) {
      if (t.asset_class_slug && t.asset_class_name) {
        map.set(t.asset_class_slug, t.asset_class_name)
      }
    }
    return Array.from(map.entries())
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  async function load() {
    loading.value = true
    error.value = null
    try {
      const res = await oracleApi.list()
      tokens.value = res.tokens
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load tokens'
    } finally {
      loading.value = false
    }
  }

  /**
   * Lookup from the loaded list. Case-insensitive — `usyc` and `USYC`
   * both resolve. Returns undefined when the list isn't loaded yet.
   */
  function getByTicker(ticker: string): OracleTokenListItemDto | undefined {
    const lower = ticker.toLowerCase()
    return tokens.value.find((t) => t.ticker.toLowerCase() === lower)
  }

  async function loadMetadata(ticker: string): Promise<OracleTokenMetadataDto> {
    const cached = metadataByTicker.value.get(ticker.toLowerCase())
    if (cached) return cached
    const data = await oracleApi.getMetadata(ticker)
    // Cache under the canonical case AND the input case so subsequent
    // case-variant lookups hit the cache without a server round-trip.
    metadataByTicker.value.set(data.ticker.toLowerCase(), data)
    return data
  }

  async function loadLatestSnapshot(ticker: string): Promise<OracleSnapshotDto> {
    const cached = snapshotByTicker.value.get(ticker.toLowerCase())
    if (cached) return cached
    const data = await oracleApi.getLatestSnapshot(ticker)
    snapshotByTicker.value.set(data.ticker.toLowerCase(), data)
    return data
  }

  function reset() {
    tokens.value = []
    metadataByTicker.value = new Map()
    snapshotByTicker.value = new Map()
    searchQuery.value = ''
    assetClassFilter.value = ''
    yieldFilter.value = 'all'
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
    yieldFilter,
    filtered,
    assetClasses,
    load,
    getByTicker,
    loadMetadata,
    loadLatestSnapshot,
    reset,
  }
})
