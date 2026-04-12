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
    if (!hasMore.value || loadingMore.value) return

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
