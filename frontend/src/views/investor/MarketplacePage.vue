<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useOracleTokensStore } from '@/stores/oracle-tokens'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  Search, TrendingUp, ShieldCheck, Inbox, EyeOff, Sparkles,
} from 'lucide-vue-next'
import type { OracleTokenListItemDto } from '@/services/api'

/**
 * Wave 5 Q1 — marketplace catalog now sourced from the oracle layer
 * (rwa.xyz-scraped metadata + snapshots) instead of on-chain
 * `rwa_tokens`. The 11 curated RWAs surface here; TBILL1 / GOLD1 are
 * retired from the marketplace view (Portfolio + Trade pages still
 * reference them for any legacy holdings).
 *
 * The buy CTA is disabled — these tokens aren't yet on-chain. A
 * "Coming Soon" pill replaces the live "Invest Now" affordance. Each
 * card click navigates to `/marketplace/:ticker` (token detail page).
 */

const oracle = useOracleTokensStore()

onMounted(async () => {
  if (oracle.loaded) return
  await oracle.load()
})

const showLoader = computed(() =>
  !oracle.loaded && !oracle.error && oracle.loading,
)

const selectedTicker = ref<string>('')

const selected = computed(() =>
  oracle.filtered.find((t) => t.ticker === selectedTicker.value)
    ?? oracle.filtered[0],
)

watch(
  () => oracle.filtered.map((t) => t.ticker).join(','),
  () => {
    if (!selected.value && oracle.filtered.length > 0) {
      selectedTicker.value = oracle.filtered[0].ticker
    } else if (selected.value) {
      selectedTicker.value = selected.value.ticker
    }
  },
  { immediate: true },
)

function selectToken(ticker: string) {
  selectedTicker.value = ticker
}

function issuerLabel(token: OracleTokenListItemDto): string {
  const parts: string[] = []
  if (token.issuer_name) parts.push(token.issuer_name)
  if (token.issuer_country) parts.push(token.issuer_country)
  return parts.length > 0 ? parts.join(' · ') : 'Issuer not listed'
}

const heroDescription = computed(() => {
  const t = selected.value
  if (!t) return ''
  return (
    t.description?.trim() ||
    `${t.display_name} is a confidential ${t.asset_class_name?.toLowerCase() ?? 'real-world asset'} token tracked on MuHaven. Balances settle peer-to-peer with FHE encryption on Arbitrum — every amount stays in ciphertext until you decrypt your own view.`
  )
})

// APY hero stat — only shown for yield-bearing tokens. The
// `latest_snapshot.apy_7_day` is a decimal-percent string (e.g.
// "3.134591"); render with one decimal.
function formatApy(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}%`
}

function formatDollarString(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return formatUSD(n)
}
</script>

<template>
  <div class="relative">
    <!-- Page-level ambient amber bloom (top-right), per reference. -->
    <div
      aria-hidden="true"
      class="absolute top-0 right-0 w-[600px] h-[600px] rounded-full blur-[150px] pointer-events-none -z-0
             bg-gold/10 dark:bg-signal/8"
    />

    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading marketplace"
      caption="Reading available RWA tokens"
    />

    <!-- Error -->
    <div v-else-if="oracle.error" class="relative z-10 flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ oracle.error }}</p>
      <MButton variant="outline" @click="oracle.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="relative z-10">
      <!-- ═══════════════════════════════════════════════════════════
           Hero — editorial intro (left) + selected token spotlight (right).
           Clicking a card in the grid updates the right column; the
           "View Details" link goes to the per-token detail page.
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-if="selected"
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="pb-10 lg:pb-12 border-b border-haze dark:border-white/5"
      >
        <div class="flex flex-col xl:flex-row justify-between gap-10 lg:gap-16">
          <!-- Left: editorial copy + CTA + chip row -->
          <div class="flex-1 flex flex-col justify-start max-w-2xl">
            <h2 class="font-sans text-lg lg:text-xl font-extrabold text-midnight dark:text-white mb-2 leading-tight tracking-tight">
              Ready to expand your portfolio?
            </h2>
            <p
              :key="selected.ticker"
              v-motion
              :initial="{ opacity: 0, y: 4 }"
              :enter="{ opacity: 1, y: 0, transition: { duration: 260 } }"
              class="font-sans text-sm text-cool mb-6 max-w-lg leading-relaxed"
            >
              {{ heroDescription }}
            </p>

            <RouterLink :to="`/marketplace/${selected.ticker}`" class="self-start mb-6">
              <button
                type="button"
                data-testid="marketplace-detail-cta"
                :aria-label="`View ${selected.display_name} details`"
                class="btn-gold-sweep w-full sm:w-auto px-8 py-3 rounded-xl font-sans font-extrabold text-sm tracking-wide cursor-pointer
                       transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99]"
              >
                View Details
              </button>
            </RouterLink>

            <div class="flex flex-wrap gap-3">
              <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
                           bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5
                           text-[10px] font-sans font-bold uppercase tracking-wider
                           text-slate dark:text-body-dark/80">
                <ShieldCheck :size="11" :stroke-width="2" aria-hidden="true" class="text-compute dark:text-signal" />
                FHE Encryption
              </span>
              <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
                           bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5
                           text-[10px] font-sans font-bold uppercase tracking-wider
                           text-slate dark:text-body-dark/80">
                <EyeOff :size="11" :stroke-width="2" aria-hidden="true" class="text-compute dark:text-signal" />
                Confidential Balances
              </span>
              <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
                           bg-gold/10 dark:bg-signal/10 border border-gold/30 dark:border-signal/30
                           text-[10px] font-sans font-bold uppercase tracking-wider
                           text-compute dark:text-signal">
                <Sparkles :size="11" :stroke-width="2" aria-hidden="true" />
                Coming Soon
              </span>
            </div>
          </div>

          <!-- Right: featured token spotlight -->
          <div class="flex-[1.2] flex flex-col justify-end xl:border-l xl:border-haze xl:dark:border-white/5 xl:pl-10">
            <div class="flex flex-col mb-8 xl:mb-0">
              <div class="flex items-center gap-3 mb-4 flex-wrap">
                <span
                  v-if="selected.asset_class_name"
                  data-testid="marketplace-hero-asset-class"
                  class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md
                         bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                         text-[10px] font-sans font-bold uppercase tracking-wider
                         text-slate dark:text-body-dark/80"
                >
                  {{ selected.asset_class_name }}
                </span>
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
                             bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25
                             text-[10px] font-sans font-bold uppercase tracking-wider
                             text-compute dark:text-signal">
                  <ShieldCheck :size="12" :stroke-width="2" aria-hidden="true" />
                  FHE Shielded
                </span>
              </div>
              <h1 class="font-accent italic text-2xl lg:text-3xl text-midnight dark:text-white mb-2 leading-tight tracking-tight">
                {{ selected.display_name }}
              </h1>
              <p class="font-mono text-sm text-compute/80 dark:text-signal/80 uppercase tracking-widest mb-2">
                {{ selected.ticker }}
              </p>
              <p
                data-testid="marketplace-hero-issuer"
                class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-6"
              >
                by {{ issuerLabel(selected) }}
              </p>
            </div>

            <div class="flex gap-8 md:gap-16 flex-wrap">
              <!-- APY — yield-bearing only -->
              <div v-if="selected.is_yield_bearing">
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Yield (7D APY)
                </p>
                <div class="flex items-center gap-2">
                  <span
                    data-testid="marketplace-hero-apy"
                    class="font-accent italic font-extrabold text-3xl lg:text-4xl text-compute dark:text-signal tabular-nums leading-none"
                  >
                    {{ formatApy(selected.latest_snapshot?.apy_7_day) }}
                  </span>
                  <TrendingUp
                    v-if="selected.latest_snapshot?.apy_7_day"
                    :size="18"
                    :stroke-width="2"
                    aria-hidden="true"
                    class="text-gold dark:text-signal"
                  />
                </div>
              </div>

              <!-- NAV per share -->
              <div>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Net Asset Value
                </p>
                <div class="flex items-baseline gap-1">
                  <span
                    data-testid="marketplace-hero-nav"
                    class="font-accent italic font-bold text-3xl lg:text-4xl text-midnight dark:text-white tabular-nums leading-none"
                  >
                    {{ formatDollarString(selected.latest_snapshot?.nav_dollar) }}
                  </span>
                  <span v-if="selected.latest_snapshot?.nav_dollar" class="font-sans text-sm text-cool">/ Share</span>
                </div>
              </div>

              <!-- Min entry -->
              <div>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Min. Entry
                </p>
                <span
                  data-testid="marketplace-hero-min-entry"
                  class="font-accent italic font-bold text-3xl lg:text-4xl text-midnight dark:text-white tabular-nums leading-none"
                >
                  {{ formatDollarString(selected.pm_subscription_minimum_dollar) }}
                </span>
                <p
                  v-if="selected.pm_subscription_frequency"
                  class="font-sans text-[10px] text-cool mt-1"
                >
                  {{ selected.pm_subscription_frequency }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Toolbar: heading + search + yield filter + asset-class pills
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 140 } }"
        class="pt-10 lg:pt-12 mb-8 border-b border-haze dark:border-white/5 pb-6"
      >
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h3 class="font-sans text-xl font-extrabold tracking-tight text-midnight dark:text-white">
            Available Tokens
          </h3>

          <label for="marketplace-search" class="sr-only">Search tokens</label>
          <div class="relative w-full md:w-72">
            <Search
              :size="16"
              :stroke-width="2"
              aria-hidden="true"
              class="absolute left-4 top-1/2 -translate-y-1/2 text-cool pointer-events-none"
            />
            <input
              id="marketplace-search"
              v-model="oracle.searchQuery"
              placeholder="Search tokens..."
              aria-label="Search tokens"
              data-testid="marketplace-search"
              class="w-full bg-mist/50 dark:bg-[#171717]
                     border border-haze dark:border-white/5 rounded-full
                     pl-12 pr-4 py-3 font-sans text-sm
                     text-midnight dark:text-white placeholder:text-cool
                     focus:outline-none focus:border-gold/50 dark:focus:border-signal/40
                     focus:ring-1 focus:ring-gold/30 dark:focus:ring-signal/30
                     transition-all"
            />
          </div>
        </div>

        <!-- Yield-bearing toggle row -->
        <div class="flex flex-wrap gap-2 mb-3">
          <button
            v-for="opt in [
              { value: 'all', label: 'All' },
              { value: 'yield', label: 'Yield-bearing' },
              { value: 'non-yield', label: 'Non-yield' },
            ]"
            :key="opt.value"
            type="button"
            @click="oracle.yieldFilter = opt.value as 'all' | 'yield' | 'non-yield'"
            :data-testid="`marketplace-yield-${opt.value}`"
            :class="[
              'font-sans text-xs font-bold tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              oracle.yieldFilter === opt.value
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- Asset-class pill row -->
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            @click="oracle.assetClassFilter = ''"
            data-testid="marketplace-filter-all"
            :class="[
              'font-sans text-xs font-bold tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              !oracle.assetClassFilter
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            All Classes
          </button>
          <button
            v-for="ac in oracle.assetClasses"
            :key="ac.slug"
            type="button"
            @click="oracle.assetClassFilter = ac.slug"
            :data-testid="`marketplace-filter-${ac.slug}`"
            :class="[
              'font-sans text-xs font-medium tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              oracle.assetClassFilter === ac.slug
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] font-bold shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ ac.name }}
          </button>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Token grid — 4-col on xl, dense cards
           ═══════════════════════════════════════════════════════════ -->
      <div
        v-if="oracle.filtered.length === 0"
        class="flex flex-col items-center py-16 gap-3"
      >
        <Inbox :size="40" :stroke-width="1.4" class="text-cool/35" />
        <p class="font-sans text-sm text-cool">No tokens found</p>
        <p class="font-sans text-xs text-cool/70">Try adjusting your search or filters.</p>
      </div>

      <div
        v-else
        v-motion
        :initial="{ opacity: 0, y: 8 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 320, delay: 200 } }"
        role="radiogroup"
        aria-label="Available tokens"
        class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6"
      >
        <button
          v-for="token in oracle.filtered"
          :key="token.ticker"
          type="button"
          role="radio"
          :aria-checked="token.ticker === selected?.ticker"
          :aria-label="`Select ${token.display_name} — ${token.ticker}`"
          @click="selectToken(token.ticker)"
          @dblclick="$router.push(`/marketplace/${token.ticker}`)"
          data-testid="marketplace-token-card"
          :data-token-ticker="token.ticker"
          :class="[
            'relative overflow-hidden rounded-2xl p-6 text-left cursor-pointer group',
            'transition-all duration-300 hover:-translate-y-0.5 focus:outline-none',
            'focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
            token.ticker === selected?.ticker
              ? 'border border-gold/40 dark:border-signal/40 bg-white dark:bg-[#0d0e10] shadow-[0_0_30px_-12px_rgba(255,186,32,0.30)]'
              : 'border border-haze dark:border-white/5 bg-white dark:bg-[#0d0e10] hover:bg-mist/40 dark:hover:bg-[#171717]',
          ]"
        >
          <!-- Selected accent bar -->
          <div
            v-if="token.ticker === selected?.ticker"
            aria-hidden="true"
            class="absolute top-0 left-0 right-0 h-1 bg-gold dark:bg-signal"
          />

          <div class="flex flex-col h-full justify-between gap-8 mt-2">
            <div class="flex items-start gap-3">
              <!-- Icon -->
              <img
                v-if="token.icon_url"
                :src="token.icon_url"
                :alt="`${token.display_name} icon`"
                loading="lazy"
                class="w-10 h-10 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 object-contain flex-shrink-0"
                @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
              />
              <div class="flex-1 min-w-0">
                <h4
                  data-testid="marketplace-token-name"
                  class="font-sans font-bold text-lg text-midnight dark:text-white mb-1 line-clamp-1"
                >
                  {{ token.display_name }}
                </h4>
                <p
                  data-testid="marketplace-token-ticker"
                  :class="[
                    'font-mono text-xs uppercase tracking-widest',
                    token.ticker === selected?.ticker
                      ? 'text-compute/80 dark:text-signal/80'
                      : 'text-cool',
                  ]"
                >
                  {{ token.ticker }}
                </p>
                <p
                  data-testid="marketplace-token-issuer"
                  class="mt-1 font-sans text-[10px] uppercase tracking-[0.22em] text-cool line-clamp-1"
                >
                  by {{ issuerLabel(token) }}
                </p>
              </div>
            </div>
            <div class="flex justify-between items-end gap-3">
              <!-- Asset-class chip — uses rwa.xyz's display name -->
              <span
                v-if="token.asset_class_name"
                class="font-sans text-[10px] font-bold tracking-wider uppercase px-3 py-1.5 rounded
                       bg-mist/70 dark:bg-white/5 text-slate dark:text-body-dark/70 border border-haze/70 dark:border-white/5"
              >
                {{ token.asset_class_name }}
              </span>
              <span v-else />

              <!-- APY hero (yield-bearing) — branched by is_yield_bearing -->
              <span
                v-if="token.is_yield_bearing"
                data-testid="marketplace-token-apy"
                class="font-accent italic font-extrabold text-2xl text-compute dark:text-signal tabular-nums leading-none"
              >
                {{ formatApy(token.latest_snapshot?.apy_7_day) }}
              </span>
              <span
                v-else
                data-testid="marketplace-token-non-yield"
                class="font-sans text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded
                       bg-mist/70 dark:bg-white/5 text-cool border border-haze/70 dark:border-white/5"
              >
                Capital appreciation
              </span>
            </div>
          </div>
        </button>
      </div>

      <p
        v-if="oracle.filtered.length > 0"
        class="mt-10 text-center font-sans text-xs text-cool"
      >
        {{ oracle.filtered.length }} of {{ oracle.tokens.length }} tokens shown
      </p>
    </div>
  </div>
</template>
