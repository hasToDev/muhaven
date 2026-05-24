<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useOracleTokensStore } from '@/stores/oracle-tokens'
import { useMarketplaceStore } from '@/stores/marketplace'
import {
  ApiError,
  type OracleTokenMetadataDto,
  type OracleSnapshotDto,
} from '@/services/api'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import TokenIcon from '@/components/ui/TokenIcon.vue'
import OracleTimeseriesChart from '@/components/charts/OracleTimeseriesChart.vue'
import {
  ArrowLeft, Globe, ShieldCheck, TrendingUp,
  Building2, FileText, Users, CircleDollarSign, ExternalLink, AlertCircle,
  LineChart, ArrowRight,
} from 'lucide-vue-next'

/**
 * Wave 5 Q1 — token detail page sourced from the oracle layer.
 *
 * Loading model:
 *  - Metadata + snapshot fetched in parallel via the Pinia store
 *    (deduplicates within a session; backend Cache-Control absorbs
 *    cross-session reload).
 *  - A snapshot 404 (legitimate "not ingested yet") is distinguished
 *    from a network/5xx error — the latter surfaces a soft inline
 *    warning while metadata still renders.
 *  - Race-safe: every load() bumps a request token; stale awaits
 *    silently discard their result so rapid /USYC → /BUIDL navigation
 *    can't paint USYC fields under the BUIDL URL.
 *
 * a11y:
 *  - H1 first (token name), then H2 sections — heading hierarchy
 *    correct top-to-bottom.
 *  - Focus moves to the "Back to marketplace" link on mount so
 *    AT users land on meaningful navigation.
 */

const props = defineProps<{ ticker: string }>()
const router = useRouter()
const oracle = useOracleTokensStore()
// Wave 5 1B: marketplace store bridges oracle ticker → on-chain rwa_tokens
// row so the Buy CTA can resolve a deep-link target + status gate.
// Loaded best-effort alongside metadata; render falls back to a
// no-on-chain-match disabled state when the bridge fails.
const marketplace = useMarketplaceStore()

const metadata = ref<OracleTokenMetadataDto | null>(null)
const snapshot = ref<OracleSnapshotDto | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const snapshotError = ref<string | null>(null)
const backLink = useTemplateRef<HTMLAnchorElement>('backLink')

// Monotonically-increasing request token — every load() captures the
// current value and bails on any await whose token has been
// superseded. Cheaper than AbortController for two parallel awaits and
// survives the case where one promise resolves AFTER another in-flight
// request has already swapped the URL.
let _reqId = 0

async function load() {
  const myReq = ++_reqId
  loading.value = true
  error.value = null
  snapshotError.value = null
  metadata.value = null
  snapshot.value = null
  try {
    // Metadata is the load-bearing fetch — if it fails, the whole
    // page falls through to the error state. Snapshot is best-effort.
    const meta = await oracle.loadMetadata(props.ticker)
    if (myReq !== _reqId) return
    metadata.value = meta

    try {
      const snap = await oracle.loadLatestSnapshot(props.ticker)
      if (myReq !== _reqId) return
      snapshot.value = snap
    } catch (e) {
      if (myReq !== _reqId) return
      // Distinguish "no snapshot yet" (404 — legitimate empty state)
      // from transient infrastructure failure. The page renders the
      // metadata block + a soft inline banner instead of conflating
      // them into a missing "Supply & Market" section.
      if (e instanceof ApiError && e.status === 404) {
        snapshot.value = null
      } else {
        snapshotError.value =
          e instanceof Error ? e.message : 'Snapshot temporarily unavailable'
      }
    }
  } catch (e) {
    if (myReq !== _reqId) return
    error.value = e instanceof Error ? e.message : 'Failed to load token'
  } finally {
    if (myReq === _reqId) loading.value = false
  }
}

onMounted(async () => {
  // Wave 5 1B: marketplace load is best-effort and parallel — a failure
  // here doesn't block the read-only detail render; the Buy CTA falls
  // back to a "Not yet listed on-chain" state. `loaded` guard avoids a
  // re-fetch when the user navigated here from /marketplace where the
  // store is already populated.
  const marketplaceTask = marketplace.loaded
    ? Promise.resolve()
    : marketplace.load().catch((e) => {
        console.warn('[TokenDetailPage] marketplace.load failed:', e)
      })
  await Promise.allSettled([load(), marketplaceTask])
  // Move focus to the back link so AT users land on meaningful nav
  // rather than the document body. nextTick so the link is in the DOM.
  await nextTick()
  backLink.value?.focus()
})

watch(() => props.ticker, load)

function formatDollarString(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return formatUSD(n)
}

function formatPercent(raw: string | null | undefined, digits = 2): string {
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

function formatTokenSupply(raw: string | null | undefined): string {
  // Note: parseFloat truncates to ~15 significant digits. The DB
  // stores `numeric(36,18)` strings for precision in arithmetic; the
  // render layer is intentionally lossy because supply abbreviated to
  // "2.64B" doesn't reveal sub-cent drift anyway.
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return n.toFixed(2)
}

function bpsToPct(bps: number | null): string {
  if (bps === null || bps === undefined) return '—'
  return `${(bps / 100).toFixed(2)}%`
}

const issuerLine = computed(() => {
  const m = metadata.value
  if (!m) return ''
  const parts: string[] = []
  if (m.issuer_name) parts.push(m.issuer_name)
  if (m.issuer_country) parts.push(m.issuer_country)
  return parts.join(' · ')
})

// ── Wave 5 1B — Buy CTA gating ──────────────────────────────────────────
//
// The on-chain row drives the action-row state. Branch precedence inside
// the template's `<template v-if="actionRowReady">`:
//
//   marketplaceUnavailable → neutral "Marketplace unavailable" pill.
//                            Keeps us from claiming "Not yet listed"
//                            when the real cause is a transient backend
//                            outage (Code Reviewer round-2 #2).
//   isBuyable              → gold-sweep CTA → /trade?token=<ticker>
//   isRetired              → "Winding down — view only" badge (mirrors
//                            TradePage.vue:112-122 retirement vocab)
//   else                   → disabled "Not yet listed on-chain" button
//
// Marketplace can still be loading on first paint; `actionRowReady` gates
// the row's CTA slot so the reserved space stays empty rather than
// flashing a definitive state during the brief in-flight window.
const onChainToken = computed(() =>
  metadata.value ? marketplace.getByTicker(metadata.value.ticker) : undefined,
)

// Treat the row as "ready to paint a CTA state" once we have either
// authoritative data (loaded) or a confirmed failure (error). The
// error branch resolves to a NEUTRAL state, never to "not yet listed".
const actionRowReady = computed(() => marketplace.loaded || !!marketplace.error)

// True only when the marketplace load failed AND we have no usable data
// to fall back on. If a previous successful load populated `tokens`, we
// keep serving that result even if the most recent refresh errored.
const marketplaceUnavailable = computed(
  () => !!marketplace.error && !marketplace.loaded,
)

const isBuyable = computed(() => onChainToken.value?.status === 'active')

const retirementLabel = computed(() => {
  const s = onChainToken.value?.status
  if (s === 'winding_down') return 'Winding down'
  if (s === 'paused') return 'Paused'
  if (s === 'archived') return 'Archived'
  return ''
})

const isRetired = computed(() => retirementLabel.value !== '')
</script>

<template>
  <div class="relative">
    <!-- Page ambient bloom -->
    <div
      aria-hidden="true"
      class="absolute top-0 right-0 w-[600px] h-[600px] rounded-full blur-[150px] pointer-events-none -z-0
             bg-gold/10 dark:bg-signal/8"
    />

    <MPageLoader
      v-if="loading"
      label="Loading token"
      :caption="`Reading ${props.ticker} metadata`"
    />

    <div v-else-if="error" class="relative z-10 flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ error }}</p>
      <div class="flex gap-3">
        <MButton variant="outline" @click="load">Retry</MButton>
        <MButton variant="outline" @click="router.push('/marketplace')">Back to marketplace</MButton>
      </div>
    </div>

    <div v-else-if="metadata" class="relative z-10 max-w-6xl">
      <!-- ═══════════════════════════════════════════════════════════
           Action row (Wave 5 1B) — back link on the left, primary Buy
           CTA on the right. `min-h-[6rem] sm:min-h-[3rem]` reserves
           vertical space so the row doesn't reflow when the async
           marketplace load resolves the on-chain status. The 6rem
           mobile reservation covers the stacked-flex case (back link
           ~16px + gap-3 12px + CTA ~48px ≈ 76px); the 3rem desktop
           reservation covers the side-by-side row (~48px tall).
           Right slot stays empty during the load instead of flashing
           a definitive state. Primary CTA gets full tap width on
           mobile (≥44px target for WCAG 2.5.5/2.5.8).
           ═══════════════════════════════════════════════════════════ -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-6 min-h-[6rem] sm:min-h-[3rem]">
        <RouterLink
          ref="backLink"
          to="/marketplace"
          tabindex="0"
          class="inline-flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold
                 text-cool hover:text-midnight dark:hover:text-white transition-colors
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40 rounded
                 self-start sm:self-auto"
        >
          <ArrowLeft :size="14" :stroke-width="2" aria-hidden="true" />
          Back to marketplace
        </RouterLink>

        <!-- Right slot: marketplace-down / enabled buy / retired badge /
             not-yet-listed disabled button / empty during load. Branch
             precedence keeps a transient marketplace failure from
             surfacing a definitive "Not yet listed" claim. -->
        <template v-if="actionRowReady">
          <div
            v-if="marketplaceUnavailable"
            data-testid="detail-buy-unavailable-infra"
            role="status"
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                   bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                   font-sans text-[11px] font-bold uppercase tracking-wider text-slate dark:text-body-dark/80"
          >
            <AlertCircle :size="13" :stroke-width="2" aria-hidden="true" />
            Marketplace unavailable
          </div>

          <RouterLink
            v-else-if="isBuyable"
            :to="`/trade?token=${metadata.ticker}`"
            data-testid="detail-buy-cta"
            :aria-label="`Buy ${metadata.display_name} (${metadata.ticker})`"
            class="btn-gold-sweep inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-sans font-extrabold text-sm tracking-wide cursor-pointer
                   transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99] motion-reduce:transition-none motion-reduce:hover:translate-y-0
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 dark:focus-visible:ring-signal/50
                   w-full sm:w-auto"
          >
            Buy {{ metadata.ticker }}
            <ArrowRight :size="14" :stroke-width="2.5" aria-hidden="true" />
          </RouterLink>

          <div
            v-else-if="isRetired"
            data-testid="detail-buy-retired"
            class="inline-flex flex-col items-start sm:items-end gap-1"
          >
            <span
              class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                     bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                     text-[11px] font-sans font-bold uppercase tracking-wider text-slate dark:text-body-dark/80"
            >
              {{ retirementLabel }} — view only
            </span>
            <span class="font-sans text-[11px] text-slate dark:text-body-dark/80">
              Existing holders can redeem from
              <RouterLink
                to="/portfolio"
                aria-label="Portfolio — view existing holdings"
                class="underline hover:text-midnight dark:hover:text-white"
              >Portfolio</RouterLink>.
            </span>
          </div>

          <button
            v-else
            type="button"
            disabled
            data-testid="detail-buy-unavailable"
            :aria-describedby="`buy-unavailable-${metadata.ticker}`"
            class="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-sans font-bold text-sm tracking-wide cursor-not-allowed
                   border border-haze dark:border-white/10 bg-mist/40 dark:bg-white/[0.02]
                   text-slate dark:text-body-dark/80 w-full sm:w-auto"
          >
            Not yet listed on-chain
          </button>
          <span
            v-if="!marketplaceUnavailable && !isBuyable && !isRetired"
            :id="`buy-unavailable-${metadata.ticker}`"
            class="sr-only"
          >
            This token is indexed by the oracle catalog but is not yet deployed to MuHaven. Buy will become available once trading opens.
          </span>
        </template>
      </div>

      <!-- Soft inline warning when snapshot fetch failed for a non-404 reason -->
      <div
        v-if="snapshotError"
        role="status"
        class="mb-6 flex items-start gap-3 p-3 rounded-lg
               bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40"
      >
        <AlertCircle :size="16" :stroke-width="2" class="text-amber-700 dark:text-amber-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div class="flex-1">
          <p class="font-sans text-sm text-amber-900 dark:text-amber-200">Snapshot temporarily unavailable</p>
          <p class="font-sans text-xs text-amber-700 dark:text-amber-300/80 mt-0.5">Metadata is current; market data will refresh automatically. {{ snapshotError }}</p>
        </div>
      </div>

      <!-- Snapshot-pending notice — metadata is here but no snapshot row yet -->
      <div
        v-else-if="!snapshot"
        role="status"
        class="mb-6 flex items-start gap-3 p-3 rounded-lg
               bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10"
      >
        <AlertCircle :size="16" :stroke-width="2" class="text-cool mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div class="flex-1">
          <p class="font-sans text-sm text-midnight dark:text-white">Live data pending</p>
          <p class="font-sans text-xs text-cool mt-0.5">Snapshot will appear at the next 8-hour oracle refresh.</p>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           Hero — H1 first (correct heading hierarchy) + chips + scalars
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="pb-10 border-b border-haze dark:border-white/5"
      >
        <div class="flex items-start gap-5 mb-5 flex-wrap">
          <TokenIcon :ticker="metadata.ticker" variant="hero" />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              <span
                v-if="metadata.asset_class_name"
                data-testid="detail-asset-class"
                class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md
                       bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                       text-[10px] font-sans font-bold uppercase tracking-wider
                       text-slate dark:text-body-dark/80"
              >
                {{ metadata.asset_class_name }}
              </span>
              <span
                v-if="metadata.is_yield_bearing"
                data-testid="detail-yield-pill"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
                       bg-compute/15 dark:bg-signal/15 border border-compute/30 dark:border-signal/30
                       text-[10px] font-sans font-bold uppercase tracking-wider
                       text-amber-900 dark:text-signal"
              >
                <TrendingUp :size="11" :stroke-width="2" aria-hidden="true" />
                Yield Bearing
              </span>
              <span
                v-else
                data-testid="detail-non-yield-pill"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
                       bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                       text-[10px] font-sans font-bold uppercase tracking-wider
                       text-slate dark:text-body-dark/80"
              >
                Capital Appreciation
              </span>
              <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
                           bg-gold/15 dark:bg-signal/15 border border-gold/30 dark:border-signal/30
                           text-[10px] font-sans font-bold uppercase tracking-wider
                           text-amber-900 dark:text-signal">
                <ShieldCheck :size="11" :stroke-width="2" aria-hidden="true" />
                Live on Arbitrum Sepolia
              </span>
            </div>
            <h1 class="font-accent italic text-3xl lg:text-4xl text-midnight dark:text-white mb-1 leading-tight">
              {{ metadata.display_name }}
            </h1>
            <p class="font-mono text-sm text-compute/80 dark:text-signal/80 uppercase tracking-widest mb-2">
              {{ metadata.ticker }}
            </p>
            <p
              v-if="issuerLine"
              data-testid="detail-issuer-line"
              class="font-sans text-xs text-cool"
            >
              {{ issuerLine }}
            </p>
          </div>
        </div>

        <p
          v-if="metadata.description"
          class="font-sans text-sm text-cool max-w-3xl leading-relaxed mb-8"
        >
          {{ metadata.description }}
        </p>

        <!-- Hero scalars — branched by yield/non-yield -->
        <div class="flex gap-8 md:gap-12 flex-wrap">
          <!-- Yield-bearing hero: APY + NAV + Supply -->
          <template v-if="metadata.is_yield_bearing">
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                7D APY
              </p>
              <span
                data-testid="detail-hero-apy7"
                class="font-accent italic font-extrabold text-4xl text-compute dark:text-signal tabular-nums leading-none"
              >
                {{ formatPercent(snapshot?.apy_7_day) }}
              </span>
            </div>
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                30D APY
              </p>
              <span class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none">
                {{ formatPercent(snapshot?.apy_30_day) }}
              </span>
            </div>
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                NAV / Share
              </p>
              <span
                data-testid="detail-hero-nav"
                class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none"
              >
                {{ formatDollarString(snapshot?.nav_dollar) }}
              </span>
            </div>
          </template>

          <!-- Non-yield hero: Price + NAV + Supply -->
          <template v-else>
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                Price
              </p>
              <span
                data-testid="detail-hero-price"
                class="font-accent italic font-extrabold text-4xl text-compute dark:text-signal tabular-nums leading-none"
              >
                {{ formatDollarString(snapshot?.price_dollar) }}
              </span>
            </div>
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                NAV / Share
              </p>
              <span class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none">
                {{ formatDollarString(snapshot?.nav_dollar) }}
              </span>
            </div>
            <!-- UX L2: surface total supply on non-yield hero —
                 differentiator for capital-appreciation tokens. -->
            <div>
              <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                Total Supply
              </p>
              <span class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none">
                {{ formatTokenSupply(snapshot?.total_supply_token) }}
              </span>
            </div>
          </template>

          <div>
            <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
              Total Asset Value
            </p>
            <span
              data-testid="detail-hero-tav"
              class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none"
            >
              {{ formatDollarString(snapshot?.total_asset_value_dollar) }}
            </span>
          </div>

          <div>
            <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
              Holders
            </p>
            <span class="font-accent italic font-bold text-3xl text-midnight dark:text-white tabular-nums leading-none">
              {{ snapshot?.holding_addresses_count?.toLocaleString() ?? '—' }}
            </span>
          </div>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Q4 chart — historical timeseries with measure + range
           toggles. Sits between the hero and the two-column body so
           the chart is the first thing below the headline scalars.
           Skip when the token has no snapshot yet (no data to chart).
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-if="snapshot"
        v-motion
        :initial="{ opacity: 0, y: 12 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 120 } }"
        class="py-10 border-b border-haze dark:border-white/5"
        aria-labelledby="token-chart-heading"
      >
        <h2
          id="token-chart-heading"
          class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-6"
        >
          <LineChart :size="14" :stroke-width="2" aria-hidden="true" />
          Historical Performance
        </h2>
        <OracleTimeseriesChart
          :ticker="metadata.ticker"
          :is-yield-bearing="metadata.is_yield_bearing"
          :published-measures="metadata.published_measures"
        />
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Two-column body: issuer + jurisdiction on the left;
           yield detail (cond) + fees + primary market + supply on the right.
           md:grid-cols-2 (not lg:) — halves vertical scroll on tablet.
           ═══════════════════════════════════════════════════════════ -->
      <section class="grid grid-cols-1 md:grid-cols-2 gap-10 lg:gap-16 py-12">
        <!-- LEFT: issuer + jurisdiction + underlying tokens -->
        <div class="space-y-10">
          <div>
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <Building2 :size="14" :stroke-width="2" aria-hidden="true" />
              Issuer
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div v-if="metadata.issuer_name" class="flex justify-between gap-4">
                <dt class="text-cool">Name</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.issuer_name }}</dd>
              </div>
              <div v-if="metadata.issuer_legal_name" class="flex justify-between gap-4">
                <dt class="text-cool">Legal Name</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.issuer_legal_name }}</dd>
              </div>
              <div v-if="metadata.issuer_lei" class="flex justify-between gap-4">
                <dt class="text-cool">LEI</dt>
                <dd class="text-midnight dark:text-white text-right font-mono text-xs">{{ metadata.issuer_lei }}</dd>
              </div>
              <div v-if="metadata.issuer_country" class="flex justify-between gap-4">
                <dt class="text-cool">Country</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.issuer_country }}</dd>
              </div>
              <div v-if="metadata.manager_name" class="flex justify-between gap-4">
                <dt class="text-cool">Manager</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.manager_name }}</dd>
              </div>
              <div v-if="metadata.inception_date" class="flex justify-between gap-4">
                <dt class="text-cool">Inception</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.inception_date }}</dd>
              </div>
              <div v-if="metadata.website" class="flex justify-between gap-4">
                <dt class="text-cool">Website</dt>
                <dd class="text-right">
                  <a
                    :href="metadata.website"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 text-compute dark:text-signal hover:underline"
                  >
                    {{ metadata.website.replace(/^https?:\/\//, '') }}
                    <ExternalLink :size="12" :stroke-width="2" aria-hidden="true" />
                  </a>
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <FileText :size="14" :stroke-width="2" aria-hidden="true" />
              Jurisdiction & Structure
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div v-if="metadata.jurisdiction_country" class="flex justify-between gap-4">
                <dt class="text-cool">Country</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.jurisdiction_country }}</dd>
              </div>
              <div v-if="metadata.regulatory_framework" class="flex justify-between gap-4">
                <dt class="text-cool">Framework</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.regulatory_framework }}</dd>
              </div>
              <div v-if="metadata.governing_body" class="flex justify-between gap-4">
                <dt class="text-cool">Governing Body</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.governing_body }}</dd>
              </div>
              <div v-if="metadata.legal_structure" class="flex justify-between gap-4">
                <dt class="text-cool">Legal Structure</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.legal_structure }}</dd>
              </div>
            </dl>
          </div>

          <!-- Underlying tokens (per-chain wrap layer) -->
          <div v-if="metadata.underlying_tokens && metadata.underlying_tokens.length > 0">
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <Globe :size="14" :stroke-width="2" aria-hidden="true" />
              Underlying Tokens
            </h2>
            <ul class="space-y-3 font-sans text-sm">
              <li
                v-for="t in metadata.underlying_tokens"
                :key="`${t.network}-${t.address}`"
                class="flex flex-col gap-1 pb-3 border-b border-haze/60 dark:border-white/5 last:border-b-0 last:pb-0"
              >
                <div class="flex justify-between items-center gap-3">
                  <span class="text-midnight dark:text-white font-semibold">{{ t.network }}</span>
                  <span class="font-mono text-xs text-cool">{{ t.decimals }} decimals</span>
                </div>
                <p class="font-mono text-xs text-cool break-all">{{ t.address }}</p>
              </li>
            </ul>
          </div>
        </div>

        <!-- RIGHT: yield detail (cond) + fees + primary market + supply -->
        <div class="space-y-10">
          <div v-if="metadata.is_yield_bearing">
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <TrendingUp :size="14" :stroke-width="2" aria-hidden="true" />
              Yield Detail
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-cool">7D APY</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatPercent(snapshot?.apy_7_day) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">30D APY</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatPercent(snapshot?.apy_30_day) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Daily yield rate</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatPercent(snapshot?.daily_yield_rate, 4) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Yield-to-maturity</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatPercent(snapshot?.yield_to_maturity_percent) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Distributes income</dt>
                <dd class="text-midnight dark:text-white text-right">
                  {{ metadata.distributes_income === null ? '—' : metadata.distributes_income ? 'Yes' : 'No' }}
                </dd>
              </div>
            </dl>
          </div>

          <!-- Fees -->
          <div>
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <CircleDollarSign :size="14" :stroke-width="2" aria-hidden="true" />
              Fees
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Management</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ bpsToPct(metadata.fee_management_bps) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Performance</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ bpsToPct(metadata.fee_performance_bps) }}</dd>
              </div>
              <div v-if="metadata.fee_structure_description" class="flex flex-col gap-1">
                <dt class="text-cool">Structure</dt>
                <dd class="text-midnight dark:text-white text-xs leading-relaxed">{{ metadata.fee_structure_description }}</dd>
              </div>
            </dl>
          </div>

          <!-- Primary market -->
          <div>
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <Users :size="14" :stroke-width="2" aria-hidden="true" />
              Primary Market
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div v-if="metadata.pm_subscription_frequency" class="flex justify-between gap-4">
                <dt class="text-cool">Subscription</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.pm_subscription_frequency }}</dd>
              </div>
              <div v-if="metadata.pm_subscription_minimum_dollar" class="flex justify-between gap-4">
                <dt class="text-cool">Minimum</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatDollarString(metadata.pm_subscription_minimum_dollar) }}</dd>
              </div>
              <div v-if="metadata.pm_redemption_frequency" class="flex justify-between gap-4">
                <dt class="text-cool">Redemption</dt>
                <dd class="text-midnight dark:text-white text-right">{{ metadata.pm_redemption_frequency }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">KYC required</dt>
                <dd class="text-midnight dark:text-white text-right">
                  {{ metadata.pm_kyc_required === null ? '—' : metadata.pm_kyc_required ? 'Yes' : 'No' }}
                </dd>
              </div>
            </dl>
          </div>

          <!-- Supply (read from snapshot) -->
          <div v-if="snapshot">
            <h2 class="flex items-center gap-2 font-sans text-xs uppercase tracking-[0.18em] font-bold text-cool mb-4">
              <ShieldCheck :size="14" :stroke-width="2" aria-hidden="true" />
              Supply & Market
            </h2>
            <dl class="space-y-3 font-sans text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Total supply</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatTokenSupply(snapshot.total_supply_token) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Total asset value</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatDollarString(snapshot.total_asset_value_dollar) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Market value</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ formatDollarString(snapshot.market_value_dollar) }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Holders</dt>
                <dd class="text-midnight dark:text-white text-right font-mono tabular-nums">{{ snapshot.holding_addresses_count?.toLocaleString() ?? '—' }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-cool">Snapshot</dt>
                <dd class="text-cool text-right text-xs">{{ new Date(snapshot.snapshot_at).toLocaleString() }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
