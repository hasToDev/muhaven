<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { YieldSnapshotClient, type EpochView } from '@muhaven/sdk'
import { useYieldsStore } from '@/stores/yields'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { useMarketplaceStore } from '@/stores/marketplace'
import * as EscrowService from '@/services/contracts/EscrowService'
import { WalletNotConnectedError } from '@/services/contracts/errors'
import { v35Addresses } from '@/contracts/addresses'
import { buildReadContext, buildWriteContext } from '@/services/v35/context'
import { arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import YieldLineChart from '@/components/charts/YieldLineChart.vue'
import {
  DollarSign, Clock, CalendarDays, Inbox, Lock, Coins, ShieldCheck,
  KeyRound, Loader2, CheckCircle2, AlertTriangle,
} from 'lucide-vue-next'

// YieldsPage — Wave 3.5 pull-based yield epochs (primary) + Wave 3 legacy
// yield records (secondary, for already-shipped Wave 3 distributions).
// Each Wave 3.5 epoch is enumerated per-token from the configured YieldSnapshot
// contracts and annotated with per-investor claimed state.

interface EpochEntry {
  snapshotAddress: Address
  tokenAddress: Address
  tokenSymbol: string
  tokenName: string
  epochId: bigint
  epoch: EpochView
  /** Encrypted per-investor snapshot balance; non-zero implies inclusion. */
  encSnapshotBalance: `0x${string}`
  claimed: boolean
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

const yields = useYieldsStore()
const { address, connected } = useWallet()
const { getEphemeralEOA } = useFhe()
const marketplace = useMarketplaceStore()

const epochs = ref<EpochEntry[]>([])
const epochLoading = ref(false)
const epochError = ref<string | null>(null)
const claimingKeys = ref<Set<string>>(new Set())

const activeRange = ref<'1m' | '3m' | '6m' | '1y'>('6m')
const ranges = [
  { label: '1M', value: '1m' as const },
  { label: '3M', value: '3m' as const },
  { label: '6M', value: '6m' as const },
  { label: '1Y', value: '1y' as const },
]

const CLAIM_REFETCH_DELAY_MS = 22_000
const ARBISCAN_TX_BASE = 'https://sepolia.arbiscan.io/tx/'

// ── Wave 3 legacy store ─────────────────────────────────────────────────

onMounted(async () => {
  if (!yields.loaded) await yields.load()
  if (!marketplace.loaded) await marketplace.load()
  if (connected.value) await loadEpochs()
})

const showLoader = computed(() =>
  !yields.loaded && !yields.error && yields.loading,
)

// ── Wave 3.5 epoch loader ───────────────────────────────────────────────

async function loadEpochs() {
  if (!connected.value || !address.value) return
  epochLoading.value = true
  epochError.value = null
  try {
    const user = address.value as Address
    const snapshotEntries = Object.entries(v35Addresses.yieldSnapshots)
    if (snapshotEntries.length === 0) {
      epochs.value = []
      return
    }

    const readCtx = buildReadContext()
    const collected: EpochEntry[] = []

    for (const [tokenAddrLower, snapshotAddr] of snapshotEntries) {
      const tokenMeta = marketplace.getByAddress(tokenAddrLower)
      const tokenSymbol = tokenMeta?.symbol ?? tokenAddrLower.slice(0, 8)
      const tokenName = tokenMeta?.name ?? 'Unknown token'

      const snapshot = new YieldSnapshotClient(readCtx, snapshotAddr)
      const token = tokenAddrLower as Address
      const currentEpoch = await snapshot.getCurrentEpoch(token)

      // Walk from 1..currentEpoch (inclusive). Epoch 0 is unused. Users can't
      // be part of more than `currentEpoch` epochs per token — keeps the read
      // budget bounded. If we grow past a few dozen, switch to event-indexing.
      for (let i = 1n; i <= currentEpoch; i++) {
        const encSnapshotBalance = await snapshot.getSnapshotBalance(i, user)
        // Zero handle means "not snapshotted for this epoch" — skip.
        if (encSnapshotBalance === ZERO_BYTES32) continue

        const [epoch, claimed] = await Promise.all([
          snapshot.getEpoch(i),
          snapshot.hasClaimed(i, user),
        ])
        collected.push({
          snapshotAddress: snapshotAddr,
          tokenAddress: token,
          tokenSymbol,
          tokenName,
          epochId: i,
          epoch,
          encSnapshotBalance,
          claimed,
        })
      }
    }
    collected.sort((a, b) => (b.epochId > a.epochId ? 1 : -1))
    epochs.value = collected
  } catch (e) {
    epochError.value = e instanceof Error ? e.message : 'Failed to load epochs'
  } finally {
    epochLoading.value = false
  }
}

const unclaimedCount = computed(() =>
  epochs.value.filter(e => !e.claimed && e.epoch.funded).length,
)

// ── Claim yield ─────────────────────────────────────────────────────────

async function claimEpoch(entry: EpochEntry) {
  const key = `${entry.snapshotAddress}:${entry.epochId}`
  if (claimingKeys.value.has(key)) return
  if (entry.claimed || !entry.epoch.funded) return

  claimingKeys.value.add(key)
  try {
    const ctx = await buildWriteContext()
    const client = new YieldSnapshotClient(ctx, entry.snapshotAddress)
    const ephemeralEOA = getEphemeralEOA()
    const hash = await client.claimYield(entry.epochId, ephemeralEOA)
    toast.success('Yield claim submitted', {
      description: `tx ${hash.slice(0, 10)}…`,
      action: {
        label: 'View',
        onClick: () => window.open(arbiscanTx(hash), '_blank', 'noopener'),
      },
    })
    // Re-read the epoch's claimed state + snapshot balance post-tx.
    await loadEpochs()
  } catch (e) {
    toast.error('Claim failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    claimingKeys.value.delete(key)
  }
}

// Per-epoch share decrypt is intentionally omitted. The claimed amount
// (`encShare128` in YieldSnapshot.claimYield) is ephemeral — emitted as an
// event param would reveal the claim size; stored in a view would gate on
// a re-grant path. Instead the UI directs the investor to read their PUSDC
// balance, which already aggregates every claim.

// ── Wave 3 legacy claim (unchanged) ─────────────────────────────────────

async function claimLegacy(recordId: string, escrowId: string | null) {
  if (claimingKeys.value.has(recordId)) return

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

  claimingKeys.value.add(recordId)
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
    claimingKeys.value.delete(recordId)
  }
}

function statusAccent(status: string) {
  switch (status) {
    case 'claimed': return { label: 'Claimed', text: 'text-positive', ring: 'border-positive/30' }
    case 'claimable': return { label: 'Claimable', text: 'text-positive', ring: 'border-positive/30' }
    case 'pending': return { label: 'Pending', text: 'text-gold', ring: 'border-gold/30' }
    default: return { label: status, text: 'text-cool', ring: 'border-haze dark:border-white/10' }
  }
}

</script>

<template>
  <div>
    <MPageLoader v-if="showLoader" label="Loading yields" caption="Reading distributions from chain" />

    <div v-else-if="yields.error" class="flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ yields.error }}</p>
      <MButton variant="outline" @click="yields.load()">Retry</MButton>
    </div>

    <div v-else class="flex flex-col gap-6">
      <!-- Top: Wave 3.5 claimable epochs + stats -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
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
          <div aria-hidden="true"
               class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none bg-gold/10 dark:bg-signal/8" />

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-6">
              <div>
                <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                  Yield Epochs
                </h3>
                <p class="font-sans text-sm text-cool mt-1">
                  {{ unclaimedCount > 0
                    ? 'Funded epochs ready to claim — pull-based per ADR-005.'
                    : 'No unclaimed funded epochs right now.' }}
                </p>
              </div>
              <div
                v-if="unclaimedCount > 0"
                class="flex items-center gap-2 bg-positive/10 border border-positive/25 px-3.5 py-1.5 rounded-full flex-shrink-0"
              >
                <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-positive font-semibold">
                  {{ unclaimedCount }} Claimable
                </span>
              </div>
            </div>

            <div v-if="epochLoading && epochs.length === 0" class="py-8 flex items-center justify-center">
              <Loader2 :size="20" class="animate-spin text-cool" />
            </div>

            <div v-else-if="epochError" class="flex items-start gap-3 p-4 rounded-xl border border-negative/25 bg-negative/5">
              <AlertTriangle :size="16" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
              <p class="font-sans text-[12px] text-cool leading-relaxed">{{ epochError }}</p>
            </div>

            <div v-else-if="epochs.length === 0" class="flex flex-col items-center gap-3 py-8 text-center">
              <div class="w-14 h-14 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 flex items-center justify-center">
                <CheckCircle2 :size="24" :stroke-width="1.6" class="text-cool/70" />
              </div>
              <p class="font-sans text-sm text-cool">All caught up.</p>
              <p class="font-sans text-[11px] text-cool/70 max-w-sm">
                Once the issuer opens a new epoch + snapshots + funds it, you'll see it here.
              </p>
            </div>

            <div v-else class="space-y-3">
              <div
                v-for="e in epochs"
                :key="`${e.snapshotAddress}:${e.epochId}`"
                data-testid="epoch-row"
                :data-epoch-id="String(e.epochId)"
                class="flex items-center justify-between gap-4 p-4 md:p-5 rounded-xl
                       border border-haze dark:border-white/5 bg-mist/40 dark:bg-[#171717]
                       hover:border-gold/30 dark:hover:border-signal/25 transition-colors duration-300"
              >
                <div class="flex items-center gap-4 min-w-0 flex-1">
                  <div
                    :class="[
                      'w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0',
                      e.claimed ? 'bg-compute/15 dark:bg-signal/15 text-compute dark:text-signal'
                        : e.epoch.funded ? 'bg-positive/15 text-positive'
                          : 'bg-gold/15 dark:bg-signal/15 text-gold dark:text-signal',
                    ]"
                  >
                    <Coins v-if="e.claimed" :size="18" :stroke-width="1.8" />
                    <CheckCircle2 v-else-if="e.epoch.funded" :size="18" :stroke-width="1.8" />
                    <Clock v-else :size="18" :stroke-width="1.8" />
                  </div>
                  <div class="min-w-0">
                    <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                      Epoch #{{ e.epochId }} · {{ e.tokenSymbol }}
                    </p>
                    <p class="font-sans text-[11px] text-cool mt-0.5">
                      {{ e.tokenName }}
                      · {{ e.claimed ? 'claimed — PUSDC credited' : e.epoch.funded ? 'ready to claim' : 'awaiting funding' }}
                    </p>
                    <p v-if="e.claimed" class="font-sans text-[11px] text-cool/70 mt-1 italic">
                      Payout landed in your PUSDC balance. The per-epoch amount is not
                      stored on-chain — view your PUSDC balance on Portfolio.
                    </p>
                  </div>
                </div>
                <button
                  v-if="!e.claimed && e.epoch.funded"
                  type="button"
                  @click="claimEpoch(e)"
                  :disabled="claimingKeys.has(`${e.snapshotAddress}:${e.epochId}`)"
                  data-testid="epoch-claim-cta"
                  class="btn-gold-sweep px-6 py-2.5 rounded-lg font-sans font-semibold text-xs tracking-[0.18em] uppercase
                         flex items-center gap-2 cursor-pointer transition-all duration-300 hover:-translate-y-0.5"
                >
                  <Loader2
                    v-if="claimingKeys.has(`${e.snapshotAddress}:${e.epochId}`)"
                    :size="13"
                    class="animate-spin"
                  />
                  <KeyRound v-else :size="13" :stroke-width="2" />
                  <span>Claim</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <div
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 180 } }"
          class="lg:col-span-4 flex flex-col gap-4"
        >
          <div class="flex-1 relative overflow-hidden rounded-2xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
            <DollarSign aria-hidden="true" :size="48" :stroke-width="1" class="absolute top-4 right-4 text-gold/20 dark:text-signal/20" />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Total Earned (legacy)</p>
            <p class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight">
              {{ formatUSD(yields.totalEarned) }}
            </p>
          </div>
          <div class="flex-1 relative overflow-hidden rounded-2xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
            <Clock aria-hidden="true" :size="44" :stroke-width="1" class="absolute top-4 right-4 text-gold/20 dark:text-signal/20" />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Pending (legacy)</p>
            <p class="font-accent italic text-2xl md:text-3xl text-gold tabular-nums tracking-tight">
              {{ formatUSD(yields.totalPending) }}
            </p>
          </div>
          <div class="flex-1 relative overflow-hidden rounded-2xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]">
            <CalendarDays aria-hidden="true" :size="44" :stroke-width="1" class="absolute top-4 right-4 text-cool/25" />
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool mb-1.5">Epochs Tracked</p>
            <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight">
              {{ epochs.length }}
            </p>
          </div>
        </div>
      </div>

      <!-- Yield trend chart -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 240 } }"
        class="relative overflow-hidden rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-6 md:p-8"
      >
        <div class="flex items-start justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">Yield Trend</h3>
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

      <!-- Legacy history (Wave 3) -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 300 } }"
        class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-6 md:p-8"
      >
        <div class="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
              Legacy Distributions
            </h3>
            <p class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool mt-1.5">
              Wave 3 yield records — kept for back-compat, read-only
            </p>
          </div>
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
                   hover:border-gold/30 dark:hover:border-signal/25 transition-colors duration-300"
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
            <button
              v-if="item.status === 'claimable' && item.escrow_id"
              type="button"
              @click="claimLegacy(item.id, item.escrow_id)"
              :disabled="claimingKeys.has(item.id)"
              data-testid="legacy-claim-cta"
              class="btn-gold-sweep px-4 py-2 rounded-lg font-sans font-semibold text-[10px] tracking-[0.18em] uppercase
                     flex items-center justify-center gap-2 cursor-pointer transition-all duration-300 hover:-translate-y-0.5"
            >
              <Loader2 v-if="claimingKeys.has(item.id)" :size="11" class="animate-spin" />
              <KeyRound v-else :size="11" />
              Claim
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
