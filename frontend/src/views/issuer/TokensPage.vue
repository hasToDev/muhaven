<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import TokenGrowthChart from '@/components/charts/TokenGrowthChart.vue'
import {
  DollarSign, Users, Percent, Coins, Plus, ChevronRight, Landmark, TrendingUp,
} from 'lucide-vue-next'
import type { TokenStatus } from '@/services/api'

const store = useIssuerTokensStore()

const chartRange = ref<'6M' | '1Y' | 'ALL'>('6M')
const ranges: Array<'6M' | '1Y' | 'ALL'> = ['6M', '1Y', 'ALL']

function statusAccent(status: TokenStatus): { label: string; text: string; ring: string; bg: string; dot: string } {
  if (status === 'active') {
    return { label: 'Active', text: 'text-positive', ring: 'border-positive/30', bg: 'bg-positive/10', dot: 'bg-positive' }
  }
  if (status === 'paused') {
    return { label: 'Paused', text: 'text-gold', ring: 'border-gold/30', bg: 'bg-gold/10', dot: 'bg-gold' }
  }
  if (status === 'winding_down') {
    return { label: 'Winding Down', text: 'text-negative', ring: 'border-negative/30', bg: 'bg-negative/10', dot: 'bg-negative' }
  }
  return { label: status, text: 'text-cool', ring: 'border-haze dark:border-white/10', bg: 'bg-haze/30 dark:bg-white/5', dot: 'bg-cool' }
}

onMounted(async () => {
  if (store.loaded) return
  await store.load()
})

const showLoader = computed(() =>
  !store.loaded && !store.error && store.loading,
)

const aggregate = computed(() => store.aggregateStats)

// Resolve the selected token directly from the store's reactive state.
// Defaulting happens inside `store.load()` (sets `selectedAddress` to the
// first active / first overall token), so this just looks it up; the
// `?? store.tokens[0]` is a belt-and-suspenders fallback for the brief
// moment between tokens populating and the default being set.
const selected = computed(() => {
  const list = store.tokens
  if (list.length === 0) return null
  return list.find(t => t.address === store.selectedAddress) ?? list[0] ?? null
})
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading token catalog"
      caption="Reading issued fhERC-20 tokens"
    />

    <!-- Error -->
    <div v-else-if="store.error" class="flex flex-col items-center gap-4 py-16">
      <p class="font-sans text-sm text-negative">{{ store.error }}</p>
      <MButton variant="outline" size="sm" @click="store.load()">Retry</MButton>
    </div>

    <!-- Empty -->
    <div
      v-else-if="store.loaded && store.tokens.length === 0"
      class="flex flex-col items-center gap-4 py-20"
    >
      <div class="w-16 h-16 rounded-2xl bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 flex items-center justify-center">
        <Coins :size="28" :stroke-width="1.6" class="text-cool/70" />
      </div>
      <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight">
        No tokens issued yet
      </p>
      <p class="font-sans text-sm text-cool max-w-md text-center">
        Issue a fhERC-20 vault to start accepting confidential subscriptions.
      </p>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Coming soon — token issuance ships in a future release"
        class="btn-gold-sweep mt-2 px-6 py-3 rounded-lg font-sans font-semibold text-xs tracking-[0.18em] uppercase
               flex items-center gap-2 cursor-not-allowed opacity-70"
      >
        <Plus :size="14" :stroke-width="2.2" aria-hidden="true" />
        New token
        <span class="ml-1 font-mono text-[9px] tracking-[0.2em] opacity-70">(soon)</span>
      </button>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-8">
      <!-- Aggregate stats strip — 4 cards: AUM / Investors / Weighted APY / Active -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480 } }"
        class="grid grid-cols-2 md:grid-cols-4 gap-4"
      >
        <div
          class="rounded-2xl p-5 border border-haze dark:border-white/5
                 bg-white dark:bg-[#171717]"
        >
          <div class="flex items-center gap-2.5 mb-3">
            <div class="w-9 h-9 rounded-full bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center flex-shrink-0">
              <DollarSign :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Total AUM</p>
          </div>
          <p class="font-accent italic text-3xl text-midnight dark:text-white tabular-nums tracking-tight leading-none">
            {{ aggregate.totalAUM ? formatUSD(parseFloat(aggregate.totalAUM), 0) : '—' }}
          </p>
        </div>

        <div
          class="rounded-2xl p-5 border border-haze dark:border-white/5
                 bg-white dark:bg-[#171717]"
        >
          <div class="flex items-center gap-2.5 mb-3">
            <div class="w-9 h-9 rounded-full bg-positive/10 border border-positive/25 flex items-center justify-center flex-shrink-0">
              <Users :size="15" :stroke-width="1.8" class="text-positive" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Total Investors</p>
          </div>
          <p class="font-accent italic text-3xl text-midnight dark:text-white tabular-nums tracking-tight leading-none">
            {{ aggregate.totalInvestors }}
          </p>
        </div>

        <div
          class="rounded-2xl p-5 border border-haze dark:border-white/5
                 bg-white dark:bg-[#171717]"
        >
          <div class="flex items-center gap-2.5 mb-3">
            <div class="w-9 h-9 rounded-full bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center flex-shrink-0">
              <Percent :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Weighted APY</p>
          </div>
          <p class="font-accent italic text-3xl text-gold tabular-nums tracking-tight leading-none">
            {{ aggregate.weightedAPY ? `${aggregate.weightedAPY}%` : '—' }}
          </p>
        </div>

        <div
          class="rounded-2xl p-5 border border-haze dark:border-white/5
                 bg-white dark:bg-[#171717]"
        >
          <div class="flex items-center gap-2.5 mb-3">
            <div class="w-9 h-9 rounded-full bg-mist/70 dark:bg-white/5 border border-haze dark:border-white/10 flex items-center justify-center flex-shrink-0">
              <Coins :size="15" :stroke-width="1.8" class="text-slate dark:text-body-dark/80" />
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Active Tokens</p>
          </div>
          <p class="font-accent italic text-3xl text-midnight dark:text-white tabular-nums tracking-tight leading-none">
            {{ aggregate.activeTokens }}
          </p>
        </div>
      </section>

      <!-- Master-detail: Token Assets list (4) + Detail panel (8) -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 100 } }"
      >
        <!-- Header row: section label (left) + "+ New token" button (right) -->
        <div class="flex items-center justify-between gap-3 mb-4">
          <div class="flex items-center gap-2.5">
            <div class="w-1 h-4 bg-gold dark:bg-signal rounded-full" />
            <h3 class="font-sans text-[11px] uppercase tracking-[0.24em] text-cool font-bold">
              Token Assets · {{ store.tokens.length }}
            </h3>
          </div>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Coming soon — token issuance ships in a future release"
            class="btn-gold-sweep px-5 py-2.5 rounded-lg font-sans font-semibold text-[11px] tracking-[0.18em] uppercase
                   flex items-center gap-2 cursor-not-allowed opacity-70"
          >
            <Plus :size="13" :stroke-width="2.2" aria-hidden="true" />
            New token
            <span class="ml-1 font-mono text-[9px] tracking-[0.2em] opacity-70">(soon)</span>
          </button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <!-- LEFT: Token list (4 cols) -->
          <div class="lg:col-span-4 flex flex-col gap-3">
            <button
              v-for="t in store.tokens"
              :key="t.address"
              type="button"
              @click="store.selectToken(t.address)"
              :data-testid="`tokens-list-${t.symbol}`"
              :aria-pressed="t.address === selected?.address"
              :class="[
                'relative w-full text-left flex items-center gap-4 p-4 rounded-xl transition-all duration-200 cursor-pointer',
                t.address === selected?.address
                  ? 'bg-mist/70 dark:bg-[#1f1e1e] border border-gold/45 dark:border-signal/40 shadow-[0_0_24px_-8px_rgba(255,186,32,0.35)] dark:shadow-[0_0_24px_-8px_rgba(255,220,161,0.35)]'
                  : 'bg-white dark:bg-[#171717] border border-haze dark:border-white/5 hover:bg-mist/40 dark:hover:bg-[#1c1b1b] hover:border-haze dark:hover:border-white/15',
              ]"
            >
              <div
                :class="[
                  'w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
                  t.address === selected?.address
                    ? 'bg-gold/15 dark:bg-signal/15 border border-gold/35 dark:border-signal/35 text-compute dark:text-signal shadow-[inset_0_0_10px_rgba(255,186,32,0.18)]'
                    : 'bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10 text-cool',
                ]"
              >
                <Landmark :size="20" :stroke-width="1.6" />
              </div>
              <div class="flex-1 min-w-0">
                <h4
                  :class="[
                    'font-accent italic text-base md:text-lg tracking-tight leading-tight truncate',
                    t.address === selected?.address
                      ? 'text-midnight dark:text-white'
                      : 'text-midnight/80 dark:text-white/75',
                  ]"
                >
                  {{ t.name }}
                </h4>
                <p class="font-mono text-[10px] uppercase tracking-[0.22em] text-cool mt-0.5">
                  {{ t.symbol }}
                </p>
              </div>
              <ChevronRight
                v-if="t.address === selected?.address"
                :size="18"
                :stroke-width="2"
                class="text-compute dark:text-signal flex-shrink-0"
                aria-hidden="true"
              />
            </button>
          </div>

          <!-- RIGHT: Detail panel (8 cols) -->
          <div v-if="selected" :key="selected.address" class="lg:col-span-8 flex flex-col gap-5">
            <!-- Detail header: large icon + name + pills (no FHE pill per Q7 B) -->
            <div
              v-motion
              :initial="{ opacity: 0, y: 8 }"
              :enter="{ opacity: 1, y: 0, transition: { duration: 320 } }"
              class="flex items-start gap-5"
            >
              <div
                class="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0
                       bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25
                       text-compute dark:text-signal shadow-[inset_0_0_15px_rgba(255,186,32,0.08)]"
              >
                <Landmark :size="26" :stroke-width="1.5" />
              </div>
              <div class="flex-1 min-w-0">
                <h2 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight leading-tight mb-2.5">
                  {{ selected.name }}
                </h2>
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.22em] font-medium
                           bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/10
                           text-slate dark:text-body-dark/80 px-2.5 py-1 rounded"
                  >
                    {{ selected.symbol }}
                  </span>
                  <span
                    :class="[
                      'inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold px-2.5 py-1 rounded border',
                      statusAccent(selected.status).text,
                      statusAccent(selected.status).ring,
                      statusAccent(selected.status).bg,
                    ]"
                  >
                    <span :class="['w-1.5 h-1.5 rounded-full', statusAccent(selected.status).dot, selected.status === 'active' && 'animate-pulse']" />
                    {{ statusAccent(selected.status).label }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Detail stats grid (2/4 cols) -->
            <div
              v-motion
              :initial="{ opacity: 0, y: 8 }"
              :enter="{ opacity: 1, y: 0, transition: { duration: 360, delay: 60 } }"
              class="grid grid-cols-2 lg:grid-cols-4 gap-4"
            >
              <div class="rounded-xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2">Total Supply</p>
                <p class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums tracking-tight leading-none mb-1.5">
                  {{ selected.supply }}
                </p>
                <p class="font-mono text-[10px] text-positive uppercase tracking-[0.22em]">fhERC-20</p>
              </div>
              <div class="rounded-xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2">Investors</p>
                <p class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums tracking-tight leading-none mb-1.5">
                  {{ selected.investors ?? '—' }}
                </p>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.22em]">Unique Wallets</p>
              </div>
              <div class="rounded-xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2">Yield APY</p>
                <p class="font-accent italic text-2xl text-gold tabular-nums tracking-tight leading-none mb-1.5">
                  {{ selected.apy ? `${selected.apy}%` : '—' }}
                </p>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.22em]">Fixed Rate</p>
              </div>
              <div class="rounded-xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2">Schedule</p>
                <p class="font-accent italic text-2xl text-midnight dark:text-white tracking-tight leading-none mb-1.5">
                  {{ selected.schedule ?? '—' }}
                </p>
                <p class="font-sans text-[10px] text-cool uppercase tracking-[0.22em]">Distribution</p>
              </div>
            </div>

            <!-- Chart section with time-range toggle -->
            <div
              v-motion
              :initial="{ opacity: 0, y: 8 }"
              :enter="{ opacity: 1, y: 0, transition: { duration: 400, delay: 120 } }"
              class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-6 md:p-7"
            >
              <div class="flex flex-wrap items-start justify-between gap-3 mb-6">
                <div>
                  <h3 class="font-accent italic text-xl text-midnight dark:text-white tracking-tight">
                    Investor Growth Analytics
                  </h3>
                  <p class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool mt-1.5">
                    Historical onboarding · last {{ chartRange === '6M' ? '6 months' : chartRange === '1Y' ? '12 months' : 'all time' }}
                  </p>
                </div>
                <div class="flex items-center gap-1 bg-mist/60 dark:bg-[#0d0e10] border border-haze dark:border-white/5 rounded-lg p-1">
                  <button
                    v-for="r in ranges"
                    :key="r"
                    type="button"
                    @click="chartRange = r"
                    :data-testid="`tokens-chart-range-${r}`"
                    :class="[
                      'font-sans text-[10px] uppercase tracking-[0.22em] font-semibold px-4 py-1.5 rounded-md transition-all duration-200 cursor-pointer',
                      chartRange === r
                        ? 'bg-haze/70 dark:bg-white/10 text-gold dark:text-signal shadow-[0_4px_12px_-4px_rgba(0,0,0,0.18)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)]'
                        : 'text-cool hover:text-midnight dark:hover:text-white',
                    ]"
                  >
                    {{ r }}
                  </button>
                </div>
              </div>
              <div class="flex items-center gap-2 mb-3">
                <TrendingUp :size="14" :stroke-width="1.8" class="text-gold dark:text-signal" />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Aggregate only — individual balances stay encrypted
                </span>
              </div>
              <div class="h-[180px]">
                <TokenGrowthChart :symbol="selected.symbol" :range="chartRange" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
