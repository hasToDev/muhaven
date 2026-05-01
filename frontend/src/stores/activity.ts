import { defineStore } from 'pinia'
import { ref } from 'vue'
import { activityApi, type ActivityItemDto } from '@/services/api'

export const useActivityStore = defineStore('activity', () => {
  const items = ref<ActivityItemDto[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  async function load(limit = 20) {
    // Concurrent-load guard. Always-refetch on mount (added in 7cdbdfb)
    // means a fast tab-nav-back-and-forth can fire `load()` while a prior
    // `load()` or `loadMore()` is still in flight. Without this guard,
    // a `load` resolving mid-`loadMore` REPLACES `items` with the page-1
    // batch, silently dropping rows the user paged in. Skipping when
    // either is in flight is safe — the in-flight call lands fresh data.
    if (loading.value || loadingMore.value) return

    loading.value = true
    error.value = null

    try {
      const res = await activityApi.getAll({ limit })
      items.value = res.items
      hasMore.value = res.has_more
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load activity'
    } finally {
      loading.value = false
    }
  }

  async function loadMore(limit = 20) {
    // Symmetric guard against the always-refetch path. If a mount-fired
    // `load()` is still in flight when the user clicks Load More, racing
    // both is wasted work — `load()` is about to replace `items` with the
    // page-1 batch, dropping anything `loadMore()` would append.
    if (!hasMore.value || loadingMore.value || loading.value) return

    loadingMore.value = true
    error.value = null

    try {
      const res = await activityApi.getAll({ limit, offset: items.value.length })
      items.value.push(...res.items)
      hasMore.value = res.has_more
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load more activity'
    } finally {
      loadingMore.value = false
    }
  }

  function reset() {
    items.value = []
    hasMore.value = false
    loading.value = false
    loadingMore.value = false
    error.value = null
    loaded.value = false
  }

  return {
    items,
    hasMore,
    loading,
    loadingMore,
    error,
    loaded,
    load,
    loadMore,
    reset,
  }
})
