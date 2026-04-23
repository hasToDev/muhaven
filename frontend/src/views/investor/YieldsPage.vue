<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import { useYieldsStore } from '@/stores/yields'
import { useWallet } from '@/composables/useWallet'
import * as EscrowService from '@/services/contracts/EscrowService'
import { WalletNotConnectedError } from '@/services/contracts/errors'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import YieldLineChart from '@/components/charts/YieldLineChart.vue'
import {
  DollarSign, Clock, CalendarDays, Inbox, Lock, Coins, ShieldCheck,
  KeyRound, Loader2, CheckCircle2,
} from 'lucide-vue-next'

const yields = useYieldsStore()
const { connected } = useWallet()

const activeRange = ref<'1m' | '3m' | '6m' | '1y'>('6m')
const ranges = [
  { label: '1M', value: '1m' as const },
  { label: '3M', value: '3m' as const },
  { label: '6M', value: '6m' as const },
  { label: '1Y', value: '1y' as const },
]

const claimingIds = ref<Set<string>>(new Set())

const CLAIM_REFETCH_DELAY_MS = 22_000
const ARBISCAN_TX_BASE = 'https://sepolia.arbiscan.io/tx/'

onMounted(async () => {
  if (yields.loaded) return
  await yields.load()
})

const showLoader = computed(() =>
  !yields.loaded && !yields.error && yields.loading,
)

async function claimYield(recordId: string, escrowId: string | null) {
  if (claimingIds.value.has(recordId)) return

  if (!escrowId) {
    toast.error('Claim unavailable', {
      description: 'On-chain escrow not yet indexed — try again shortly',
    })
    return
  }

  if (!connected.value) {
    toast.error('Wallet not connected', {
      description: 'Sign in with your passkey to claim yield',
    })
    return
  }

  claimingIds.value.add(recordId)
  try {
    const hash = await EscrowService.redeem(BigInt(escrowId))
    toast.success('Claim submitted', {
      description: `tx ${hash.slice(0, 10)}… — status will update once confirmed`,
      action: {
        label: 'View',
        onClick: () => window.open(`${ARBISCAN_TX_BASE}${hash}`, '_blank', 'noopener'),
      },
    })
    await new Promise(r => setTimeout(r, CLAIM_REFETCH_DELAY_MS))
    await yields.load()
  } catch (e) {
    const description = e instanceof WalletNotConnectedError
      ? 'Sign in with your passkey and try again'
      : e instanceof Error ? e.message : 'Unknown error'
    toast.error('Claim failed', { description })
  } finally {
    claimingIds.value.delete(recordId)
  }
}

function statusAccent(status: string): { label: string; text: string; ring: string; bg: string } {
  switch (status) {
    case 'claimed':
      return {
        label: 'Claimed',
        text: 'text-positive',
        ring: 'border-positive/30',
        bg: 'bg-positive/10',
      }
    case 'claimable':
      return {
        label: 'Claimable',
        text: 'text-positive',
        ring: 'border-positive/30',
        bg: 'bg-positive/10',
      }
    case 'pending':
      return {
        label: 'Pending',
        text: 'text-gold',
        ring: 'border-gold/30',
        bg: 'bg-gold/10',
      }
    default:
      return {
        label: status,
        text: 'text-cool',
        ring: 'border-haze dark:border-white/10',
        bg: 'bg-haze/30 dark:bg-white/5',
      }
  }
}
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading yields"
      caption="Reading distributions from chain"
    />

    <!-- Error -->
    <div v-else-if="yields.error" class="flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ yields.error }}</p>
      <MButton variant="outline" @click="yields.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-6">
      <!-- Top row: Claimable hero (8-col) + stats stack (4-col) -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- Claimable hero -->
        <section
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 100 } }"
          class="lg:col-span-8 relative overflow-hidden rounded-2xl
                 border border-haze dark:border-white/5
                 bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
                 shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
                 dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]
                 p-6 md:p-8"
        >
          <!-- Ambient bloom -->
          <div
            aria-hidden="true"
            class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none
                   bg-gold/10 dark:bg-signal/8"
          />

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-6">
              <div>
                <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                  Claimable Yields
                </h3>
                <p class="font-sans text-sm text-cool mt-1">
                  {{ yields.claimable.length > 0
                    ? 'Pending distributions ready for your wallet.'
                    : 'Nothing claimable right now — check back after the next distribution.' }}
                </p>
              </div>
              <div
                v-if="yields.claimable.length > 0"
                class="flex items-center gap-2 bg-positive/10
                       border border-positive/25
                       px-3.5 py-1.5 rounded-full flex-shrink-0"
              >
                <span
                  aria-hidden="true"
                  class="w-1.5 h-1.5 rounded-full bg-positive animate-pulse"
                />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-positive font-semibold">
                  {{ yields.claimable.length }} Claimable
                </span>
              </div>
            </div>

            <!-- Empty state -->
            <div
              v-if="yields.claimable.length === 0"
              class="flex flex-col items-center gap-3 py-8 text-center"
            >
              <div class="w-14 h-14 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 flex items-center justify-center">
                <CheckCircle2 :size="24" :stroke-width="1.6" class="text-cool/70" />
              </div>
              <p class="font-sans text-sm text-cool">All caught up.</p>
            </div>

            <!-- Claimable rows -->
            <div v-else class="space-y-3">
              <div
                v-for="c in yields.claimable"
                :key="c.id"
                data-testid="yields-claim-row"
                :data-record-id="c.id"
                class="flex items-center justify-between gap-4 p-4 md:p-5 rounded-xl
                       border border-haze dark:border-white/5 bg-mist/40 dark:bg-[#171717]
                       hover:border-gold/30 dark:hover:border-signal/25
                       transition-colors duration-300"
              >
                <div class="flex items-center gap-4 min-w-0 flex-1">
                  <div
                    :class="[
                      'w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0',
                      c.amount
                        ? 'bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal'
                        : 'bg-haze/60 dark:bg-white/5 text-cool',
                    ]"
                  >
                    <Coins v-if="c.amount" :size="18" :stroke-width="1.8" />
                    <Lock v-else :size="16" :stroke-width="1.8" />
                  </div>
                  <div class="min-w-0">
                    <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                      Distribution #{{ c.distribution_id }}
                    </p>
                    <p
                      v-if="c.amount"
                      class="font-accent italic text-xl text-midnight dark:text-white tabular-nums leading-tight mt-0.5"
                    >
                      {{ formatUSD(parseFloat(c.amount)) }}
                    </p>
                    <p
                      v-else
                      class="font-sans text-xs text-cool mt-0.5 flex items-center gap-1.5"
                    >
                      <Lock :size="11" :stroke-width="1.8" />
                      <span class="italic">Encrypted</span>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  :disabled="!c.escrow_id || claimingIds.has(c.id)"
                  data-testid="yields-claim-cta"
                  @click="claimYield(c.id, c.escrow_id)"
                  class="btn-gold-sweep px-6 py-2.5 rounded-lg font-sans font-semibold text-xs tracking-[0.18em] uppercase
                         flex items-center gap-2 cursor-pointer
                         transition-all duration-300 hover:-translate-y-0.5"
                >
                  <Loader2 v-if="claimingIds.has(c.id)" :size="13" class="animate-spin" />
                  <KeyRound v-else-if="!c.amount" :size="13" :stroke-width="2" />
                  <Coins v-else :size="13" :stroke-width="2" />
                  <span>{{ c.amount ? 'Claim' : 'Unlock & Claim' }}</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Stats stack -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 180 } }"
          class="lg:col-span-4 flex flex-col gap-4"
        >
          <div
            class="flex-1 relative overflow-hidden rounded-2xl p-5
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]"
          >
            <DollarSign
              aria-hidden="true"
              :size="48"
              :stroke-width="1"
              class="absolute top-4 right-4 text-gold/20 dark:text-signal/20"
            />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Total Earned</p>
            <p class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight">
              {{ formatUSD(yields.totalEarned) }}
            </p>
          </div>
          <div
            class="flex-1 relative overflow-hidden rounded-2xl p-5
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]"
          >
            <Clock
              aria-hidden="true"
              :size="44"
              :stroke-width="1"
              class="absolute top-4 right-4 text-gold/20 dark:text-signal/20"
            />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Pending</p>
            <p class="font-accent italic text-2xl md:text-3xl text-gold tabular-nums tracking-tight">
              {{ formatUSD(yields.totalPending) }}
            </p>
          </div>
          <div
            class="flex-1 relative overflow-hidden rounded-2xl p-5
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]"
          >
            <CalendarDays
              aria-hidden="true"
              :size="44"
              :stroke-width="1"
              class="absolute top-4 right-4 text-cool/25"
            />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Total Records</p>
            <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight">
              {{ yields.total }}
            </p>
          </div>
        </div>
      </div>

      <!-- Yield trend chart -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 240 } }"
        class="relative overflow-hidden rounded-2xl
               border border-haze dark:border-white/5
               bg-white dark:bg-[#171717]
               p-6 md:p-8"
      >
        <div class="flex items-start justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
              Yield Trend
            </h3>
            <p class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool mt-1.5">
              Cumulative rewards over time
            </p>
          </div>
          <div class="flex gap-1 bg-mist/60 dark:bg-[#0d0e10] border border-haze dark:border-white/5 rounded-lg p-1">
            <button
              v-for="r in ranges"
              :key="r.value"
              type="button"
              @click="activeRange = r.value"
              :data-testid="`yields-range-${r.value}`"
              :class="[
                'font-sans text-[10px] uppercase tracking-[0.22em] font-semibold px-5 py-1.5 rounded-md transition-all duration-200 cursor-pointer',
                activeRange === r.value
                  ? 'bg-haze/70 dark:bg-white/10 text-gold dark:text-signal shadow-[0_4px_12px_-4px_rgba(0,0,0,0.18)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)]'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              {{ r.label }}
            </button>
          </div>
        </div>
        <YieldLineChart :range="activeRange" />
      </section>

      <!-- History -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 300 } }"
        class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-6 md:p-8"
      >
        <div class="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
            History
          </h3>
          <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool flex items-center gap-2">
            <ShieldCheck :size="13" :stroke-width="1.8" class="text-compute/80 dark:text-signal/80" />
            <span>Secured by CoFHE · EIP-712</span>
          </p>
        </div>

        <!-- Empty -->
        <div v-if="yields.items.length === 0" class="flex flex-col items-center py-12 gap-3">
          <Inbox :size="36" :stroke-width="1.4" class="text-cool/35" />
          <p class="font-sans text-sm text-cool">No yield records yet</p>
        </div>

        <!-- Grid of history cards -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            v-for="(item, i) in yields.items"
            :key="item.id"
            v-motion
            :initial="{ opacity: 0, y: 12 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 380, delay: 320 + i * 60 } }"
            class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/20 dark:bg-white/[0.02]
                   p-5 flex flex-col justify-between gap-4
                   hover:border-gold/30 dark:hover:border-signal/25
                   transition-colors duration-300"
          >
            <div class="flex justify-between items-start gap-3">
              <div class="min-w-0">
                <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-2">
                  {{ new Date(item.created_at).toLocaleDateString() }}
                </p>
                <p class="font-sans text-sm font-semibold text-midnight dark:text-white mb-3">
                  Dist #{{ item.distribution_id }}
                </p>
                <span
                  :class="[
                    'inline-flex items-center font-sans text-[9px] uppercase tracking-[0.22em] font-semibold px-2 py-0.5 rounded border',
                    statusAccent(item.status).text,
                    statusAccent(item.status).ring,
                  ]"
                >
                  {{ statusAccent(item.status).label }}
                </span>
              </div>
              <div class="text-right">
                <p
                  v-if="item.amount"
                  class="font-accent italic text-xl text-midnight dark:text-white tabular-nums leading-tight"
                >
                  {{ formatUSD(parseFloat(item.amount)) }}
                </p>
                <p v-else class="font-sans text-xs text-cool flex items-center gap-1.5 justify-end">
                  <Lock :size="11" :stroke-width="1.8" />
                  <span class="italic">Encrypted</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>
