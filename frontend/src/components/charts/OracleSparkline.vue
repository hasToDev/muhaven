<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { useOracleTokensStore } from '@/stores/oracle-tokens'
import { useAppStore } from '@/stores/app'

/**
 * Q4 — Tiny SVG sparkline for marketplace cards. Hand-rolled rather
 * than vue-chartjs because chart.js's per-instance overhead is wasted
 * at 80×30px (no axes, no tooltips, no legend). One Path element per
 * sparkline keeps the marketplace grid (~11 cards) cheap.
 *
 * Fetch model:
 *  - Self-fetches on mount + when props change. The parent (card) just
 *    declares "show a sparkline for THIS measure" and the component
 *    handles the network round-trip + store cache.
 *  - Silent failure mode: empty / error / loading all render a thin
 *    dashed baseline placeholder so the card height stays stable. We
 *    don't surface error copy on a sparkline — it's a decorative trend
 *    indicator, not a load-bearing chart.
 *
 * a11y:
 *  - `role="img"` on the SVG + `aria-label` summarising trend so AT
 *    users get a textual hint ("apy_7_day trending up: 3.10% to 3.13%").
 */

interface Props {
  ticker: string
  measure: string
  /** Defaults to 90 trailing days. */
  days?: number
  /**
   * Unit category for the values. Drives the AT label formatter so the
   * announcement reads "3.10% to 3.13%" not the unit-less "3.10 to 3.13".
   * Caller knows this because it picked the measure based on a known
   * variant (yield-bearing → 'pct', non-yield → 'usd').
   */
  kind?: 'pct' | 'usd' | 'raw'
  /**
   * Human-readable label for the measure (e.g. "7D APY", "Price"). Used
   * in the aria-label so screen readers announce "7D APY trend over 90
   * days" instead of "apy_7_day trend over 90 days" (which is read as
   * "A P Y underscore 7 underscore day"). Falls back to the raw slug
   * when omitted.
   */
  label?: string
  /** Optional visual override. Default chooses by light/dark theme. */
  colorClass?: string
}
const props = withDefaults(defineProps<Props>(), { days: 90, kind: 'raw' })

// Friendly name for AT announcements. Used in `aria-label` so the
// sparkline isn't read with underscores.
const measureName = computed(() => props.label ?? props.measure)

const store = useOracleTokensStore()
const app = useAppStore()

interface Point { date: string; value: number }

const points = ref<Point[]>([])
const loading = ref(false)
const errored = ref(false)

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Monotonic request token — guards against stale-write when props
// change mid-flight (e.g. marketplace filter re-keys cards) or the
// card unmounts before the fetch settles. Cheaper than AbortController
// for the marketplace's 11-card fan-out.
let _reqId = 0

// Viewport-lazy fetch: don't fire `loadTimeseries` until the sparkline
// SVG enters the viewport (within a 100px rootMargin so cards
// just-below-the-fold prefetch as the user starts scrolling). On the
// initial marketplace paint this cuts fan-out from ~11 to ~6, matching
// what the user actually sees. The store cache survives subsequent
// scroll-out/scroll-in, so once loaded a card never re-fetches.
const wrapper = useTemplateRef<HTMLDivElement>('wrapper')
const hasFetched = ref(false)

async function load() {
  const myReq = ++_reqId
  loading.value = true
  errored.value = false
  try {
    const from = new Date()
    from.setUTCDate(from.getUTCDate() - props.days)
    const dto = await store.loadTimeseries(props.ticker, props.measure, {
      from: toIsoDate(from),
    })
    if (myReq !== _reqId) return
    points.value = dto.points
      .map((p) => ({ date: p.date, value: parseFloat(p.value) }))
      .filter((p) => Number.isFinite(p.value))
  } catch {
    if (myReq !== _reqId) return
    points.value = []
    errored.value = true
  } finally {
    if (myReq === _reqId) loading.value = false
  }
}

const { stop: stopObserver } = useIntersectionObserver(
  wrapper,
  ([entry]) => {
    if (entry?.isIntersecting && !hasFetched.value) {
      hasFetched.value = true
      load()
      // First viewport intersection wins; stop observing so the
      // callback doesn't re-fire on every scroll-back-into-view.
      stopObserver()
    }
  },
  { rootMargin: '100px' },
)

// Prop changes (e.g. marketplace filter swaps the ticker on a slot)
// re-arm the fetch — but only AFTER the card has been seen at least
// once. New cards still wait for viewport entry via the observer.
watch(
  () => [props.ticker, props.measure, props.days],
  () => {
    if (hasFetched.value) load()
  },
)

const WIDTH = 96
const HEIGHT = 32

const path = computed(() => {
  const pts = points.value
  if (pts.length < 2) return ''
  const values = pts.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1 // flat-line guard — draw a centred horizontal line
  const denom = pts.length - 1
  return pts
    .map((p, i) => {
      const x = (i / denom) * WIDTH
      const y = max === min ? HEIGHT / 2 : HEIGHT - ((p.value - min) / span) * HEIGHT
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
})

const areaPath = computed(() => {
  const p = path.value
  if (!p) return ''
  return `${p} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`
})

const direction = computed<'up' | 'down' | 'flat' | null>(() => {
  if (points.value.length < 2) return null
  const first = points.value[0].value
  const last = points.value[points.value.length - 1].value
  if (last > first) return 'up'
  if (last < first) return 'down'
  return 'flat'
})

const strokeColor = computed(() => {
  if (props.colorClass) return undefined // CSS class drives stroke instead
  return app.isDark ? '#FFDCA1' : '#B8860B'
})
const fillColor = computed(() => {
  if (props.colorClass) return undefined
  return app.isDark ? 'rgba(255,220,161,0.12)' : 'rgba(184,134,11,0.12)'
})
// Placeholder line uses explicit muted-warm hex per theme rather than
// `currentColor` + `text-cool/40` — the latter accidentally inherited
// link-hover state when the sparkline lives inside a RouterLink.
const placeholderColor = computed(() =>
  app.isDark ? 'rgba(255,253,247,0.18)' : 'rgba(158,143,120,0.45)',
)

function formatForLabel(v: number): string {
  if (props.kind === 'pct') return `${v.toFixed(2)}%`
  if (props.kind === 'usd') {
    if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
    return `$${v.toFixed(2)}`
  }
  return v.toPrecision(4)
}

const ariaLabel = computed(() => {
  if (loading.value) return `${measureName.value} sparkline loading`
  if (errored.value || points.value.length === 0) return `${measureName.value} sparkline unavailable`
  const first = points.value[0].value
  const last = points.value[points.value.length - 1].value
  return `${measureName.value} trend over last ${props.days} days: ${formatForLabel(first)} to ${formatForLabel(last)}, ${direction.value}`
})

const showPlaceholder = computed(
  () => loading.value || errored.value || points.value.length < 2,
)
</script>

<template>
  <div
    ref="wrapper"
    class="relative inline-block"
    :style="{ width: `${WIDTH}px`, height: `${HEIGHT}px` }"
    data-testid="oracle-sparkline"
    :data-ticker="props.ticker"
    :data-measure="props.measure"
    :data-direction="direction ?? ''"
    :data-point-count="points.length"
    :data-has-fetched="hasFetched"
  >
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      :width="WIDTH"
      :height="HEIGHT"
      preserveAspectRatio="none"
      role="img"
      :aria-label="ariaLabel"
      :aria-busy="loading || undefined"
      class="overflow-visible"
    >
      <!-- Placeholder: dashed centre-line keeps card geometry stable
           across loading / empty / error states. Explicit stroke (not
           currentColor) so the line doesn't inherit a parent link's
           hover color when the sparkline lives inside a RouterLink. -->
      <line
        v-if="showPlaceholder"
        :x1="0"
        :y1="HEIGHT / 2"
        :x2="WIDTH"
        :y2="HEIGHT / 2"
        :stroke="placeholderColor"
        stroke-width="1"
        stroke-dasharray="2 3"
      />
      <template v-else>
        <path
          :d="areaPath"
          :fill="fillColor"
          :class="props.colorClass"
        />
        <path
          :d="path"
          fill="none"
          :stroke="strokeColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          :class="props.colorClass"
        />
      </template>
    </svg>
  </div>
</template>
