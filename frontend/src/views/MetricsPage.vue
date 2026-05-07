<script setup lang="ts">
/**
 * Wave 4 P9 — public metrics page.
 *
 * Unauthenticated dashboard. Renders aggregate counts only (no
 * cleartext amounts, no per-investor data). The privacy story IS
 * the metric: outsiders see throughput without amounts.
 *
 * Backend cache: 60s TTL — refresh button + auto-mount fetch are
 * sufficient. No polling.
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Bar, Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js'
import { ArrowLeft, RefreshCw, Lock, ExternalLink } from 'lucide-vue-next'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import { useAppStore } from '@/stores/app'
import {
  publicMetricsApi,
  type PublicMetricsDto,
} from '@/services/api'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
)

const router = useRouter()
const store = useAppStore()

const metrics = ref<PublicMetricsDto | null>(null)
const loading = ref(false)
const errored = ref(false)
const errorMessage = ref<string | null>(null)

async function load() {
  loading.value = true
  errored.value = false
  errorMessage.value = null
  try {
    metrics.value = await publicMetricsApi.get()
  } catch (e) {
    errored.value = true
    errorMessage.value = e instanceof Error ? e.message : 'Unknown error'
    metrics.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ── Helpers ─────────────────────────────────────────────────────────

const generatedAtLabel = computed(() => {
  if (!metrics.value) return ''
  const d = new Date(metrics.value.generatedAt)
  return `${d.toUTCString()} (cached up to 60s)`
})

const heroCounters = computed(() => {
  if (!metrics.value) return []
  const m = metrics.value
  return [
    { label: 'Purchases', value: m.purchases.total, hint: 'cumulative Acquisition events' },
    { label: 'Yield distributions', value: m.yieldDistributions.total, hint: 'cumulative IncomeAccrual events' },
    { label: 'Wrap + Unwrap', value: m.wrapUnwrap.wrapTotal + m.wrapUnwrap.unwrapTotal, hint: 'cash conversions' },
    { label: 'Redemptions', value: m.redemptions.total, hint: 'cumulative Disposition events' },
  ]
})

// ── Chart palettes ──────────────────────────────────────────────────

interface Palette {
  primary: string
  secondary: string
  tertiary: string
  grid: string
  ticks: string
  tooltipBg: string
  tooltipTitle: string
  tooltipBody: string
  tooltipBorder: string
}

const palette = computed<Palette>(() => ({
  primary: store.isDark ? '#FFDCA1' : '#B8860B',
  secondary: store.isDark ? '#FFBA20' : '#9a6f08',
  tertiary: store.isDark ? '#A8C5F5' : '#3F5C8C',
  grid: store.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(184,134,11,0.10)',
  ticks: '#9E8F78',
  tooltipBg: store.isDark ? '#1A1B1E' : '#FFFDF7',
  tooltipTitle: store.isDark ? '#FFDCA1' : '#B8860B',
  tooltipBody: store.isDark ? '#FAF5E8' : '#121315',
  tooltipBorder: store.isDark ? 'rgba(255,186,32,0.25)' : 'rgba(184,134,11,0.25)',
}))

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// Each chart's data must be reactive on store.isDark + metrics.

const purchaseDailyChart = computed(() => {
  if (!metrics.value) return null
  const days = metrics.value.purchases.byDay
  return {
    data: {
      labels: days.map((d) => d.day),
      datasets: [
        {
          label: 'Purchases',
          data: days.map((d) => d.count),
          backgroundColor: palette.value.primary,
          borderRadius: 4,
        },
      ],
    },
    options: barOptions(palette.value),
  }
})

const wrapUnwrapChart = computed(() => {
  if (!metrics.value) return null
  const days = metrics.value.wrapUnwrap.byDay
  return {
    data: {
      labels: days.map((d) => d.day),
      datasets: [
        {
          label: 'Wrap',
          data: days.map((d) => d.wrap),
          backgroundColor: palette.value.primary,
          borderRadius: 4,
          stack: 'stack0',
        },
        {
          label: 'Unwrap',
          data: days.map((d) => d.unwrap),
          backgroundColor: palette.value.tertiary,
          borderRadius: 4,
          stack: 'stack0',
        },
      ],
    },
    options: stackedBarOptions(palette.value),
  }
})

const redemptionByDayChart = computed(() => {
  if (!metrics.value) return null
  const days = metrics.value.redemptions.byDay
  return {
    data: {
      labels: days.map((d) => d.day),
      datasets: [
        {
          label: 'Instant',
          data: days.map((d) => d.instant),
          backgroundColor: palette.value.primary,
          borderRadius: 4,
          stack: 'stack0',
        },
        {
          label: 'Queued',
          data: days.map((d) => d.queued),
          backgroundColor: palette.value.secondary,
          borderRadius: 4,
          stack: 'stack0',
        },
        {
          label: 'Escalated',
          data: days.map((d) => d.escalated),
          backgroundColor: palette.value.tertiary,
          borderRadius: 4,
          stack: 'stack0',
        },
      ],
    },
    options: stackedBarOptions(palette.value),
  }
})

const navCharts = computed(() => {
  if (!metrics.value) return []
  return metrics.value.navHistory.map((series) => ({
    tokenAddress: series.tokenAddress,
    symbol: series.symbol,
    data: {
      labels: series.points.map((p) =>
        new Date(p.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ),
      datasets: [
        {
          label: `${series.symbol} NAV`,
          data: series.points.map((p) => parseFloat(p.nav)),
          borderColor: palette.value.primary,
          backgroundColor: store.isDark ? 'rgba(255,220,161,0.08)' : 'rgba(184,134,11,0.10)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: lineOptions(palette.value),
  }))
})

function barOptions(p: Palette) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: tooltipConfig(p),
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, maxRotation: 0, autoSkip: true } },
      y: { grid: { color: p.grid }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, precision: 0 } },
    },
  }
}

function stackedBarOptions(p: Palette) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, boxWidth: 10 },
      },
      tooltip: tooltipConfig(p),
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, maxRotation: 0, autoSkip: true } },
      y: { stacked: true, grid: { color: p.grid }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, precision: 0 } },
    },
  }
}

function lineOptions(p: Palette) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' as const },
    plugins: {
      legend: { display: false },
      tooltip: tooltipConfig(p),
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { grid: { color: p.grid }, ticks: { color: p.ticks, font: { family: 'Inter Variable', size: 11 } } },
    },
  }
}

function tooltipConfig(p: Palette) {
  return {
    backgroundColor: p.tooltipBg,
    titleColor: p.tooltipTitle,
    bodyColor: p.tooltipBody,
    borderColor: p.tooltipBorder,
    borderWidth: 1,
    padding: 12,
    bodyFont: { family: 'Inter Variable' },
  }
}

// Empty-state helpers
function isEmpty<T>(arr: T[] | undefined | null): boolean {
  return !arr || arr.length === 0
}
</script>

<template>
  <div class="min-h-screen pb-24" data-testid="metrics-page">
    <!-- ── Header ──────────────────────────────────────────────── -->
    <header class="border-b border-haze/40 dark:border-white/6">
      <div class="max-w-6xl mx-auto px-6 md:px-12 pt-10 pb-8">
        <button
          type="button"
          class="inline-flex items-center gap-2 text-sm text-cool hover:text-compute dark:hover:text-signal transition-colors mb-6 cursor-pointer"
          @click="router.push('/')"
        >
          <ArrowLeft :size="14" />
          <span>Back to landing</span>
        </button>

        <div class="flex flex-wrap items-start justify-between gap-6">
          <div class="max-w-2xl">
            <div class="flex items-center gap-3 mb-3">
              <h1 class="font-sans font-extrabold text-3xl md:text-4xl tracking-tight text-midnight dark:text-[#e3e2e5]">
                Public Metrics
              </h1>
              <MBadge variant="teal">Live · Arb Sepolia</MBadge>
            </div>
            <p class="font-body text-base text-slate dark:text-[#d5c4ab] leading-relaxed">
              Aggregate platform throughput. Counts of purchases, yield distributions,
              cash conversions, and redemptions — but
              <span class="font-medium text-compute dark:text-signal">never the amounts</span>.
              Per-investor data and cleartext USDC volumes never leave the FHE coprocessor.
            </p>
          </div>
          <MButton
            variant="ghost"
            size="sm"
            :disabled="loading"
            data-testid="metrics-refresh"
            @click="load"
          >
            <RefreshCw :size="14" :class="loading ? 'animate-spin' : ''" />
            Refresh
          </MButton>
        </div>

        <div
          v-if="metrics"
          class="mt-4 flex items-center gap-2 text-xs text-cool"
          data-testid="metrics-generated-at"
        >
          <Lock :size="12" />
          <span>Generated {{ generatedAtLabel }}</span>
        </div>
      </div>
    </header>

    <main class="max-w-6xl mx-auto px-6 md:px-12 mt-10 space-y-10">
      <!-- ── Loading / Error states ─────────────────────────────── -->
      <div v-if="loading && !metrics" class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MCard v-for="i in 4" :key="i" class="h-28 animate-pulse">
          <div class="h-full" />
        </MCard>
      </div>

      <MCard v-else-if="errored" class="border border-red-500/30" data-testid="metrics-error">
        <div class="flex flex-col gap-3">
          <span class="font-sans text-base font-medium">Could not load metrics</span>
          <span class="font-body text-sm text-cool">{{ errorMessage ?? 'Unknown error' }}</span>
          <MButton variant="ghost" size="sm" class="self-start" @click="load">Retry</MButton>
        </div>
      </MCard>

      <template v-else-if="metrics">
        <!-- ── Row 1: Hero counters ───────────────────────────────── -->
        <section data-testid="metrics-hero-counters">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MCard
              v-for="(c, i) in heroCounters"
              :key="c.label"
              class="text-center"
              :data-testid="`metrics-hero-${i}`"
            >
              <div class="text-3xl md:text-4xl font-sans font-extrabold text-compute dark:text-signal tabular-nums">
                {{ c.value.toLocaleString('en-US') }}
              </div>
              <div class="font-sans text-xs uppercase tracking-wider text-cool mt-2">
                {{ c.label }}
              </div>
              <div class="font-body text-[11px] text-cool/70 mt-1">{{ c.hint }}</div>
            </MCard>
          </div>
        </section>

        <!-- ── Row 2: Daily purchases ─────────────────────────────── -->
        <section data-testid="metrics-purchases-row">
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <MCard class="lg:col-span-2">
              <div class="flex items-center justify-between mb-4">
                <div>
                  <h2 class="font-sans font-semibold text-base">Daily purchases</h2>
                  <p class="font-body text-xs text-cool mt-0.5">
                    Acquisition events per day, all-time.
                  </p>
                </div>
                <span class="font-sans text-xs text-cool">{{ metrics.purchases.total.toLocaleString('en-US') }} total</span>
              </div>
              <div v-if="isEmpty(metrics.purchases.byDay)" class="h-[220px] flex items-center justify-center" data-testid="metrics-purchases-empty">
                <span class="font-body text-sm text-cool">No purchases yet</span>
              </div>
              <div v-else class="h-[220px]">
                <Bar v-if="purchaseDailyChart" :data="purchaseDailyChart.data" :options="(purchaseDailyChart.options as any)" />
              </div>
            </MCard>
            <MCard>
              <h2 class="font-sans font-semibold text-base mb-4">By token</h2>
              <ul v-if="!isEmpty(metrics.purchases.byToken)" class="space-y-2" data-testid="metrics-purchases-by-token">
                <li
                  v-for="row in metrics.purchases.byToken"
                  :key="row.tokenAddress"
                  class="flex items-center justify-between text-sm"
                >
                  <div class="flex flex-col">
                    <span class="font-sans font-medium">{{ row.symbol }}</span>
                    <span class="font-mono text-[10px] text-cool/80">{{ shortAddr(row.tokenAddress) }}</span>
                  </div>
                  <span class="font-sans font-semibold text-compute dark:text-signal tabular-nums">
                    {{ row.count.toLocaleString('en-US') }}
                  </span>
                </li>
              </ul>
              <div v-else class="h-32 flex items-center justify-center text-sm text-cool" data-testid="metrics-purchases-by-token-empty">
                No purchases yet
              </div>
            </MCard>
          </div>
        </section>

        <!-- ── Row 3: Wrap / Unwrap ────────────────────────────────── -->
        <section data-testid="metrics-wrap-row">
          <MCard>
            <div class="flex items-center justify-between mb-4">
              <div>
                <h2 class="font-sans font-semibold text-base">Cash conversions</h2>
                <p class="font-body text-xs text-cool mt-0.5">
                  Wrap (USDC → mhUSDC) and unwrap (mhUSDC → USDC) events per day. Encrypted amounts.
                </p>
              </div>
              <div class="flex gap-3 text-xs">
                <span class="text-cool">Wrap <span class="font-semibold text-compute dark:text-signal">{{ metrics.wrapUnwrap.wrapTotal.toLocaleString('en-US') }}</span></span>
                <span class="text-cool">Unwrap <span class="font-semibold text-compute dark:text-signal">{{ metrics.wrapUnwrap.unwrapTotal.toLocaleString('en-US') }}</span></span>
              </div>
            </div>
            <div v-if="isEmpty(metrics.wrapUnwrap.byDay)" class="h-[220px] flex items-center justify-center" data-testid="metrics-wrap-empty">
              <span class="font-body text-sm text-cool">No conversions yet</span>
            </div>
            <div v-else class="h-[260px]">
              <Bar v-if="wrapUnwrapChart" :data="wrapUnwrapChart.data" :options="(wrapUnwrapChart.options as any)" />
            </div>
          </MCard>
        </section>

        <!-- ── Row 4: Redemptions ──────────────────────────────────── -->
        <section data-testid="metrics-redemptions-row">
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <MCard>
              <h2 class="font-sans font-semibold text-base mb-4">Redemption mix</h2>
              <ul class="space-y-3">
                <li class="flex items-center justify-between">
                  <span class="font-sans text-sm text-slate dark:text-[#d5c4ab]">Instant</span>
                  <span class="font-sans font-semibold text-compute dark:text-signal tabular-nums">
                    {{ metrics.redemptions.instant.toLocaleString('en-US') }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="font-sans text-sm text-slate dark:text-[#d5c4ab]">Queued</span>
                  <span class="font-sans font-semibold text-compute dark:text-signal tabular-nums">
                    {{ metrics.redemptions.queued.toLocaleString('en-US') }}
                  </span>
                </li>
                <li class="flex items-center justify-between">
                  <span class="font-sans text-sm text-slate dark:text-[#d5c4ab]">Escalated to queue</span>
                  <span class="font-sans font-semibold text-compute dark:text-signal tabular-nums">
                    {{ metrics.redemptions.escalatedToQueue.toLocaleString('en-US') }}
                  </span>
                </li>
              </ul>
              <div class="mt-4 pt-3 border-t border-haze/40 dark:border-white/6 flex items-center justify-between">
                <span class="font-sans text-sm text-cool uppercase tracking-wider">Total</span>
                <span class="font-sans font-extrabold text-2xl text-midnight dark:text-[#e3e2e5] tabular-nums">
                  {{ metrics.redemptions.total.toLocaleString('en-US') }}
                </span>
              </div>
            </MCard>
            <MCard class="lg:col-span-2">
              <div class="flex items-center justify-between mb-4">
                <div>
                  <h2 class="font-sans font-semibold text-base">Redemptions by day</h2>
                  <p class="font-body text-xs text-cool mt-0.5">
                    Stacked by kind (instant vs queued vs escalated).
                  </p>
                </div>
              </div>
              <div v-if="isEmpty(metrics.redemptions.byDay)" class="h-[220px] flex items-center justify-center" data-testid="metrics-redemptions-empty">
                <span class="font-body text-sm text-cool">No redemptions yet</span>
              </div>
              <div v-else class="h-[260px]">
                <Bar v-if="redemptionByDayChart" :data="redemptionByDayChart.data" :options="(redemptionByDayChart.options as any)" />
              </div>
            </MCard>
          </div>
        </section>

        <!-- ── Row 5: NAV history per token ────────────────────────── -->
        <section data-testid="metrics-nav-row">
          <h2 class="font-sans font-semibold text-base mb-4">NAV history (90 days)</h2>
          <div v-if="navCharts.length === 0" class="text-sm text-cool" data-testid="metrics-nav-empty">
            No NAV samples yet.
          </div>
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MCard
              v-for="series in navCharts"
              :key="series.tokenAddress"
              :data-testid="`metrics-nav-card-${series.symbol}`"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex flex-col">
                  <span class="font-sans font-semibold text-base">{{ series.symbol }}</span>
                  <span class="font-mono text-[10px] text-cool/80">{{ shortAddr(series.tokenAddress) }}</span>
                </div>
                <span class="font-sans text-xs text-cool">{{ series.data.labels.length }} samples</span>
              </div>
              <div v-if="series.data.labels.length === 0" class="h-[180px] flex items-center justify-center">
                <span class="font-body text-sm text-cool">No NAV history yet</span>
              </div>
              <div v-else class="h-[180px]">
                <Line :data="series.data" :options="(series.options as any)" />
              </div>
            </MCard>
          </div>
        </section>

        <!-- ── Footer ──────────────────────────────────────────────── -->
        <footer class="pt-10 border-t border-haze/40 dark:border-white/6">
          <div class="flex flex-wrap items-center justify-between gap-4 text-xs text-cool">
            <div class="flex flex-wrap items-center gap-4">
              <span>MuHaven · Confidential RWA portfolios on Fhenix CoFHE</span>
              <a
                href="https://github.com/hasToDev/muhaven"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 hover:text-compute dark:hover:text-signal transition-colors"
              >
                Repository <ExternalLink :size="11" />
              </a>
            </div>
            <span class="font-mono">arbitrum-sepolia · chainId 421614</span>
          </div>
        </footer>
      </template>
    </main>
  </div>
</template>
