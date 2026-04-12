<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Filler, Tooltip,
} from 'chart.js'
import { useAppStore } from '@/stores/app'
import { tokensApi, type NavSnapshotDto } from '@/services/api'
import { YIELD_CHART_DATA } from '@/data/constants'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const props = defineProps<{
  tokenAddress?: string
  range?: '1m' | '3m' | '6m' | '1y'
}>()

const store = useAppStore()
const snapshots = ref<NavSnapshotDto[]>([])
const loading = ref(false)

async function loadNavHistory() {
  if (!props.tokenAddress) return
  loading.value = true
  try {
    const res = await tokensApi.getNavHistory(props.tokenAddress, props.range || '6m')
    snapshots.value = res.snapshots
  } catch {
    snapshots.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadNavHistory)
watch(() => [props.tokenAddress, props.range], loadNavHistory)

const hasLiveData = computed(() => snapshots.value.length > 0)

const chartData = computed(() => {
  if (hasLiveData.value) {
    return {
      labels: snapshots.value.map(s => new Date(s.fetched_at).toLocaleDateString('en-US', { month: 'short' })),
      datasets: [{
        data: snapshots.value.map(s => parseFloat(s.nav)),
        borderColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
        backgroundColor: store.isDark ? 'rgba(168,245,236,0.08)' : 'rgba(27,158,138,0.08)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
      }],
    }
  }

  // Fallback to mock data
  return {
    labels: YIELD_CHART_DATA.labels,
    datasets: [{
      data: YIELD_CHART_DATA.values,
      borderColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
      backgroundColor: store.isDark ? 'rgba(168,245,236,0.08)' : 'rgba(27,158,138,0.08)',
      fill: true,
      tension: 0.3,
      pointBackgroundColor: store.isDark ? '#A8F5EC' : '#1B9E8A',
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2,
    }],
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: '#7AADA9', font: { family: 'Inter Variable', size: 11 } },
    },
    y: {
      grid: { color: store.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(178,235,230,0.5)' },
      ticks: {
        color: '#7AADA9',
        font: { family: 'Inter Variable', size: 11 },
        callback: (v: number) => `$${v}`,
      },
    },
  },
  plugins: {
    tooltip: {
      backgroundColor: '#1A1A2E',
      titleColor: '#A8F5EC',
      bodyColor: '#FFFFFF',
      borderColor: 'rgba(27,158,138,0.3)',
      borderWidth: 1,
      padding: 12,
      bodyFont: { family: 'Inter Variable' },
      callbacks: {
        label: (ctx: any) => ` $${ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      },
    },
  },
}))
</script>

<template>
  <div style="height: 200px">
    <div v-if="loading" class="h-full flex items-center justify-center">
      <span class="text-xs text-cool">Loading chart data...</span>
    </div>
    <Line v-else :data="chartData" :options="(chartOptions as any)" />
  </div>
</template>
