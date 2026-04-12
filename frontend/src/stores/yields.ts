import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { yieldsApi, type YieldRecordDto, type YieldStatus } from '@/services/api'

export const useYieldsStore = defineStore('yields', () => {
  const items = ref<YieldRecordDto[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  const pending = computed(() => items.value.filter(i => i.status === 'pending'))
  const claimable = computed(() => items.value.filter(i => i.status === 'claimable'))
  const claimed = computed(() => items.value.filter(i => i.status === 'claimed'))

  const totalEarned = computed(() =>
    items.value
      .filter(i => i.status === 'claimed' && i.amount)
      .reduce((sum, i) => sum + parseFloat(i.amount!), 0),
  )

  const totalPending = computed(() =>
    items.value
      .filter(i => (i.status === 'pending' || i.status === 'claimable') && i.amount)
      .reduce((sum, i) => sum + parseFloat(i.amount!), 0),
  )

  async function load(opts?: { limit?: number; offset?: number; status?: YieldStatus }) {
    loading.value = true
    error.value = null

    try {
      const res = await yieldsApi.getAll(opts)
      items.value = res.items
      total.value = res.total
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load yields'
    } finally {
      loading.value = false
    }
  }

  function reset() {
    items.value = []
    total.value = 0
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    items,
    total,
    loading,
    error,
    loaded,
    pending,
    claimable,
    claimed,
    totalEarned,
    totalPending,
    load,
    reset,
  }
})
