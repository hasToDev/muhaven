<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMarketplaceStore } from '@/stores/marketplace'
import { formatAddress, formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  Search, TrendingUp, ShieldCheck, Inbox, EyeOff,
} from 'lucide-vue-next'
import type { TokenResponseDto } from '@/services/api'

const marketplace = useMarketplaceStore()

const assetClassLabels: Record<string, string> = {
  treasury: 'Treasury',
  money_market: 'Money Market',
  private_credit: 'Private Credit',
  real_estate: 'Real Estate',
  other: 'Other',
}

/**
 * Phase 9.A · Expansion (F3) — multi-issuer marketplace metadata. Token
 * cards surface the issuer name directly so investors can distinguish
 * different SPVs at a glance. Falls back to the formatted issuer wallet
 * address for legacy tokens whose issuer didn't walk the F2 wizard
 * (those rows have `issuer_display_name = null`).
 */
function issuerLabel(token: TokenResponseDto): string {
  return token.issuer_display_name?.trim() || formatAddress(token.issuer_address)
}

onMounted(async () => {
  if (marketplace.loaded) return
  await marketplace.load()
})

const showLoader = computed(() =>
  !marketplace.loaded && !marketplace.error && marketplace.loading,
)

// Card selection drives the hero spotlight. Default to the first filtered token;
// clicking a card swaps the hero content. Only the hero's "Invest Now" button
// navigates to /deposit — cards themselves are selectors, not links.
const selectedAddress = ref<string>('')

const selected = computed(() =>
  marketplace.filtered.find(t => t.address === selectedAddress.value)
    ?? marketplace.filtered[0],
)

// If the filter/search narrows the list and the currently-selected token
// drops out, fall back to the new first entry so the hero stays populated.
watch(
  () => marketplace.filtered.map(t => t.address).join(','),
  () => {
    if (!selected.value && marketplace.filtered.length > 0) {
      selectedAddress.value = marketplace.filtered[0].address
    } else if (selected.value) {
      selectedAddress.value = selected.value.address
    }
  },
  { immediate: true },
)

function selectToken(address: string) {
  selectedAddress.value = address
}

// Generic description shown when the DTO doesn't carry a per-token blurb.
// Always re-renders with the current token's name + asset class.
const heroDescription = computed(() => {
  const t = selected.value
  if (!t) return ''
  const asset = assetClassLabels[t.asset_class] || t.asset_class
  return `${t.name} is a confidential ${asset.toLowerCase()} token on MuHaven — balances settle peer-to-peer with FHE encryption on Arbitrum. Every amount stays in ciphertext until you decrypt your own view.`
})
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
    <div v-else-if="marketplace.error" class="relative z-10 flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ marketplace.error }}</p>
      <MButton variant="outline" @click="marketplace.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="relative z-10">
      <!-- ═══════════════════════════════════════════════════════════
           Hero — editorial intro (left) + selected token spotlight (right).
           Clicking a card in the grid updates the right column; the "Invest
           Now" button is the only navigation.
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
              :key="selected.address"
              v-motion
              :initial="{ opacity: 0, y: 4 }"
              :enter="{ opacity: 1, y: 0, transition: { duration: 260 } }"
              class="font-sans text-sm text-cool mb-6 max-w-lg leading-relaxed"
            >
              {{ heroDescription }}
            </p>

            <RouterLink :to="`/trade?token=${selected.address}`" class="self-start mb-6">
              <button
                type="button"
                data-testid="marketplace-invest-cta"
                :aria-label="`Invest in ${selected.name}`"
                class="btn-gold-sweep w-full sm:w-auto px-8 py-3 rounded-xl font-sans font-extrabold text-sm tracking-wide cursor-pointer
                       transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99]"
              >
                Invest Now
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
            </div>
          </div>

          <!-- Right: featured token spotlight -->
          <div class="flex-[1.2] flex flex-col justify-end xl:border-l xl:border-haze xl:dark:border-white/5 xl:pl-10">
            <div class="flex flex-col mb-8 xl:mb-0">
              <div class="flex items-center gap-3 mb-4 flex-wrap">
                <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md
                             bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                             text-[10px] font-sans font-bold uppercase tracking-wider
                             text-slate dark:text-body-dark/80">
                  <span class="w-1.5 h-1.5 rounded-full bg-positive" aria-hidden="true" />
                  {{ selected.status }}
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
                {{ selected.name }}
              </h1>
              <p class="font-mono text-sm text-compute/80 dark:text-signal/80 uppercase tracking-widest mb-2">
                {{ selected.symbol }}
              </p>
              <p
                data-testid="marketplace-hero-issuer"
                class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-6"
              >
                by {{ issuerLabel(selected) }}
              </p>
            </div>

            <div class="flex gap-8 md:gap-16 flex-wrap">
              <div>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Yield (APY)
                </p>
                <div class="flex items-center gap-2">
                  <span class="font-accent italic font-extrabold text-3xl lg:text-4xl text-compute dark:text-signal tabular-nums leading-none">
                    {{ selected.apy ? `${selected.apy}%` : '—' }}
                  </span>
                  <TrendingUp
                    v-if="selected.apy"
                    :size="18"
                    :stroke-width="2"
                    aria-hidden="true"
                    class="text-gold dark:text-signal"
                  />
                </div>
              </div>
              <div>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Net Asset Value
                </p>
                <div class="flex items-baseline gap-1">
                  <span class="font-accent italic font-bold text-3xl lg:text-4xl text-midnight dark:text-white tabular-nums leading-none">
                    {{ selected.latest_nav ? formatUSD(parseFloat(selected.latest_nav.nav)) : '—' }}
                  </span>
                  <span v-if="selected.latest_nav" class="font-sans text-sm text-cool">/ Share</span>
                </div>
              </div>
              <div>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.15em] font-bold mb-2">
                  Min. Entry
                </p>
                <span class="font-accent italic font-bold text-3xl lg:text-4xl text-midnight dark:text-white tabular-nums leading-none">
                  {{ selected.min_investment ? formatUSD(parseFloat(selected.min_investment)) : '—' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Toolbar: heading + search (top row) + asset-class pills (bottom)
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
              v-model="marketplace.searchQuery"
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

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            @click="marketplace.assetClassFilter = ''"
            data-testid="marketplace-filter-all"
            :class="[
              'font-sans text-xs font-bold tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              !marketplace.assetClassFilter
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            All
          </button>
          <button
            v-for="ac in marketplace.assetClasses"
            :key="ac"
            type="button"
            @click="marketplace.assetClassFilter = ac as any"
            :data-testid="`marketplace-filter-${ac}`"
            :class="[
              'font-sans text-xs font-medium tracking-wide px-5 py-2 rounded-full transition-all duration-200 cursor-pointer',
              marketplace.assetClassFilter === ac
                ? 'bg-gold text-[#2a1e05] dark:bg-signal dark:text-[#2a1e05] font-bold shadow-sm'
                : 'bg-mist/60 dark:bg-[#171717] text-slate dark:text-body-dark/70 hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ assetClassLabels[ac] || ac }}
          </button>
        </div>
      </section>

      <!-- ═══════════════════════════════════════════════════════════
           Token grid — 4-col on xl, dense cards
           ═══════════════════════════════════════════════════════════ -->
      <div
        v-if="marketplace.filtered.length === 0"
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
          v-for="token in marketplace.filtered"
          :key="token.id"
          type="button"
          role="radio"
          :aria-checked="token.address === selected?.address"
          :aria-label="`Select ${token.name} — ${token.symbol}`"
          @click="selectToken(token.address)"
          data-testid="marketplace-token-card"
          :data-token-address="token.address"
          :class="[
            'relative overflow-hidden rounded-2xl p-6 text-left cursor-pointer group',
            'transition-all duration-300 hover:-translate-y-0.5 focus:outline-none',
            'focus-visible:ring-2 focus-visible:ring-gold/50 dark:focus-visible:ring-signal/40',
            token.address === selected?.address
              ? 'border border-gold/40 dark:border-signal/40 bg-white dark:bg-[#0d0e10] shadow-[0_0_30px_-12px_rgba(255,186,32,0.30)]'
              : 'border border-haze dark:border-white/5 bg-white dark:bg-[#0d0e10] hover:bg-mist/40 dark:hover:bg-[#171717]',
          ]"
        >
          <!-- Always-on gold accent bar on the currently-selected card -->
          <div
            v-if="token.address === selected?.address"
            aria-hidden="true"
            class="absolute top-0 left-0 right-0 h-1 bg-gold dark:bg-signal"
          />

          <div class="flex flex-col h-full justify-between gap-8 mt-2">
            <div>
              <h4
                data-testid="marketplace-token-name"
                class="font-sans font-bold text-lg text-midnight dark:text-white mb-1 line-clamp-1"
              >
                {{ token.name }}
              </h4>
              <p
                data-testid="marketplace-token-symbol"
                :class="[
                  'font-mono text-xs uppercase tracking-widest',
                  token.address === selected?.address
                    ? 'text-compute/80 dark:text-signal/80'
                    : 'text-cool',
                ]"
              >
                {{ token.symbol }}
              </p>
              <p
                data-testid="marketplace-token-issuer"
                class="mt-1 font-sans text-[10px] uppercase tracking-[0.22em] text-cool"
              >
                by {{ issuerLabel(token) }}
              </p>
            </div>
            <div class="flex justify-between items-end gap-3">
              <span class="font-sans text-[10px] font-bold tracking-wider uppercase px-3 py-1.5 rounded
                           bg-mist/70 dark:bg-white/5 text-slate dark:text-body-dark/70 border border-haze/70 dark:border-white/5">
                {{ assetClassLabels[token.asset_class] || token.asset_class }}
              </span>
              <span class="font-accent italic font-extrabold text-2xl text-compute dark:text-signal tabular-nums leading-none">
                {{ token.apy ? `${token.apy}%` : '—' }}
              </span>
            </div>
          </div>
        </button>
      </div>

      <p
        v-if="marketplace.filtered.length > 0"
        class="mt-10 text-center font-sans text-xs text-cool"
      >
        {{ marketplace.filtered.length }} of {{ marketplace.tokens.length }} tokens shown
      </p>
    </div>
  </div>
</template>
