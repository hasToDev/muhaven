<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Address } from 'viem'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { usePortfolioStore } from '@/stores/portfolio'
import { useWallet } from '@/composables/useWallet'
import * as SnapshotService from '@/services/v35/SnapshotService'
import { formatUSD } from '@/lib/utils'
import {
  AlertTriangle, ArrowRight, Coins, ShieldCheck, Lock, Loader2, Eye,
  Landmark,
} from 'lucide-vue-next'

/**
 * Issuer-side context block for /cash. Surfaces the connection between
 * cash held + epochs in flight: "Next epoch on TBILL1 is awaiting funds.
 * You have $Y. Click to autofill the convert form with a top-up amount."
 *
 * Renders only when role==='issuer' on /cash. The wrap engine on /cash
 * itself stays unchanged — this card is read-only context plus a small
 * amount-autofill affordance via the `autofill` event.
 *
 * mhUSDC balance is sourced from the shared `usePortfolioStore` so a
 * Reveal click here reveals the right-aside cockpit tile too (and vice
 * versa). Avoids the dual-Reveal-button confusion the user saw on the
 * first issuer-side smoke pass.
 */

const emit = defineEmits<{
  (e: 'autofill', amountString: string): void
}>()

const tokenStore = useIssuerTokensStore()
const portfolio = usePortfolioStore()
const { address } = useWallet()

interface InFlightEpoch {
  tokenAddress: Address
  tokenSymbol: string
  epochId: bigint
  finalized: boolean
  funded: boolean
}

const inFlightEpochs = ref<InFlightEpoch[]>([])
const loading = ref(false)

// ── Loaders ────────────────────────────────────────────────────────────

async function loadInFlight() {
  if (tokenStore.tokens.length === 0) return
  loading.value = true
  try {
    const issuerTokens = tokenStore.tokens
      .filter(t => t.status === 'active')
      .map(t => t.address as Address)
    const results = await Promise.allSettled(
      issuerTokens.map(t => SnapshotService.detectInFlight(t)),
    )
    const collected: InFlightEpoch[] = []
    results.forEach((r, idx) => {
      if (r.status !== 'fulfilled' || !r.value) return
      const t = tokenStore.tokens.find(
        x => x.address.toLowerCase() === issuerTokens[idx].toLowerCase(),
      )
      // Only surface unfunded epochs — funded ones are already paid.
      if (r.value.epoch.funded) return
      collected.push({
        tokenAddress: r.value.tokenAddress,
        tokenSymbol: t?.symbol ?? r.value.tokenAddress.slice(0, 8),
        epochId: r.value.epochId,
        finalized: r.value.epoch.finalized,
        funded: r.value.epoch.funded,
      })
    })
    inFlightEpochs.value = collected
  } catch {
    // Non-blocking — empty card is acceptable.
  } finally {
    loading.value = false
  }
}

async function decryptMhUsdc() {
  if (!address.value || portfolio.pusdcDecrypting) return
  // Routes through the shared portfolio store so the right-aside
  // cockpit's mhUSDC tile reveals at the same time. Single source of
  // truth — one Reveal click, both surfaces light up.
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

// ── Display ────────────────────────────────────────────────────────────

const hasInFlight = computed(() => inFlightEpochs.value.length > 0)

const balanceLabel = computed(() => {
  if (portfolio.pusdcConfidentialBalance === null) return null
  return formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6)
})

function autofillForFunding() {
  // Generic top-up suggestion. Per-epoch totalYield is encrypted, so we
  // can't compute a precise shortfall here. Issuer edits before
  // submitting on the convert form below.
  emit('autofill', '100')
}

// ── Lifecycle ──────────────────────────────────────────────────────────

onMounted(() => {
  if (tokenStore.loaded) {
    loadInFlight()
  }
})

// React to issuer-tokens loading post-mount.
watch(() => tokenStore.loaded, (loaded) => {
  if (loaded) loadInFlight()
})
</script>

<template>
  <section
    data-testid="issuer-cash-context"
    class="relative overflow-hidden rounded-2xl
           border border-haze dark:border-white/5
           bg-white dark:bg-[#171717]
           p-5 md:p-6"
  >
    <div
      aria-hidden="true"
      class="absolute -top-16 -right-16 w-44 h-44 rounded-full blur-[70px] pointer-events-none
             bg-gold/8 dark:bg-signal/8"
    />

    <div class="relative z-10 flex flex-col gap-4">
      <!-- Header — always visible -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 rounded-full bg-gold/12 dark:bg-signal/12 border border-gold/25 dark:border-signal/25 flex items-center justify-center flex-shrink-0">
            <Coins :size="18" :stroke-width="1.6" class="text-compute dark:text-signal" />
          </div>
          <div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
              Operating cash · for distributions
            </p>
            <p class="font-accent italic text-2xl text-midnight dark:text-white tracking-tight mt-0.5 min-h-[2rem] flex items-center gap-2">
              <template v-if="balanceLabel !== null">
                {{ balanceLabel }}
                <ShieldCheck :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
              </template>
              <span v-else class="inline-flex items-center gap-2 text-cool/60">
                <Lock :size="14" :stroke-width="1.8" />
                <span class="font-sans not-italic text-sm tracking-tight">$••••.••</span>
              </span>
            </p>
          </div>
        </div>
        <button
          v-if="portfolio.pusdcConfidentialBalance === null"
          type="button"
          @click="decryptMhUsdc"
          :disabled="portfolio.pusdcDecrypting"
          data-testid="issuer-cash-context-reveal"
          class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                 text-compute dark:text-signal
                 border border-compute/30 dark:border-signal/30
                 hover:text-white dark:hover:text-[#412d00]
                 hover:bg-compute dark:hover:bg-signal
                 px-4 py-2 rounded transition-all duration-200 cursor-pointer
                 disabled:opacity-60 disabled:cursor-wait"
        >
          <Loader2 v-if="portfolio.pusdcDecrypting" :size="11" class="animate-spin" />
          <Eye v-else :size="11" :stroke-width="2" />
          {{ portfolio.pusdcDecrypting ? 'Decrypting…' : 'Reveal' }}
        </button>
      </div>

      <!-- In-flight epoch list -->
      <div v-if="loading && !hasInFlight" class="flex items-center gap-2 px-3 py-2 rounded-lg bg-mist/40 dark:bg-white/[0.02]">
        <Loader2 :size="13" class="animate-spin text-cool" />
        <span class="font-sans text-[11px] text-cool">Reading in-flight epochs…</span>
      </div>

      <div
        v-else-if="hasInFlight"
        data-testid="issuer-cash-context-inflight"
        class="flex flex-col gap-2"
      >
        <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
          In-flight epochs · ready to fund
        </p>
        <div
          v-for="e in inFlightEpochs"
          :key="`${e.tokenAddress}:${e.epochId}`"
          class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg
                 bg-gold/8 dark:bg-signal/8 border border-gold/25 dark:border-signal/25"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <AlertTriangle :size="13" :stroke-width="1.8" class="text-gold dark:text-signal flex-shrink-0" />
            <div class="min-w-0">
              <p class="font-sans text-[12px] font-semibold text-midnight dark:text-white">
                Epoch #{{ e.epochId }} · {{ e.tokenSymbol }}
              </p>
              <p class="font-sans text-[10px] text-cool mt-0.5">
                {{ e.finalized ? 'awaiting funds' : 'snapshotting' }}
              </p>
            </div>
          </div>
          <button
            type="button"
            @click="autofillForFunding"
            data-testid="issuer-cash-context-autofill"
            class="inline-flex items-center gap-1 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold text-compute dark:text-signal hover:underline cursor-pointer"
          >
            Top up
            <ArrowRight :size="11" :stroke-width="2" />
          </button>
        </div>
      </div>

      <div
        v-else-if="!loading"
        class="flex items-center gap-2 px-3 py-2 rounded-lg bg-mist/30 dark:bg-white/[0.02] border border-haze dark:border-white/5"
      >
        <Landmark :size="13" :stroke-width="1.8" class="text-cool flex-shrink-0" />
        <span class="font-sans text-[11px] text-cool leading-relaxed">
          No epochs in flight. Convert USDC → mhUSDC to keep cash on hand for the next distribution.
        </span>
      </div>
    </div>
  </section>
</template>
