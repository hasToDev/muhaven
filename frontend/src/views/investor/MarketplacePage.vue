<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useOracleTokensStore } from '@/stores/oracle-tokens'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import OracleSparkline from '@/components/charts/OracleSparkline.vue'
import {
  Search, ShieldCheck, Inbox, EyeOff,
} from 'lucide-vue-next'
import type { OracleTokenListItemDto } from '@/services/api'

/**
 * Wave 5 Q1 — marketplace catalog sourced from the oracle layer
 * (rwa.xyz-scraped metadata + snapshots) instead of on-chain
 * `rwa_tokens`. The 11 curated RWAs surface here; TBILL1 / GOLD1 are
 * retired from the marketplace view (Portfolio + Trade pages still
 * reference them for any legacy holdings).
 *
 * Interaction model (a11y-first):
 *  - Cards are `RouterLink`s. Single click anywhere on the card →
 *    detail page. No master-detail spotlight pattern, no radio group,
 *    no double-click gesture. Keyboard users Tab through cards;
 *    Enter activates the link.
 *  - The featured token (first row, post-filter) gets a "View
 *    {ticker}" hero CTA above the grid. The hero is editorial copy
 *    plus an explicit gateway — not a synchronized preview.
 *  - The Buy CTA lives on the token-detail page (TokenDetailPage), not
 *    on each card. Cards stay single-affordance; the detail page is
 *    where investors review fees / jurisdiction / KYC before signing a
 *    securities purchase. Hero status pill ("Live on Arbitrum Sepolia")
 *    signals on-chain readiness instead of the old "Coming Soon" copy.
 *
 * Filter order: asset class → yield-bearing toggle → search.
 * Asset class is the primary investor-facing taxonomy.
 */

const oracle = useOracleTokensStore()

onMounted(async () => {
  if (oracle.loaded) return
  await oracle.load()
})

const showLoader = computed(() =>
  !oracle.loaded && !oracle.error && oracle.loading,
)

// Featured token = first card in the filtered set. Drives the hero
// CTA target. Recomputes when filters narrow the catalog.
const featured = computed<OracleTokenListItemDto | undefined>(
  () => oracle.filtered[0],
)

function issuerLabel(token: OracleTokenListItemDto): string {
  const parts: string[] = []
  if (token.issuer_name) parts.push(token.issuer_name)
  if (token.issuer_country) parts.push(token.issuer_country)
  return parts.length > 0 ? parts.join(' · ') : 'Issuer not listed'
}

function formatApy(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—'
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}%`
}
</script>

<template>
  <div class="relative">
    <!-- Page-level ambient amber bloom -->
    <div
      aria-hidden="true"
      class="absolute top-0 right-0 w-[600px] h-[600px] rounded-full blur-[150px] pointer-events-none -z-0
             bg-gold/10 dark:bg-signal/8"
    />

    <MPageLoader
      v-if="showLoader"
      label="Loading marketplace"
      caption="Reading available RWA tokens"
    />

    <div v-else-if="oracle.error" class="relative z-10 flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ oracle.error }}</p>
      <MButton variant="outline" @click="oracle.load()">Retry</MButton>
    </div>

    <div v-else class="relative z-10">
      <!-- ═══════════════════════════════════════════════════════════
           Hero — H1 (page-level) + editorial copy + chip row +
           featured-token gateway CTA. The CTA navigates to whichever
           token tops the filtered grid, NOT a hand-selected one — keeps
           the model simple (single click on cards = navigate).
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="pb-10 lg:pb-12 border-b border-haze dark:border-white/5 max-w-3xl"
      >
        <h1 class="font-accent italic text-3xl lg:text-4xl text-midnight dark:text-white mb-3 leading-tight tracking-tight">
          Confidential RWA marketplace
        </h1>
        <p class="font-sans text-sm text-cool mb-6 leading-relaxed">
          Real-world assets from across the industry, surfaced with public NAV + APY data while
          your positions stay encrypted. Click any token to see its full metadata.
        </p>

        <div class="flex flex-wrap items-center gap-3 mb-2">
          <RouterLink
            v-if="featured"
            :to="`/marketplace/${featured.ticker}`"
            data-testid="marketplace-featured-cta"
            :aria-label="`View ${featured.display_name} details`"
            class="btn-gold-sweep px-8 py-3 rounded-xl font-sans font-extrabold text-sm tracking-wide cursor-pointer
                   transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99]
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 dark:focus-visible:ring-signal/50"
          >
            Explore {{ featured.ticker }}
          </RouterLink>
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
                       bg-gold/15 dark:bg-signal/15 border border-gold/30 dark:border-signal/30
                       text-[10px] font-sans font-bold uppercase tracking-wider
                       text-amber-900 dark:text-signal">
            <ShieldCheck :size="11" :stroke-width="2" aria-hidden="true" />
            Live on Arbitrum Sepolia
          </span>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Toolbar: heading H2 + search + asset class pills + yield toggle
           ═══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 140 } }"
        class="pt-10 lg:pt-12 mb-8 border-b border-haze dark:border-white/5 pb-6"
      >
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h2 class="font-sans text-xl font-extrabold tracking-tight text-midnight dark:text-white">
            Available Tokens
          </h2>

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

        <!-- Asset class pills — primary investor-facing taxonomy. -->
        <div class="flex flex-wrap gap-2 mb-3">
          <button
            type="button"
            @click="oracle.assetClassFilter = ''"
            data-testid="marketplace-filter-all"
            :aria-pressed="!oracle.assetClassFilter"
            :class="[
              'font-sans text-xs font-bold tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
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
            :aria-pressed="oracle.assetClassFilter === ac.slug"
            :class="[
              'font-sans text-xs font-medium tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
              oracle.assetClassFilter === ac.slug
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] font-bold shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ ac.name }}
          </button>
        </div>

        <!-- Yield filter — secondary refinement. -->
        <div class="flex flex-wrap gap-2">
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
            :aria-pressed="oracle.yieldFilter === opt.value"
            :class="[
              'font-sans text-xs font-bold tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
              oracle.yieldFilter === opt.value
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ opt.label }}
          </button>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Token grid — single click on a card navigates to detail.
           No radiogroup; cards are plain RouterLinks for clear keyboard
           + screen-reader semantics.
           ═══════════════════════════════════════════════════════════ -->
      <div
        v-if="oracle.filtered.length === 0"
        class="flex flex-col items-center py-16 gap-3"
      >
        <Inbox :size="40" :stroke-width="1.4" class="text-cool/35" aria-hidden="true" />
        <p class="font-sans text-sm text-cool">No tokens found</p>
        <p class="font-sans text-xs text-cool/70">Try adjusting your search or filters.</p>
      </div>

      <ul
        v-else
        v-motion
        :initial="{ opacity: 0, y: 8 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 320, delay: 200 } }"
        aria-label="Available tokens"
        class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 list-none p-0"
      >
        <li v-for="token in oracle.filtered" :key="token.ticker">
          <RouterLink
            :to="`/marketplace/${token.ticker}`"
            data-testid="marketplace-token-card"
            :data-token-ticker="token.ticker"
            :aria-label="`View details for ${token.display_name}, ticker ${token.ticker}`"
            class="block relative overflow-hidden rounded-2xl p-6 text-left
                   border border-haze dark:border-white/5 bg-white dark:bg-[#0d0e10]
                   transition-all duration-300 hover:-translate-y-0.5 hover:bg-mist/40 dark:hover:bg-[#171717]
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 dark:focus-visible:ring-signal/50
                   no-underline"
          >
            <div class="flex flex-col h-full justify-between gap-8 mt-2">
              <div class="flex items-start gap-3">
                <img
                  v-if="token.icon_url"
                  :src="token.icon_url"
                  alt=""
                  role="presentation"
                  loading="lazy"
                  class="w-10 h-10 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 object-contain flex-shrink-0"
                />
                <div class="flex-1 min-w-0">
                  <h3
                    data-testid="marketplace-token-name"
                    class="font-sans font-bold text-lg text-midnight dark:text-white mb-1 line-clamp-1"
                  >
                    {{ token.display_name }}
                  </h3>
                  <p
                    data-testid="marketplace-token-ticker"
                    class="font-mono text-xs uppercase tracking-widest text-cool"
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
              <!-- Bottom row: asset-class chip (left) + 90-day sparkline
                   stacked above the APY/appreciation scalar (right).
                   Stacking the sparkline above the data scalar reads as
                   "decorative trend chrome above the headline figure"
                   rather than competing with the identity block above. -->
              <div class="flex justify-between items-end gap-3">
                <span
                  v-if="token.asset_class_name"
                  class="font-sans text-[10px] font-bold tracking-wider uppercase px-3 py-1.5 rounded
                         bg-mist/70 dark:bg-white/5 text-slate dark:text-body-dark/70 border border-haze/70 dark:border-white/5"
                >
                  {{ token.asset_class_name }}
                </span>
                <span v-else />

                <div class="flex flex-col items-end gap-2">
                  <OracleSparkline
                    :ticker="token.ticker"
                    :measure="token.is_yield_bearing ? 'apy_7_day' : 'price_dollar'"
                    :label="token.is_yield_bearing ? '7D APY' : 'Price'"
                    :kind="token.is_yield_bearing ? 'pct' : 'usd'"
                    :days="90"
                  />
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
            </div>
          </RouterLink>
        </li>
      </ul>

      <p
        v-if="oracle.filtered.length > 0"
        class="mt-10 text-center font-sans text-xs text-cool"
      >
        {{ oracle.filtered.length }} of {{ oracle.tokens.length }} tokens shown
      </p>
    </div>
  </div>
</template>
