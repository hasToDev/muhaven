import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  oracleApi,
  type OracleTokenListItemDto,
  type OracleTokenMetadataDto,
  type OracleSnapshotDto,
  type OracleTimeseriesDto,
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

  // Q4 timeseries cache. Keyed by `<ticker_lower>::<measure>::<from>::<to>`
  // so the same (ticker, measure) at different ranges don't collide. Each
  // value is the full DTO (incl. `count` + `unit`) the chart needs.
  const timeseriesCache = ref<Map<string, OracleTimeseriesDto>>(new Map())
  // In-flight promise dedup. When the marketplace mounts 11 cards in
  // parallel, every card hits `loadTimeseries(t, 'apy_7_day', 90D)`
  // synchronously in onMounted — without this Map, the cache check
  // happens AFTER `await`, so all 11 fire a network request even though
  // they all want the same payload. Holding the in-flight Promise per
  // key collapses the fan-out to one origin hit (load-bearing while
  // Cloudflare is still bypassing the backend `Cache-Control`).
  const inflight = new Map<string, Promise<OracleTimeseriesDto>>()
  // Cache epoch — bumped on `reset()` so a request that was in-flight
  // when the user logged out doesn't write its response into the
  // fresh-tenant cache. Components torn down by tearDownUserStores will
  // never observe the discarded write; we just need the cache to stay
  // clean. Plain number (not ref) because the guard is read at promise
  // resolution time, not from the template.
  let cacheEpoch = 0

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
    // Capture epoch before await so a logout mid-flight discards the
    // cache write — same auth-boundary leak class as loadTimeseries.
    const startedAt = cacheEpoch
    const data = await oracleApi.getMetadata(ticker)
    if (startedAt !== cacheEpoch) return data
    // Cache by lowercase ticker so case-variant lookups hit without a
    // server round-trip. The cached value carries the canonical
    // case-preserved ticker from the response, not the input.
    //
    // Reactivity: Map.set on a `ref<Map>` mutates in place. Vue 3's
    // collection proxy DOES track that, but only callers reading
    // through the same store instance benefit; we reassign the Map
    // ref explicitly to surface the new entry to any reactive
    // observer just in case (cheap — 11-entry max in steady state).
    const next = new Map(metadataByTicker.value)
    next.set(data.ticker.toLowerCase(), data)
    metadataByTicker.value = next
    return data
  }

  async function loadLatestSnapshot(ticker: string): Promise<OracleSnapshotDto> {
    const cached = snapshotByTicker.value.get(ticker.toLowerCase())
    if (cached) return cached
    const startedAt = cacheEpoch
    const data = await oracleApi.getLatestSnapshot(ticker)
    if (startedAt !== cacheEpoch) return data
    const next = new Map(snapshotByTicker.value)
    next.set(data.ticker.toLowerCase(), data)
    snapshotByTicker.value = next
    return data
  }

  /**
   * Q4 charts — historical series for a (ticker, measure, range).
   * Range params are optional ISO dates; omit both for "All".
   * Cached per composite key for the session; the backend's
   * `Cache-Control` does the cross-session work. Concurrent callers
   * with the same key share a single in-flight request.
   */
  async function loadTimeseries(
    ticker: string,
    measure: string,
    range?: { from?: string; to?: string },
  ): Promise<OracleTimeseriesDto> {
    const key = `${ticker.toLowerCase()}::${measure}::${range?.from ?? ''}::${range?.to ?? ''}`
    const cached = timeseriesCache.value.get(key)
    if (cached) return cached
    const pending = inflight.get(key)
    if (pending) return pending
    const startedAt = cacheEpoch
    const promise = oracleApi
      .getTimeseries(ticker, measure, range)
      .then((data) => {
        // Discard the cache write if the store was reset() while the
        // request was in-flight — prevents stale-tenant data from
        // leaking into a fresh login's cache. The returned data still
        // resolves to the original caller (they may need it for
        // teardown-phase rendering), just not to the shared cache.
        if (startedAt !== cacheEpoch) return data
        const next = new Map(timeseriesCache.value)
        next.set(key, data)
        timeseriesCache.value = next
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }

  function reset() {
    tokens.value = []
    metadataByTicker.value = new Map()
    snapshotByTicker.value = new Map()
    timeseriesCache.value = new Map()
    // Inflight map is intentionally NOT a ref — clear in place. Pending
    // promises will resolve into a tombstoned epoch (see cacheEpoch
    // guard in loadTimeseries) and discard their cache write.
    inflight.clear()
    cacheEpoch++
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
    loadTimeseries,
    reset,
  }
})
