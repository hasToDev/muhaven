<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Filler, Tooltip,
  type ChartOptions, type TooltipItem,
} from 'chart.js'
import { useAppStore } from '@/stores/app'
import { useOracleTokensStore } from '@/stores/oracle-tokens'
import { ApiError } from '@/services/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

/**
 * Q4 — Full historical chart for the token detail page. Reuses the
 * vue-chartjs pattern from `NavTrendChart.vue` for visual parity, but
 * sources from the oracle layer's `/api/v1/oracle/tokens/:ticker/
 * timeseries` endpoint and adds:
 *   - measure toggle (APY 7D, NAV, Price, TVL, ...) with the candidate
 *     set branched by `is_yield_bearing`
 *   - range toggle (30D / 90D / 1Y / All)
 *
 * Empty-data per measure: we render the empty state inline rather than
 * hide the toggle, because some assets have a partial measure set
 * (e.g. BUIDL has no `price_dollar`). The toggle stays visible so the
 * UI is consistent across the catalog; the chart pane explains the
 * gap with copy.
 */

interface Props {
  ticker: string
  isYieldBearing: boolean
  /**
   * Measure slugs the asset actually publishes (from
   * `OracleTokenMetadataDto.published_measures`). Toggles for slugs
   * NOT in this set render disabled — saves the user a click into a
   * guaranteed-empty state and surfaces availability up front. Pass
   * an empty array to disable all buttons (no timeseries ingested).
   * Omit the prop when the parent doesn't have the metadata loaded
   * yet — the chart treats `undefined` as "trust the toggle, fetch
   * and discover" (Q4-pre-published_measures behaviour).
   */
  publishedMeasures?: string[]
}
const props = defineProps<Props>()

const publishedSet = computed(
  () => props.publishedMeasures ? new Set(props.publishedMeasures) : null,
)
function isPublished(slug: string): boolean {
  // When the parent didn't pass the set yet, every measure is treated
  // as available — the chart falls back to fetch-and-discover, exactly
  // the pre-published_measures behaviour.
  return publishedSet.value ? publishedSet.value.has(slug) : true
}

const app = useAppStore()
const store = useOracleTokensStore()

// Measure metadata — label, kind (controls Y-axis + tooltip formatter).
// `kind: 'pct'` formats as percent; `'usd'` as dollar.
type MeasureKind = 'pct' | 'usd'
interface MeasureSpec { slug: string; label: string; kind: MeasureKind }

const YIELD_MEASURES: MeasureSpec[] = [
  { slug: 'apy_7_day', label: '7D APY', kind: 'pct' },
  { slug: 'apy_30_day', label: '30D APY', kind: 'pct' },
  { slug: 'net_asset_value_dollar', label: 'NAV', kind: 'usd' },
  { slug: 'price_dollar', label: 'Price', kind: 'usd' },
  { slug: 'bridged_token_value_dollar', label: 'TVL', kind: 'usd' },
]
const NON_YIELD_MEASURES: MeasureSpec[] = [
  { slug: 'price_dollar', label: 'Price', kind: 'usd' },
  { slug: 'net_asset_value_dollar', label: 'NAV', kind: 'usd' },
  { slug: 'hypothetical_10_000_performance', label: '$10K Return', kind: 'usd' },
  { slug: 'bridged_token_value_dollar', label: 'TVL', kind: 'usd' },
]

const measures = computed<MeasureSpec[]>(
  () => props.isYieldBearing ? YIELD_MEASURES : NON_YIELD_MEASURES,
)

type RangeKey = '30D' | '90D' | '1Y' | 'ALL'
const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '30D', label: '30D', days: 30 },
  { key: '90D', label: '90D', days: 90 },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'All', days: null },
]

// Seed selected measure to the first PUBLISHED measure in the variant
// — otherwise a yield-bearing token like BUIDL (no `price_dollar`)
// could land on a slug that's locally disabled. Falls back to the
// first measure in the menu when the set isn't loaded yet.
function firstAvailable(): MeasureSpec {
  const list = measures.value
  if (publishedSet.value) {
    const found = list.find((m) => publishedSet.value!.has(m.slug))
    if (found) return found
  }
  return list[0]
}
const selectedMeasure = ref<MeasureSpec>(firstAvailable())
const selectedRange = ref<RangeKey>('90D')

// Tight trigger: only re-seat the selected measure when the
// yield-bearing branch actually flips. Watching `measures` directly
// would fire on any computed re-evaluation that produced a new array
// identity — including refactors that don't change the menu.
watch(() => props.isYieldBearing, () => {
  selectedMeasure.value = firstAvailable()
})
// Late-arriving publishedMeasures: if the parent finishes loading
// metadata AFTER the chart mounted, and the currently selected slug
// is disabled in the new set, bump to the first available one. The
// load watcher above then fires for the new measure. Skip the
// re-seat if the current selection is already valid — but still
// kick a load() if the chart deferred initial fetch waiting for this.
watch(publishedSet, (set, prev) => {
  if (!set) return
  if (!set.has(selectedMeasure.value.slug)) {
    selectedMeasure.value = firstAvailable()
    // Re-seat triggers the load watcher; no manual load() needed.
    return
  }
  // Same slug stays selected, but if this was the deferred-initial
  // path (prev=null → set arrived) we still owe the user a fetch.
  if (prev === null) load()
})

interface Point { date: string; value: number }
const points = ref<Point[]>([])
const loading = ref(false)
const errored = ref(false)
const errorCopy = ref<string | null>(null)
// True when the failure is a permanent state for this (ticker, measure,
// range) tuple — 404 ticker, 400 query too large — so the retry button
// is suppressed (retrying would just fail the same way).
const errorIsTerminal = ref(false)

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

let _reqId = 0

async function load() {
  // Skip the fetch when the parent's published-measures set says this
  // measure isn't available for this ticker — we already know the
  // response would be empty (or 404), so spare the round-trip and
  // surface a clean terminal-error state. The disabled toggle should
  // make this path practically unreachable, but a late metadata
  // arrival or an explicit prop drive could land us here.
  if (publishedSet.value && !publishedSet.value.has(selectedMeasure.value.slug)) {
    points.value = []
    errored.value = true
    errorCopy.value = `${props.ticker} does not publish a ${selectedMeasure.value.label} series.`
    errorIsTerminal.value = true
    loading.value = false
    return
  }
  const myReq = ++_reqId
  loading.value = true
  errored.value = false
  errorCopy.value = null
  errorIsTerminal.value = false
  try {
    const days = RANGES.find((r) => r.key === selectedRange.value)?.days ?? null
    const range = days !== null
      ? (() => {
          const d = new Date()
          d.setUTCDate(d.getUTCDate() - days)
          return { from: toIsoDate(d) }
        })()
      : undefined
    const dto = await store.loadTimeseries(
      props.ticker,
      selectedMeasure.value.slug,
      range,
    )
    if (myReq !== _reqId) return
    // Unit-drift defence: if rwa.xyz back-corrects a series so the unit
    // changes mid-flight (e.g. APY switches from percent to decimal),
    // the Y-axis formatter — keyed off the static measure kind, not the
    // per-point unit — would mislead. Surface a console warning and
    // proceed with what we have; the chart still renders but the
    // diagnostic lands in operator logs.
    const units = new Set(dto.points.map((p) => p.unit).filter((u): u is string => !!u))
    if (units.size > 1) {
      console.warn(
        `[OracleTimeseriesChart] unit drift on ${props.ticker}/${selectedMeasure.value.slug}: ${Array.from(units).join(', ')}`,
      )
    }
    points.value = dto.points
      .map((p) => ({ date: p.date, value: parseFloat(p.value) }))
      .filter((p) => Number.isFinite(p.value))
  } catch (e) {
    if (myReq !== _reqId) return
    // Log raw for diagnostics; show targeted copy keyed on HTTP status
    // so users get a path forward where one exists (range too large →
    // try shorter range) and no false hope where none does (404 ticker
    // → retrying is futile, hide the button).
    console.error('[OracleTimeseriesChart] load failed', e)
    points.value = []
    errored.value = true
    if (e instanceof ApiError) {
      if (e.status === 404) {
        errorCopy.value = `Series unavailable for ${props.ticker}.`
        errorIsTerminal.value = true
      } else if (e.status === 400) {
        // Backend's RFC-7807 detail is specific (e.g. "Query would return
        // more than 10000 points; narrow with 'from'/'to'.") — surface
        // it verbatim. Bad input is permanent for this (measure, range);
        // retry button won't help.
        errorCopy.value = e.message
        errorIsTerminal.value = true
      } else {
        errorCopy.value = 'Could not load chart'
      }
    } else {
      errorCopy.value = 'Could not load chart'
    }
  } finally {
    if (myReq === _reqId) loading.value = false
  }
}

// Skip the initial onMounted fetch when the parent hasn't passed
// publishedMeasures yet — the publishedSet watcher below will fire
// load() once it arrives (and re-seat selectedMeasure if the default
// isn't available). This avoids a double-load (fetch under
// fall-through default → publishedSet arrives → re-seat → fetch
// again). When the parent ISN'T using publishedMeasures at all, the
// initial mount loads immediately as before.
onMounted(() => {
  if (props.publishedMeasures === undefined || publishedSet.value !== null) {
    load()
  }
})
watch(
  () => [props.ticker, selectedMeasure.value.slug, selectedRange.value],
  load,
)

const hasData = computed(() => points.value.length > 0)
const isAllRange = computed(() => selectedRange.value === 'ALL')

// Two-tier empty copy:
//  - ALL range with no points → the token doesn't publish this measure
//    at all (e.g. BUIDL has no `price_dollar`). No range will help.
//  - Narrower range with no points → suggest widening the range.
const RANGE_WORDS: Record<RangeKey, string> = {
  '30D': '30 days',
  '90D': '90 days',
  '1Y': 'year',
  ALL: 'series',
}
const emptyMessage = computed(() => {
  if (isAllRange.value) {
    return `${props.ticker} does not publish a ${selectedMeasure.value.label} series.`
  }
  return `No ${selectedMeasure.value.label} data in the last ${RANGE_WORDS[selectedRange.value]}. Try a longer range.`
})

// Visually-hidden data summary for screen readers — canvas-rendered
// charts are opaque to AT, so this is the load-bearing accessibility
// affordance. Kept compact (head + tail + count) instead of full table
// to avoid noisy verbosity on 365+ point series.
const a11ySummary = computed(() => {
  if (!hasData.value) return ''
  const first = points.value[0]
  const last = points.value[points.value.length - 1]
  const dir = last.value > first.value ? 'up'
    : last.value < first.value ? 'down'
    : 'flat'
  return `${selectedMeasure.value.label} over ${selectedRange.value}: ` +
    `${formatY(first.value)} on ${first.date} to ${formatY(last.value)} on ${last.date}, trending ${dir}. ` +
    `${points.value.length} data point${points.value.length === 1 ? '' : 's'}.`
})

const labelFormat = computed<Intl.DateTimeFormatOptions>(() => {
  if (selectedRange.value === '30D' || selectedRange.value === '90D') {
    return { month: 'short', day: 'numeric' }
  }
  if (selectedRange.value === '1Y') {
    return { month: 'short', year: '2-digit' }
  }
  return { month: 'short', year: '2-digit' }
})

const lineColor = computed(() => app.isDark ? '#FFDCA1' : '#B8860B')
const fillColor = computed(() =>
  app.isDark ? 'rgba(255,220,161,0.08)' : 'rgba(184,134,11,0.10)',
)

function formatY(v: number): string {
  if (selectedMeasure.value.kind === 'pct') {
    return `${v.toFixed(2)}%`
  }
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

const chartData = computed(() => ({
  labels: points.value.map((p) =>
    new Date(p.date).toLocaleDateString('en-US', labelFormat.value),
  ),
  datasets: [{
    data: points.value.map((p) => p.value),
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

const tooltipColors = computed(() => app.isDark ? {
  bg: '#1A1B1E', title: '#FFDCA1', body: '#FAF5E8', border: 'rgba(255,186,32,0.25)',
} : {
  bg: '#FFFDF7', title: '#B8860B', body: '#121315', border: 'rgba(184,134,11,0.25)',
})

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { intersect: false, mode: 'index' },
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
        color: app.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(184,134,11,0.08)',
      },
      ticks: {
        color: '#9E8F78',
        font: { family: 'Inter Variable', size: 11 },
        callback: (v) => {
          const n = typeof v === 'number' ? v : parseFloat(String(v))
          return formatY(n)
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
        label: (ctx: TooltipItem<'line'>) =>
          `${selectedMeasure.value.label} ${formatY(ctx.parsed.y)}`,
      },
    },
  },
}))
</script>

<template>
  <section
    class="space-y-4"
    data-testid="oracle-timeseries-chart"
    :data-ticker="props.ticker"
    :data-measure="selectedMeasure.slug"
    :data-range="selectedRange"
    :data-point-count="points.length"
  >
    <!-- Toggle row — measure (left) + range (right). Stacks on narrow.
         Both groups use role="group" + aria-pressed (NOT role="tablist")
         because there's no panel switch — every selection re-fetches into
         the same canvas. The tablist pattern would obligate tabpanel +
         arrow-key navigation that doesn't exist here. -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div
        role="group"
        aria-label="Chart measure"
        class="flex flex-wrap gap-2"
      >
        <button
          v-for="m in measures"
          :key="m.slug"
          type="button"
          :aria-pressed="isPublished(m.slug) ? selectedMeasure.slug === m.slug : undefined"
          :aria-disabled="!isPublished(m.slug) || undefined"
          :data-testid="`chart-measure-${m.slug}`"
          :data-disabled="!isPublished(m.slug)"
          @click="isPublished(m.slug) && (selectedMeasure = m)"
          :class="[
            'font-sans text-xs font-bold tracking-wide px-4 py-1.5 rounded-full transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
            !isPublished(m.slug)
              ? 'cursor-not-allowed opacity-40 bg-mist/40 dark:bg-[#171717]/60 text-cool/60 dark:text-body-dark/30'
              : selectedMeasure.slug === m.slug
                ? 'cursor-pointer bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] shadow-sm'
                : 'cursor-pointer bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
          ]"
        >
          {{ m.label }}
          <!-- Reason exposed to AT via accessible name rather than the
               unreliable `title` attribute. Kept visually hidden so the
               pill geometry doesn't shift; sighted users see only the
               opacity-40 + cursor-not-allowed cues. -->
          <span v-if="!isPublished(m.slug)" class="sr-only">
            unavailable for {{ props.ticker }}
          </span>
        </button>
      </div>
      <div
        role="group"
        aria-label="Chart date range"
        class="flex gap-1 p-1 rounded-full bg-mist/60 dark:bg-[#171717] border border-haze/60 dark:border-white/5 self-start"
      >
        <button
          v-for="r in RANGES"
          :key="r.key"
          type="button"
          :aria-pressed="selectedRange === r.key"
          :data-testid="`chart-range-${r.key.toLowerCase()}`"
          @click="selectedRange = r.key"
          :class="[
            'font-sans text-[11px] font-bold tracking-wide px-3 py-1 rounded-full transition-colors cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
            selectedRange === r.key
              ? 'bg-white dark:bg-[#0d0e10] text-midnight dark:text-white shadow-sm'
              : 'text-cool hover:text-midnight dark:hover:text-white',
          ]"
        >
          {{ r.label }}
        </button>
      </div>
    </div>

    <!-- Chart pane — fixed height, loading/empty/error all swap inline.
         Visually-hidden summary carries the chart story for AT since
         canvas content is opaque to screen readers. -->
    <div class="relative" style="height: 300px" :aria-busy="loading || undefined">
      <div
        v-if="loading"
        class="h-full flex items-center justify-center"
        data-testid="oracle-chart-loading"
      >
        <span class="font-sans text-xs text-cool">Loading {{ selectedMeasure.label }}…</span>
      </div>
      <div
        v-else-if="errored"
        role="status"
        class="h-full flex flex-col items-center justify-center gap-2 px-6 text-center"
        data-testid="oracle-chart-error"
        :data-error-terminal="errorIsTerminal"
      >
        <span class="font-sans text-xs text-cool">{{ errorCopy ?? 'Could not load chart' }}</span>
        <!-- Retry only when the error is transient (5xx, network).
             404/400 are permanent for this (ticker, measure, range), so
             retrying is misleading UX — hide the button. -->
        <button
          v-if="!errorIsTerminal"
          type="button"
          @click="load"
          class="font-sans text-[11px] text-gold hover:underline cursor-pointer"
        >Retry</button>
      </div>
      <div
        v-else-if="!hasData"
        role="status"
        class="h-full flex items-center justify-center px-6 text-center"
        data-testid="oracle-chart-empty"
      >
        <span class="font-sans text-xs text-cool">{{ emptyMessage }}</span>
      </div>
      <template v-else>
        <!-- aria-live so toggle changes are re-announced. role="status"
             would imply polite live region but isn't allowed on <p>;
             aria-live on the element directly is the canonical form. -->
        <p
          class="sr-only"
          aria-live="polite"
          aria-atomic="true"
          data-testid="oracle-chart-summary"
        >{{ a11ySummary }}</p>
        <Line :data="chartData" :options="chartOptions" />
      </template>
    </div>
  </section>
</template>
