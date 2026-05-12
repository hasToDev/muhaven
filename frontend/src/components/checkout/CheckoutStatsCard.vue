<script setup lang="ts">
import { computed } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Filler, Tooltip,
} from 'chart.js'
import { useAppStore } from '@/stores/app'
import type { CheckoutStatsResponseDto, CheckoutStatsRange } from '@/services/api'
import { TrendingUp, BarChart3, Percent, Activity } from 'lucide-vue-next'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const props = defineProps<{
  stats: CheckoutStatsResponseDto | null
  loading: boolean
  range: CheckoutStatsRange
}>()

const emit = defineEmits<{
  (e: 'rangeChange', range: CheckoutStatsRange): void
}>()

const appStore = useAppStore()

const ranges: Array<{ key: CheckoutStatsRange; label: string }> = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
]

const conversionPct = computed(() => {
  if (!props.stats) return null
  return (props.stats.conversionRate * 100).toFixed(1)
})

const settled = computed(() => props.stats?.byStatus.settled ?? 0)
const pending = computed(() => props.stats?.byStatus.pending ?? 0)
const expired = computed(() => props.stats?.byStatus.expired ?? 0)
const failed = computed(() => props.stats?.byStatus.failed ?? 0)
const inflight = computed(
  () => (props.stats?.byStatus.funded ?? 0)
    + (props.stats?.byStatus.wrapped ?? 0)
    + (props.stats?.byStatus.purchased ?? 0),
)

const chartData = computed(() => {
  const labels = (props.stats?.daily ?? []).map((d) => {
    const dt = new Date(d.bucketMs)
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
  })
  const data = (props.stats?.daily ?? []).map((d) => d.count)
  return {
    labels,
    datasets: [
      {
        data,
        borderColor: appStore.isDark ? '#FFBA20' : '#B8860B',
        backgroundColor: appStore.isDark
          ? 'rgba(255, 186, 32, 0.18)'
          : 'rgba(184, 134, 11, 0.10)',
        borderWidth: 1.75,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      },
    ],
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: { display: false, beginAtZero: true },
  },
  plugins: {
    tooltip: {
      backgroundColor: appStore.isDark ? '#1d1e21' : '#FFFDF7',
      titleColor: appStore.isDark ? '#FFFDF7' : '#1B1614',
      bodyColor: appStore.isDark ? '#FFFDF7' : '#1B1614',
      borderColor: appStore.isDark ? '#FFBA20' : '#B8860B',
      borderWidth: 1,
      padding: 8,
      titleFont: { size: 11 },
      bodyFont: { size: 11 },
    },
    legend: { display: false },
  },
}))

function setRange(r: CheckoutStatsRange) {
  if (r === props.range) return
  emit('rangeChange', r)
}
</script>

<template>
  <section
    class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6"
    data-testid="checkout-stats-card"
  >
    <!-- Header — range chips on the right -->
    <div class="flex items-start justify-between gap-3 mb-5">
      <div>
        <h2 class="font-sans font-semibold text-base text-midnight dark:text-white tracking-tight">
          Checkout activity
        </h2>
        <p class="font-sans text-[11px] text-cool mt-0.5">
          Count-only — amounts stay encrypted at rest.
        </p>
      </div>
      <div
        role="group"
        aria-label="Stats time range"
        class="inline-flex rounded-md bg-mist/60 dark:bg-white/5 ring-1 ring-haze dark:ring-white/8 p-0.5"
      >
        <button
          v-for="r in ranges"
          :key="r.key"
          type="button"
          :data-testid="`checkout-stats-range-${r.key}`"
          :aria-pressed="r.key === range ? 'true' : 'false'"
          :class="[
            'px-2.5 py-1 text-[11px] font-sans font-medium rounded-[5px] transition-colors',
            r.key === range
              ? 'bg-white dark:bg-midnight text-compute dark:text-signal shadow-sm'
              : 'text-cool hover:text-midnight dark:hover:text-white cursor-pointer',
          ]"
          @click="setRange(r.key)"
        >
          {{ r.label }}
        </button>
      </div>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="loading && !stats"
      class="grid grid-cols-2 md:grid-cols-4 gap-3"
      role="status"
      aria-busy="true"
      aria-label="Loading checkout stats"
    >
      <div v-for="i in 4" :key="i" class="h-20 rounded-lg bg-mist/60 dark:bg-white/5 motion-safe:animate-pulse" aria-hidden="true" />
    </div>

    <!-- Stats -->
    <div v-else class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <!-- Total -->
      <div class="rounded-lg bg-mist/40 dark:bg-white/3 ring-1 ring-haze/60 dark:ring-white/8 p-3">
        <div class="flex items-center gap-1.5 text-cool">
          <BarChart3 :size="13" />
          <span class="font-label text-[10px] tracking-[0.12em] uppercase font-semibold">Total</span>
        </div>
        <p class="font-sans font-semibold text-2xl text-midnight dark:text-white tabular-nums mt-1" data-testid="checkout-stats-total">
          {{ stats?.total ?? 0 }}
        </p>
      </div>
      <!-- Conversion -->
      <div class="rounded-lg bg-mist/40 dark:bg-white/3 ring-1 ring-haze/60 dark:ring-white/8 p-3">
        <div class="flex items-center gap-1.5 text-cool">
          <Percent :size="13" />
          <span class="font-label text-[10px] tracking-[0.12em] uppercase font-semibold">Conversion</span>
        </div>
        <p class="font-sans font-semibold text-2xl text-midnight dark:text-white tabular-nums mt-1" data-testid="checkout-stats-conversion">
          {{ conversionPct ?? '—' }}<span v-if="conversionPct" class="text-base text-cool/70">%</span>
        </p>
      </div>
      <!-- Settled -->
      <div class="rounded-lg bg-positive/8 ring-1 ring-positive/25 p-3">
        <div class="flex items-center gap-1.5 text-positive">
          <Activity :size="13" />
          <span class="font-label text-[10px] tracking-[0.12em] uppercase font-semibold">Settled</span>
        </div>
        <p class="font-sans font-semibold text-2xl text-positive tabular-nums mt-1" data-testid="checkout-stats-settled">
          {{ settled }}
        </p>
      </div>
      <!-- Trend -->
      <div class="rounded-lg bg-mist/40 dark:bg-white/3 ring-1 ring-haze/60 dark:ring-white/8 p-3">
        <div class="flex items-center gap-1.5 text-cool">
          <TrendingUp :size="13" />
          <span class="font-label text-[10px] tracking-[0.12em] uppercase font-semibold">Trend</span>
        </div>
        <div
          class="h-12 mt-1"
          data-testid="checkout-stats-trend"
          :aria-label="stats && stats.daily.length > 0
            ? `Daily session count over ${stats.daily.length} days, ${stats.daily.reduce((a, b) => a + b.count, 0)} sessions total`
            : 'No daily session activity yet'"
          role="img"
        >
          <Line v-if="stats && stats.daily.length > 0" :data="chartData" :options="chartOptions" />
          <div v-else class="h-full flex items-center text-[11px] text-cool/60">
            No activity yet.
          </div>
        </div>
      </div>
    </div>

    <!-- Status breakdown row -->
    <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-sans text-cool">
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-gold" />
        Pending {{ pending }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-compute dark:bg-signal" />
        In flight {{ inflight }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-cool" />
        Expired {{ expired }}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-negative" />
        Failed {{ failed }}
      </span>
    </div>
  </section>
</template>
