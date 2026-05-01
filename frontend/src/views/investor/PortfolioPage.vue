<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { usePortfolioStore } from '@/stores/portfolio'
import { useWallet } from '@/composables/useWallet'
import MBadge from '@/components/ui/MBadge.vue'
import MFaucetBanner from '@/components/ui/MFaucetBanner.vue'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import PortfolioDonut from '@/components/charts/PortfolioDonut.vue'
import {
  Shield, Lock, ShieldCheck, KeyRound, Key, Eye, ArrowUp,
  Loader2, Unlock, CircleDot, RefreshCw,
} from 'lucide-vue-next'
import { formatUSD, cn } from '@/lib/utils'

const portfolio = usePortfolioStore()
const { address } = useWallet()

type HeroTab = 'value' | 'allocation'
const activeTab = ref<HeroTab>('value')

// Only fetch when we don't already have data. Re-mounting on navigation
// (e.g. /yields → /portfolio) should NOT flash a loader if the store is warm.
onMounted(async () => {
  if (!address.value) return
  if (portfolio.loaded) return
  await portfolio.load(address.value as `0x${string}`)
})

// Show the logo loader only while we're waiting for the very first fetch.
// Once `loaded` is true the loader never returns (manual refetches update
// data in place; decrypt calls have their own inline spinners).
const showLoader = computed(() =>
  !portfolio.loaded && !portfolio.error && portfolio.loading,
)

// Reveal All shows in-flight state whenever ANY decrypt is running on the
// page (per-holding click or Reveal All click). The pending count drives the
// "Revealing N…" countdown — it ticks down as each decrypt resolves, giving
// a concrete progress signal inside the gold CTA.
const pendingDecryptCount = computed(() => {
  let n = 0
  for (const h of portfolio.holdings) if (h.decrypting) n++
  if (portfolio.pusdcDecrypting) n++
  return n
})
const revealing = computed(() => pendingDecryptCount.value > 0)

async function decryptAll() {
  if (!address.value) return
  const acct = address.value as `0x${string}`
  const pending = portfolio.holdings
    .map((h, i) => h.decryptedBalance === null ? i : -1)
    .filter(i => i >= 0)

  // Kick off the confidential-PUSDC decrypt alongside the per-holding
  // decrypts so "Reveal All" reveals the whole portfolio in one click.
  // Guarded against re-running when already revealed or in-flight; the
  // store's own `pusdcDecrypting` flag is the source of truth, this
  // outer check just avoids a redundant network round-trip + the brief
  // mid-flight `pusdcConfidentialBalance = null` flicker that
  // `decryptPusdc` does at start.
  const pusdcPending =
    portfolio.pusdcConfidentialBalance === null && !portfolio.pusdcDecrypting
  await Promise.all([
    ...pending.map(i => portfolio.decryptHolding(i, acct)),
    ...(pusdcPending ? [portfolio.decryptPusdc(acct)] : []),
  ])
}

async function decryptOne(index: number) {
  if (!address.value) return
  await portfolio.decryptHolding(index, address.value as `0x${string}`)
}

async function decryptPusdc() {
  if (!address.value) return
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

function formatTokenAmount(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

function holdingUsdValue(h: typeof portfolio.holdings[number]): string {
  if (h.decryptedBalance === null) return ''
  // Wave 3.5: shares are raw integer units (1 share == 1n on-chain).
  // Backend `latest_nav.nav` is USD per whole share. See portfolio store
  // `totalDecryptedValue` for the symmetric calculation + rationale.
  const tokens = Number(h.decryptedBalance)
  if (h.nav) return formatUSD(tokens * h.nav)
  return `${formatTokenAmount(tokens)} ${h.symbol}`
}

function holdingColorClass(index: number): string {
  const palette = ['bg-gold', 'bg-signal dark:bg-signal', 'bg-compute', 'bg-cipher']
  return palette[index % palette.length]
}

/** Allocation percentages (only meaningful when all decrypted). */
const allocationBreakdown = computed(() =>
  portfolio.holdings.map((h, i) => {
    if (h.decryptedBalance === null || portfolio.totalDecryptedValue <= 0) {
      return { name: h.name, pct: 0, color: holdingColorClass(i) }
    }
    // Wave 3.5 raw-integer share convention; see holdingUsdValue.
    const value = Number(h.decryptedBalance) * (h.nav ?? 1)
    return {
      name: h.name,
      pct: (value / portfolio.totalDecryptedValue) * 100,
      color: holdingColorClass(i),
    }
  }),
)
</script>

<template>
  <div>
    <!-- Loading: branded logo pulse (only on the very first fetch).
         Loader component is shared (MPageLoader) so every revamped page uses
         the same visual language. See D-024. -->
    <MPageLoader
      v-if="showLoader"
      label="Loading your portfolio"
      caption="Fetching encrypted balances"
    />

    <!-- Error state -->
    <div v-else-if="portfolio.error" class="flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ portfolio.error }}</p>
      <MButton variant="outline" @click="address && portfolio.load(address as `0x${string}`)">
        Retry
      </MButton>
    </div>

    <!-- Empty state — Phase 9.A: primary CTA points to /cash (the new
         first nav item / cockpit). The previous "Trade shares" CTA was a
         dead-end for zero-mhUSDC users (Subscription.purchase reverts).
         Cash → fund → convert → trade is the right sequence; surface the
         first step as the primary affordance and offer Trade as a quieter
         fallback for users who already wrapped elsewhere. -->
    <div v-else-if="portfolio.loaded && portfolio.holdings.length === 0" class="flex flex-col items-center justify-center py-20 gap-4">
      <Shield :size="48" class="text-cool/40" />
      <p class="text-base text-cool">No holdings yet</p>
      <p class="text-sm text-cool/70 max-w-sm text-center">
        Fund your wallet and convert USDC to <span class="font-mono text-[12px]">mhUSDC</span> first — then you'll be ready to buy RWA shares on the Trade page.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3 pt-2">
        <RouterLink to="/cash">
          <MButton data-testid="portfolio-empty-cash-cta">Set up cash</MButton>
        </RouterLink>
        <RouterLink
          to="/trade"
          data-testid="portfolio-empty-trade-link"
          class="font-sans text-[11px] uppercase tracking-[0.22em] font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors inline-flex items-center gap-1.5"
        >
          Already funded? Trade
          <span aria-hidden="true">→</span>
        </RouterLink>
      </div>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-12">
      <!-- Faucet banner -->
      <MFaucetBanner v-if="portfolio.usdcBalance !== null && portfolio.usdcBalance === 0n" />

      <!-- ══════════════════════════════════════════════════════════
           Hero: tabbed value / allocation card
           ══════════════════════════════════════════════════════════ -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 24 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
      >
        <!-- Tab bar -->
        <div class="flex items-center gap-6 mb-6 border-b border-haze dark:border-white/5" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'value'"
            @click="activeTab = 'value'"
            :class="cn(
              'font-sans text-[11px] uppercase tracking-[0.22em] pb-3 relative top-px transition-colors duration-200 cursor-pointer',
              activeTab === 'value'
                ? 'text-compute dark:text-signal border-b border-gold dark:border-signal font-semibold'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            )"
          >
            Total Portfolio Value
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'allocation'"
            @click="activeTab = 'allocation'"
            :class="cn(
              'font-sans text-[11px] uppercase tracking-[0.22em] pb-3 relative top-px transition-colors duration-200 cursor-pointer',
              activeTab === 'allocation'
                ? 'text-compute dark:text-signal border-b border-gold dark:border-signal font-semibold'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            )"
          >
            Allocation
          </button>
          <div class="h-px flex-1 bg-gradient-to-r from-haze/60 dark:from-white/8 to-transparent mb-3 hidden sm:block" />
        </div>

        <!-- Hero card -->
        <div
          class="glass-border-card relative overflow-hidden rounded-2xl border border-haze dark:border-white/5
                 bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
                 shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
                 dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
        >
          <!-- Value tab -->
          <div
            v-if="activeTab === 'value'"
            class="p-8 md:p-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 border-b border-haze dark:border-white/5 relative"
          >
            <!-- Ambient amber bloom, top-left corner -->
            <div
              aria-hidden="true"
              class="absolute -top-24 -left-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none
                     bg-gold/10 dark:bg-signal/8"
            />

            <!-- Left: locked OR decrypted value -->
            <div class="space-y-4 z-10 min-w-0 flex-1">
              <div class="flex items-center gap-3 text-cool/90 dark:text-body-dark/80">
                <Lock
                  v-if="!portfolio.allDecrypted"
                  :size="20"
                  :stroke-width="1.6"
                />
                <ShieldCheck
                  v-else
                  :size="20"
                  :stroke-width="1.6"
                  class="text-gold dark:text-signal"
                />
                <span class="font-accent italic text-lg md:text-xl">
                  {{ portfolio.allDecrypted ? 'Revealed' : 'Encrypted' }}
                </span>
              </div>

              <!-- Locked placeholder -->
              <div
                v-if="!portfolio.allDecrypted"
                class="font-sans font-light text-5xl md:text-6xl text-cool/40 dark:text-body-dark/25
                       tracking-[0.05em] select-none blur-[2px] leading-none"
                aria-hidden="true"
              >
                ****.****.**
              </div>

              <!-- Decrypted hero value -->
              <div
                v-else
                class="font-accent italic text-5xl md:text-6xl tracking-tight text-midnight dark:text-white leading-none tabular-nums"
              >
                {{ formatUSD(portfolio.totalDecryptedValue) }}
              </div>
            </div>

            <!-- Right: Reveal All gold gradient CTA (only when locked) -->
            <button
              v-if="!portfolio.allDecrypted"
              type="button"
              @click="decryptAll"
              :disabled="revealing"
              :aria-busy="revealing"
              data-testid="portfolio-reveal-all-cta"
              class="btn-gold-sweep z-10 px-8 py-3.5 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.98]
                     disabled:cursor-wait disabled:hover:translate-y-0"
            >
              <Loader2 v-if="revealing" :size="16" :stroke-width="2" class="animate-spin" />
              <KeyRound v-else :size="16" :stroke-width="2" />
              <span aria-live="polite">{{ revealing ? `Revealing ${pendingDecryptCount}…` : 'Reveal All' }}</span>
            </button>
          </div>

          <!-- Allocation tab -->
          <div
            v-else
            class="p-8 md:p-10 flex flex-col items-center justify-center border-b border-haze dark:border-white/5 relative min-h-[320px]"
          >
            <!-- Ambient accent bleeds -->
            <div
              aria-hidden="true"
              class="absolute top-1/2 left-1/4 w-40 h-40 bg-gold/10 dark:bg-signal/10 rounded-full blur-[50px] -translate-y-1/2 pointer-events-none"
            />
            <div
              aria-hidden="true"
              class="absolute top-1/2 right-1/4 w-44 h-44 bg-cipher/15 dark:bg-cipher/10 rounded-full blur-[55px] -translate-y-1/2 pointer-events-none"
            />

            <!-- LOCKED allocation state -->
            <div
              v-if="!portfolio.allDecrypted"
              class="z-10 w-full max-w-md mx-auto text-center space-y-5"
            >
              <!-- Blurred donut icon -->
              <div class="relative inline-block">
                <div
                  aria-hidden="true"
                  class="w-20 h-20 rounded-full border-[10px] border-cool/25 dark:border-body-dark/20
                         blur-[2px] mx-auto"
                />
                <Lock
                  :size="22"
                  :stroke-width="1.8"
                  class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-cool dark:text-body-dark/60"
                />
              </div>
              <h3 class="font-accent italic text-2xl text-slate dark:text-body-dark/90">
                Allocation blurred
              </h3>
              <p class="font-sans text-sm text-cool leading-relaxed">
                Decrypt all holdings to view precise portfolio allocation and exposure metrics.
              </p>

              <!-- Blurred preview bars -->
              <div class="pt-2 space-y-3 text-left">
                <div v-for="h in portfolio.holdings.slice(0, 3)" :key="h.tokenAddress">
                  <div class="flex justify-between text-[10px] font-sans text-cool/80 mb-1.5 uppercase tracking-[0.18em]">
                    <span>{{ h.name }}</span>
                    <span>??%</span>
                  </div>
                  <div class="w-full h-1.5 rounded-full overflow-hidden bg-haze/40 dark:bg-white/5">
                    <div
                      class="h-full bg-cool/30 dark:bg-body-dark/25 blur-[2px] rounded-full"
                      :style="{ width: `${30 + (h.name.charCodeAt(0) % 50)}%` }"
                    />
                  </div>
                </div>
              </div>

              <div class="pt-2">
                <button
                  type="button"
                  @click="decryptAll"
                  :disabled="revealing"
                  :aria-busy="revealing"
                  class="btn-gold-sweep inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-sans font-semibold text-xs tracking-wide cursor-pointer transition-all duration-300 hover:-translate-y-0.5 disabled:cursor-wait disabled:hover:translate-y-0"
                >
                  <Loader2 v-if="revealing" :size="14" :stroke-width="2" class="animate-spin" />
                  <Key v-else :size="14" :stroke-width="2" />
                  <span aria-live="polite">{{ revealing ? `Revealing ${pendingDecryptCount}…` : 'Reveal allocation' }}</span>
                </button>
              </div>
            </div>

            <!-- DECRYPTED allocation state — real donut + legend -->
            <div v-else class="z-10 w-full flex flex-col md:flex-row items-center gap-8">
              <div class="w-44 md:w-52 flex-shrink-0">
                <PortfolioDonut />
              </div>
              <div class="flex-1 w-full">
                <!-- Segmented allocation bar -->
                <div class="flex h-2.5 rounded-full overflow-hidden gap-0.5 mb-5">
                  <div
                    v-for="a in allocationBreakdown"
                    :key="a.name"
                    :class="[a.color, 'rounded-full transition-all duration-1000 ease-out']"
                    :style="{ width: `${a.pct}%` }"
                  />
                </div>
                <!-- Legend -->
                <div class="flex flex-wrap gap-x-5 gap-y-2.5">
                  <div
                    v-for="a in allocationBreakdown"
                    :key="a.name"
                    class="flex items-center gap-2"
                  >
                    <span :class="['w-2.5 h-2.5 rounded-sm', a.color]" />
                    <span class="font-sans text-xs text-slate dark:text-body-dark/80 tabular-nums">
                      {{ a.name }}
                      <span class="text-cool"> &middot; {{ a.pct.toFixed(0) }}%</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom stats strip (always visible). Cash moved into the
               dedicated Cash section below the hero — having USDC on both
               surfaces was a duplicate (Researcher + Architect call). -->
          <div
            class="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x
                   divide-haze dark:divide-white/5
                   bg-mist/40 dark:bg-white/[0.02]"
          >
            <div class="p-6 flex flex-col gap-1">
              <p class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
                Holdings
              </p>
              <p class="font-accent italic text-2xl text-midnight dark:text-white">
                {{ portfolio.holdings.length }} {{ portfolio.holdings.length === 1 ? 'asset' : 'assets' }}
              </p>
            </div>
            <div class="p-6 flex flex-col justify-center gap-1.5">
              <div class="flex justify-between items-center">
                <p class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
                  FHE Status
                </p>
                <span
                  class="flex items-center gap-1.5 text-compute dark:text-signal bg-compute/10 dark:bg-signal/10
                         px-2 py-0.5 rounded text-[10px] font-sans font-medium"
                >
                  <CircleDot :size="8" class="animate-pulse" :stroke-width="3" />
                  <span class="tracking-wider">Active</span>
                </span>
              </div>
              <p class="font-sans text-xs text-slate dark:text-body-dark/75">
                Balances encrypted <span class="font-mono text-[11px]">(euint128)</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════
           Cash — Phase 9.A: dedicated section between Hero and Holdings.
           Holdings is now RWA-only; cash gets equal billing here so the
           hero "Total Portfolio Value" math reconciles (mhUSDC contributes
           when revealed). USDC is plaintext on-chain; mhUSDC is the
           confidential wrapper and decrypts on opt-in.
           ══════════════════════════════════════════════════════════ -->
      <section class="space-y-6" data-testid="portfolio-cash-section">
        <div class="flex items-center justify-between">
          <h3 class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tracking-tight">
            Cash
          </h3>
        </div>
        <div class="h-px w-full bg-haze dark:bg-white/5" />

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <!-- USDC tile (plaintext ERC-20) -->
          <div
            v-if="portfolio.usdcBalance !== null"
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
            data-testid="portfolio-cash-usdc-tile"
            class="rounded-xl p-5 md:p-6 border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
          >
            <div class="flex-1 min-w-0">
              <h4 class="font-accent italic text-xl md:text-2xl text-slate dark:text-body-dark/90 tracking-tight mb-2 leading-tight">
                Cash Buffer
              </h4>
              <div class="flex items-center gap-2.5 flex-wrap">
                <span
                  class="font-mono text-[10px] text-slate dark:text-body-dark/70 bg-haze/50 dark:bg-white/5
                         px-2 py-0.5 rounded tracking-wider font-medium"
                >
                  USDC
                </span>
                <span class="font-sans text-[10px] text-cool uppercase tracking-[0.18em]">
                  Standard ERC-20 · plaintext
                </span>
              </div>
            </div>
            <div class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight">
              {{ formatUSD(Number(portfolio.usdcBalance) / 1e6) }}
            </div>
          </div>

          <!-- mhUSDC tile (encrypted, opt-in decrypt) -->
          <div
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 90 } }"
            data-testid="portfolio-cash-mhusdc-tile"
            class="rounded-xl p-5 md:p-6 border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
          >
            <div class="flex-1 min-w-0">
              <h4 class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tracking-tight mb-2 leading-tight">
                Encrypted Cash
              </h4>
              <div class="flex items-center gap-2.5 flex-wrap">
                <MBadge variant="privacy">mhUSDC</MBadge>
                <span class="font-sans text-[10px] text-cool uppercase tracking-[0.18em]">
                  Confidential stablecoin
                </span>
              </div>
            </div>

            <!-- Locked: blurred placeholder + Decrypt CTA -->
            <div
              v-if="portfolio.pusdcConfidentialBalance === null"
              class="flex items-center gap-3 md:flex-shrink-0"
            >
              <span
                class="font-accent italic text-2xl md:text-3xl text-cool/40 dark:text-body-dark/30
                       tabular-nums select-none blur-[2.5px] tracking-[0.05em]"
                aria-hidden="true"
              >
                $••••.••
              </span>
              <button
                type="button"
                @click="decryptPusdc"
                :disabled="portfolio.pusdcDecrypting"
                data-testid="portfolio-cash-mhusdc-decrypt-cta"
                class="font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                       text-compute dark:text-signal
                       border border-compute/30 dark:border-signal/30
                       hover:text-white dark:hover:text-[#412d00]
                       hover:bg-compute dark:hover:bg-signal
                       px-4 py-2 rounded transition-all duration-200 cursor-pointer
                       disabled:opacity-60 disabled:cursor-wait inline-flex items-center justify-center gap-1.5"
              >
                <Loader2 v-if="portfolio.pusdcDecrypting" :size="10" class="animate-spin" />
                <Eye v-else :size="10" :stroke-width="2" />
                <span>Decrypt</span>
              </button>
            </div>

            <!-- Revealed: value + Refresh affordance -->
            <div
              v-else
              class="flex items-center gap-3 md:flex-shrink-0"
            >
              <div class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight">
                {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
              </div>
              <button
                type="button"
                @click="decryptPusdc"
                :disabled="portfolio.pusdcDecrypting"
                data-testid="portfolio-cash-mhusdc-refresh-cta"
                :title="portfolio.pusdcDecrypting ? 'Refreshing…' : 'Re-read + decrypt'"
                :aria-label="portfolio.pusdcDecrypting ? 'Refreshing encrypted cash balance' : 'Refresh encrypted cash balance'"
                class="text-[10px] font-sans text-cool hover:text-compute dark:hover:text-signal
                       transition-colors flex items-center gap-1 cursor-pointer
                       disabled:opacity-50 disabled:cursor-wait"
              >
                <Loader2 v-if="portfolio.pusdcDecrypting" :size="10" class="animate-spin" />
                <RefreshCw v-else :size="10" />
                <span class="sr-only md:not-sr-only">Refresh</span>
              </button>
            </div>
          </div>
        </div>

        <!-- mhUSDC scoped error (was under Holdings; moved here with the
             card it belongs to). -->
        <div
          v-if="portfolio.pusdcError"
          class="flex items-start gap-2 px-4 py-3 rounded-lg bg-negative/8 border border-negative/20"
        >
          <p class="text-[11px] font-sans text-negative leading-relaxed">
            {{ portfolio.pusdcError }}
          </p>
        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════
           Holdings
           ══════════════════════════════════════════════════════════ -->
      <section class="space-y-6">
        <div class="flex items-center justify-between">
          <h3 class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tracking-tight">
            Holdings
          </h3>
          <button
            v-if="!portfolio.allDecrypted"
            type="button"
            @click="decryptAll"
            :disabled="revealing"
            :aria-busy="revealing"
            class="btn-gold-sweep px-5 py-2.5 rounded-lg font-sans font-semibold text-xs tracking-wide
                   flex items-center gap-2 cursor-pointer transition-all duration-300
                   hover:-translate-y-0.5 active:scale-[0.98]
                   disabled:cursor-wait disabled:hover:translate-y-0"
          >
            <Loader2 v-if="revealing" :size="14" :stroke-width="2" class="animate-spin" />
            <KeyRound v-else :size="14" :stroke-width="2" />
            <span aria-live="polite">{{ revealing ? `Revealing ${pendingDecryptCount}…` : 'Reveal All' }}</span>
          </button>
        </div>
        <div class="h-px w-full bg-haze dark:bg-white/5" />

        <div class="space-y-3">
          <!-- RWA holdings -->
          <div
            v-for="(h, i) in portfolio.holdings"
            :key="h.tokenAddress"
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: i * 90 } }"
            :data-testid="'portfolio-holding-card'"
            :data-token-address="h.tokenAddress"
            class="rounded-xl p-5 md:p-6 border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717] hover:border-gold/40 dark:hover:border-signal/25
                   transition-colors duration-300
                   flex items-center justify-between gap-4"
          >
            <!-- Name + ticker -->
            <div class="flex-1 min-w-[160px]">
              <h4 class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tracking-tight mb-2 leading-tight">
                {{ h.name }}
              </h4>
              <div class="flex items-center gap-2.5 flex-wrap">
                <span
                  class="font-mono text-[10px] text-compute dark:text-signal bg-compute/8 dark:bg-signal/10
                         px-2 py-0.5 rounded tracking-wider font-medium"
                >
                  {{ h.symbol }}
                </span>
                <span class="font-sans text-[10px] text-cool uppercase tracking-[0.18em]">
                  {{ h.assetClass.replace(/_/g, ' ') }}
                </span>
              </div>
            </div>

            <!-- Middle: cipher blob (locked) OR decrypted value -->
            <div class="hidden md:flex flex-1 items-center justify-center gap-3 min-w-0">
              <template v-if="h.decrypting">
                <Loader2 :size="16" :stroke-width="1.8" class="text-compute dark:text-signal animate-spin flex-shrink-0" />
                <span class="font-sans text-xs text-cool">Decrypting via CoFHE…</span>
              </template>
              <template v-else-if="h.decryptedBalance !== null">
                <div class="flex flex-col items-center text-center">
                  <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums leading-tight">
                    {{ holdingUsdValue(h) }}
                  </span>
                  <span class="font-sans text-[11px] text-cool tabular-nums mt-0.5">
                    {{ formatTokenAmount(Number(h.decryptedBalance)) }} {{ h.symbol }}
                  </span>
                </div>
              </template>
              <template v-else>
                <Lock :size="13" :stroke-width="1.8" class="text-cool/80 flex-shrink-0" />
                <span class="font-mono text-sm text-cool/60 dark:text-body-dark/30 blur-[2.5px] select-none">
                  euint128_encrypted
                </span>
              </template>
            </div>

            <!-- FHE Encrypted pill — always visible, describes on-chain state -->
            <div class="hidden lg:flex w-36 justify-center">
              <span
                class="font-sans text-[9px] uppercase tracking-[0.2em] font-medium
                       text-compute/70 dark:text-signal/70
                       border border-compute/25 dark:border-signal/20
                       px-3 py-1.5 rounded"
              >
                FHE Encrypted
              </span>
            </div>

            <!-- APY -->
            <div class="text-right flex flex-col items-end w-20 md:w-24">
              <span class="flex items-center gap-1 text-midnight dark:text-white font-sans text-lg md:text-xl tabular-nums font-medium">
                {{ h.apy !== null ? `${h.apy}%` : '—' }}
                <ArrowUp v-if="h.apy !== null" :size="13" :stroke-width="2.2" class="text-gold dark:text-signal" />
              </span>
              <span class="font-sans text-[9px] text-cool uppercase tracking-[0.2em]">APY</span>
            </div>

            <!-- Decrypt / Decrypted button -->
            <div class="ml-2 md:ml-4 w-28 text-right flex-shrink-0">
              <button
                v-if="h.decryptedBalance === null"
                type="button"
                @click="decryptOne(i)"
                :disabled="h.decrypting"
                data-testid="portfolio-decrypt-cta"
                class="w-full font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                       text-compute dark:text-signal
                       border border-compute/30 dark:border-signal/30
                       hover:text-white dark:hover:text-[#412d00]
                       hover:bg-compute dark:hover:bg-signal
                       px-4 py-2 rounded transition-all duration-200 cursor-pointer
                       disabled:opacity-60 disabled:cursor-wait inline-flex items-center justify-center gap-1.5"
              >
                <Loader2 v-if="h.decrypting" :size="10" class="animate-spin" />
                <Eye v-else :size="10" :stroke-width="2" />
                <span>Decrypt</span>
              </button>
              <span
                v-else
                class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                       text-positive bg-positive/10 border border-positive/25
                       px-4 py-2 rounded"
              >
                <Unlock :size="10" :stroke-width="2.2" />
                Revealed
              </span>
            </div>
          </div>

        </div>
      </section>

      <!-- ══════════════════════════════════════════════════════════
           Footer privacy pill
           ══════════════════════════════════════════════════════════ -->
      <footer class="mt-4 pt-8 border-t border-haze dark:border-white/5 flex justify-center">
        <div
          class="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-full
                 bg-mist/70 dark:bg-[#0d0e10]/80
                 border border-haze dark:border-white/5
                 text-[11px] font-sans text-slate dark:text-body-dark/70"
        >
          <Shield :size="13" :stroke-width="1.8" class="text-compute/80 dark:text-signal/80" />
          <span>
            All token balances are encrypted on-chain via Fhenix FHE. Click
            <span class="font-medium text-compute dark:text-signal">Decrypt</span>
            to reveal — only you can see this data.
          </span>
        </div>
      </footer>
    </div>
  </div>
</template>

