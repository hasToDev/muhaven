<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Filler, Tooltip,
} from 'chart.js'
import type { Address } from 'viem'
import { useAppStore } from '@/stores/app'
import { tokensApi, type NavSnapshotDto } from '@/services/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

/**
 * Per-token NAV trend chart. Real data only — no mock fallback. Pre-revamp
 * `YieldLineChart` was deleted in this phase; consumers are required to
 * pass a `tokenAddress`. Empty / loading / error states render in-place
 * rather than substituting fabricated data, so the chart never lies about
 * what it shows.
 */
const props = defineProps<{
  tokenAddress: Address
  range: '1m' | '3m' | '6m' | '1y'
}>()

const store = useAppStore()
const snapshots = ref<NavSnapshotDto[]>([])
const loading = ref(false)
const errored = ref(false)

async function loadNavHistory() {
  loading.value = true
  errored.value = false
  try {
    const res = await tokensApi.getNavHistory(props.tokenAddress, props.range)
    snapshots.value = res.snapshots
  } catch {
    snapshots.value = []
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(loadNavHistory)
watch(() => [props.tokenAddress, props.range], loadNavHistory)

const hasData = computed(() => snapshots.value.length > 0)

// Date format depends on range — sub-month ranges need day granularity,
// long ranges show month + 2-digit year so wrap-arounds are unambiguous.
const labelFormat = computed<Intl.DateTimeFormatOptions>(() => {
  if (props.range === '1m' || props.range === '3m') {
    return { month: 'short', day: 'numeric' }
  }
  if (props.range === '1y') {
    return { month: 'short', year: '2-digit' }
  }
  return { month: 'short' }
})

const lineColor = computed(() => store.isDark ? '#FFDCA1' : '#B8860B')
const fillColor = computed(() =>
  store.isDark ? 'rgba(255,220,161,0.08)' : 'rgba(184,134,11,0.10)',
)

const chartData = computed(() => ({
  labels: snapshots.value.map(s =>
    new Date(s.fetched_at).toLocaleDateString('en-US', labelFormat.value),
  ),
  datasets: [{
    data: snapshots.value.map(s => parseFloat(s.nav)),
    borderColor: lineColor.value,
    backgroundColor: fillColor.value,
    fill: true,
    tension: 0.3,
    pointBackgroundColor: lineColor.value,
    pointBorderColor: lineColor.value,
    pointHoverBackgroundColor: '#FFBA20',
    pointHoverBorderColor: '#FFBA20',
    pointRadius: 0,
    pointHoverRadius: 5,
    borderWidth: 2,
  }],
}))

const tooltipColors = computed(() => store.isDark ? {
  bg: '#1A1B1E',
  title: '#FFDCA1',
  body: '#FAF5E8',
  border: 'rgba(255,186,32,0.25)',
} : {
  bg: '#FFFDF7',
  title: '#B8860B',
  body: '#121315',
  border: 'rgba(184,134,11,0.25)',
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { intersect: false, mode: 'index' as const },
  scales: {
    x: {
      grid: { display: false },
      ticks: {
        color: '#9E8F78',
        font: { family: 'Inter Variable', size: 11 },
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 8,
      },
    },
    y: {
      grid: {
        color: store.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(184,134,11,0.08)',
      },
      ticks: {
        color: '#9E8F78',
        font: { family: 'Inter Variable', size: 11 },
        callback: (v: number | string) => {
          const n = typeof v === 'number' ? v : parseFloat(String(v))
          return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        },
      },
    },
  },
  plugins: {
    tooltip: {
      backgroundColor: tooltipColors.value.bg,
      titleColor: tooltipColors.value.title,
      bodyColor: tooltipColors.value.body,
      borderColor: tooltipColors.value.border,
      borderWidth: 1,
      padding: 12,
      bodyFont: { family: 'Inter Variable' },
      displayColors: false,
      callbacks: {
        label: (ctx: { parsed: { y: number } }) =>
          `NAV $${ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`,
      },
    },
  },
}))
</script>

<template>
  <div
    class="relative"
    style="height: 220px"
    data-testid="nav-trend-chart-wrapper"
    :data-token-address="props.tokenAddress"
    :data-range="props.range"
    :data-snapshot-count="snapshots.length"
  >
    <div
      v-if="loading"
      class="h-full flex items-center justify-center"
      data-testid="nav-trend-chart-loading"
    >
      <span class="font-sans text-xs text-cool">Loading NAV history…</span>
    </div>
    <div
      v-else-if="errored"
      class="h-full flex flex-col items-center justify-center gap-2"
      data-testid="nav-trend-chart-error"
    >
      <span class="font-sans text-xs text-cool">Could not load NAV history</span>
      <button
        type="button"
        @click="loadNavHistory"
        class="font-sans text-[11px] text-gold hover:underline cursor-pointer"
      >Retry</button>
    </div>
    <div
      v-else-if="!hasData"
      class="h-full flex items-center justify-center"
      data-testid="nav-trend-chart-empty"
    >
      <span class="font-sans text-xs text-cool">No NAV history yet for this token</span>
    </div>
    <Line v-else :data="chartData" :options="(chartOptions as any)" />
  </div>
</template>
