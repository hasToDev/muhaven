<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  oracleApi,
  type OracleTokenMetadataDto,
  type OracleSnapshotDto,
} from '@/services/api'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  ArrowLeft, Globe, ShieldCheck, TrendingUp, Sparkles,
  Building2, FileText, Users, CircleDollarSign, ExternalLink,
} from 'lucide-vue-next'

/**
 * Wave 5 Q1 — token detail page sourced from the oracle layer
 * (`/oracle/tokens/:ticker/metadata` + `/snapshot/latest`). Full
 * 30-field render branched by `is_yield_bearing`:
 *   - yield-bearing: APY hero + yield-rate breakdown
 *   - non-yield: capital-appreciation framing + total-supply hero
 *
 * No buy CTA — the 11 RWAs aren't on-chain yet. A "Coming Soon" badge
 * replaces it. Q4 chart components will land here later.
 */

const props = defineProps<{ ticker: string }>()
const router = useRouter()

const metadata = ref<OracleTokenMetadataDto | null>(null)
const snapshot = ref<OracleSnapshotDto | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  metadata.value = null
  snapshot.value = null
  try {
    // Fetch metadata + snapshot in parallel; tolerate the snapshot
    // 404 (a fresh-ingest token may have metadata but no snapshot yet).
    const [m, s] = await Promise.allSettled([
      oracleApi.getMetadata(props.ticker),
      oracleApi.getLatestSnapshot(props.ticker),
    ])
    if (m.status === 'rejected') {
      throw m.reason
    }
    metadata.value = m.value
    if (s.status === 'fulfilled') {
      snapshot.value = s.value
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load token'
  } finally {
    loading.value = false
  }
}

onMounted(load)
// Re-fetch on ticker change so /marketplace/USYC → /marketplace/BUIDL
// refreshes the page state without a full route reload.
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
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  // Human-readable for marketplace UI — three significant abbreviations.
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
      <!-- Back link -->
      <RouterLink
        to="/marketplace"
        class="inline-flex items-center gap-2 mb-6 font-sans text-xs uppercase tracking-[0.18em] font-bold
               text-cool hover:text-midnight dark:hover:text-white transition-colors"
      >
        <ArrowLeft :size="14" :stroke-width="2" aria-hidden="true" />
        Back to marketplace
      </RouterLink>

      <!-- ═══════════════════════════════════════════════════════════
           Hero — icon + name + ticker + issuer + chips + hero scalars
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="pb-10 border-b border-haze dark:border-white/5"
      >
        <div class="flex items-start gap-5 mb-5 flex-wrap">
          <img
            v-if="metadata.icon_url"
            :src="metadata.icon_url"
            :alt="`${metadata.display_name} icon`"
            class="w-16 h-16 rounded-2xl bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 object-contain"
            @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
          />
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
                       bg-compute/10 dark:bg-signal/10 border border-compute/25 dark:border-signal/25
                       text-[10px] font-sans font-bold uppercase tracking-wider
                       text-compute dark:text-signal"
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
                           bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25
                           text-[10px] font-sans font-bold uppercase tracking-wider
                           text-compute dark:text-signal">
                <Sparkles :size="11" :stroke-width="2" aria-hidden="true" />
                Coming Soon
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

          <!-- Non-yield hero: Price + TVL + Holders -->
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
           Two-column body: left = issuer + structure, right = market + fees + primary market
           ═══════════════════════════════════════════════════════════ -->
      <section class="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 py-12">
        <!-- LEFT: issuer + jurisdiction -->
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

        <!-- RIGHT: fees + primary market + supply -->
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
