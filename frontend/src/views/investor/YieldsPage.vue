<script setup lang="ts">
import { nextTick, ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { YieldSnapshotClient } from '@muhaven/sdk'
import { useEpochsStore, type EpochEntry } from '@/stores/epochs'
import { usePortfolioStore } from '@/stores/portfolio'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { useMarketplaceStore } from '@/stores/marketplace'
import { buildWriteContext } from '@/services/v35/context'
import { arbiscanTx } from '@/lib/external'
import { resolveTokenIdentifier } from '@/lib/prefill'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import NavTrendChart from '@/components/charts/NavTrendChart.vue'
import {
  Clock, Inbox, Coins, KeyRound, Loader2, CheckCircle2,
  AlertTriangle, Lock, ShieldCheck, TrendingUp,
} from 'lucide-vue-next'

// YieldsPage — Wave 3.5 pull-based yield epochs (sole source). Wave 3
// `yield_records` + push-based escrow surfaces were dropped this phase
// (Option C single-source — same shape as /activity). Per-investor yield
// amounts are FHE-encrypted; the page surfaces (1) which epochs are
// claimable, (2) a per-token NAV trend (asset-side, plaintext) so users
// can verify the underlying is tracking real-world data.

const epochsStore = useEpochsStore()
const portfolioStore = usePortfolioStore()
const { address, connected } = useWallet()
const { getEphemeralEOA } = useFhe()
const marketplace = useMarketplaceStore()
const route = useRoute()

/**
 * Path C deep-link target (`?token=<sym|addr>&epoch=<n>`). When set, the
 * epoch row with matching `(snapshotAddress, epochId)` gets a gold ring
 * + smooth-scroll into view on first render. The user still clicks
 * Claim manually — the highlight is purely a "the LLM pointed you here"
 * affordance.
 *
 * We resolve the token address from a symbol via the marketplace store
 * so `@muhaven/mcp position.claim({ token: 'TBILL1' })` works without
 * forcing the LLM to look up the contract first.
 *
 * `null` when there's no deep-link target — every row renders un-
 * highlighted. The page already auto-loads + lists every claimable
 * epoch independently of this; the deep-link is opt-in convenience.
 */
const highlightedTokenAddr = ref<string | null>(null)
const highlightedEpochId = ref<string | null>(null)

/**
 * Surfaces a deep-link banner when `?token=X` didn't resolve (Frontend
 * H-1 / Code Reviewer L2). The page already shows every claimable
 * epoch in the user's wallet, so a silent miss is less damaging here
 * than on TradePage — but explicitly attributing the failure ("your
 * assistant referenced a token we don't recognise") keeps the user
 * from wondering why no epoch got highlighted.
 */
const prefillTokenMissError = ref<string | null>(null)

/**
 * Track whether the one-shot deep-link scroll already fired so a
 * second epochsStore.load (e.g. wallet swap) doesn't re-scroll the
 * page. Set to true after the first successful scrollIntoView.
 */
const scrolledToHighlight = ref<boolean>(false)

// Hoisted BEFORE onMounted (and BEFORE the `selectableTokens` watcher
// registration further down) so a synchronous deep-link assignment in
// onMounted lands before the immediate:true watcher's first run sees
// `null` and snaps to `list[0]` — Frontend H-5 race fix.
const selectedToken = ref<Address | null>(null)

const claimingKeys = ref<Set<string>>(new Set())
const activeRange = ref<'1m' | '3m' | '6m' | '1y'>('6m')
const ranges = [
  { label: '1M', value: '1m' as const },
  { label: '3M', value: '3m' as const },
  { label: '6M', value: '6m' as const },
  { label: '1Y', value: '1y' as const },
] as const

// ── Lifecycle ───────────────────────────────────────────────────────────

onMounted(async () => {
  if (!marketplace.loaded) {
    try {
      await marketplace.load()
    } catch (err) {
      console.warn('[YieldsPage] marketplace.load failed:', err)
      // Continue — symbol resolution will report a token-miss banner
      // when the marketplace list is empty.
    }
  }

  // Path C deep-link parse — done BEFORE any other awaits so the
  // `selectableTokens` watcher registered below sees `selectedToken`
  // already set on its immediate:true first run. Without this ordering,
  // the watcher would snap selectedToken to `list[0]` and the
  // deep-link's token assignment would race-overwrite that — producing
  // a momentary flash of the wrong token in the NAV chart (Frontend H-5).
  const queryToken = route.query.token as string | undefined
  const matched = resolveTokenIdentifier(queryToken, marketplace.tokens)
  if (queryToken && !matched) {
    prefillTokenMissError.value = queryToken.trim().slice(0, 32)
  } else if (matched) {
    highlightedTokenAddr.value = matched.address.toLowerCase()
    selectedToken.value = matched.address as Address
  }
  const queryEpoch = route.query.epoch as string | undefined
  if (queryEpoch && /^\d+$/.test(queryEpoch)) {
    highlightedEpochId.value = queryEpoch
  }

  // Epochs load happens AFTER deep-link parse so the watch below that
  // owns the scroll-into-view sees a populated `epochsStore.items`
  // when it first fires.
  if (connected.value && address.value) {
    if (!epochsStore.loaded || epochsStore.lastLoadedFor?.toLowerCase() !== address.value.toLowerCase()) {
      await epochsStore.load(address.value as Address)
    }
  }
})

/**
 * Smooth-scroll to the highlighted epoch row when:
 *  (a) both deep-link refs are set,
 *  (b) `epochsStore.items` has the matching row rendered, AND
 *  (c) we haven't already scrolled in this page lifetime.
 *
 * Watching `epochsStore.items.length` handles three races the previous
 * one-shot `await nextTick(); querySelector(...)` in onMounted missed:
 *   - User lands disconnected (no epochsStore.load fires in onMounted).
 *     Wallet hydrates 200-800ms later → the address watcher below fires
 *     epochsStore.load → items.length transitions 0→N → this watch
 *     fires AT THAT MOMENT, not at mount time.
 *   - User lands with a cached epochsStore from a prior nav. items
 *     populates synchronously on `selectableTokens` recompute → this
 *     watch's `immediate: true` first run sees the matching row + scrolls.
 *   - Reactive `data-highlighted` template binding waits one extra tick
 *     to flush. nextTick after the watch fire gives Vue time to render
 *     the attribute before querySelector runs.
 */
watch(
  () => [epochsStore.items.length, highlightedTokenAddr.value, highlightedEpochId.value] as const,
  async ([itemsLen, tokenAddr, epochId]) => {
    if (scrolledToHighlight.value) return
    if (!tokenAddr || !epochId || itemsLen === 0) return
    await nextTick()
    const el = document.querySelector<HTMLElement>(
      '[data-testid="epoch-row"][data-highlighted="true"]',
    )
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      scrolledToHighlight.value = true
    }
  },
  { immediate: true },
)

// React to wallet swaps after mount.
watch(() => address.value, async (next) => {
  if (next) {
    await epochsStore.load(next as Address)
  } else {
    epochsStore.reset()
  }
})

const showLoader = computed(() =>
  !epochsStore.loaded && !epochsStore.error && epochsStore.loading,
)

// ── NAV chart token selection ───────────────────────────────────────────

// Selector tokens = those for which the user has at least one snapshot.
// On /yields we anchor the asset trend on epoch activity rather than
// portfolio holdings — the page is about claim activity, not allocation.
//
// `selectedToken` declaration was hoisted above onMounted so the deep-
// link path can set it synchronously before this watcher's immediate
// first run sees `null` and snaps to `list[0]` (Frontend H-5 race fix).
const selectableTokens = computed(() => epochsStore.tokensWithEpochs)

watch(selectableTokens, (list) => {
  if (list.length === 0) {
    selectedToken.value = null
    return
  }
  // Keep the current selection if it's still in the list; otherwise pick
  // the first (most-recent epoch's token by store sort order).
  if (
    !selectedToken.value
    || !list.some(t => t.address.toLowerCase() === selectedToken.value!.toLowerCase())
  ) {
    selectedToken.value = list[0].address
  }
}, { immediate: true })

// ── Claim ──────────────────────────────────────────────────────────────

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
    if (address.value) {
      // ONLY await epochsStore.load — the row's "claimed" state must
      // resolve synchronously so the row collapses + the row's per-key
      // claim spinner can clear in `finally`. The portfolio refresh is
      // fire-and-forget: the cofhe TN sealOutput indexer can be slow on
      // post-claim handles (chain-length pathology — see
      // `project_cofhe_tn_chain_length_cap`), and awaiting a
      // 30-45s decrypt blocks the row's claim spinner needlessly. The
      // user navigates to /portfolio when they're ready; the spinner
      // there manages its own decrypt state.
      const addr = address.value as `0x${string}`
      const wasRevealed = portfolioStore.pusdcConfidentialBalance !== null
      await epochsStore.load(addr as Address)
      void portfolioStore.load(addr)
        .then(() => wasRevealed ? portfolioStore.decryptPusdc(addr) : null)
        .catch((e) => {
          console.warn('[YieldsPage] post-claim portfolio refresh failed', e)
        })
    }
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
// a re-grant path. Instead, payouts aggregate into the investor's mhUSDC
// balance, surfaced on /portfolio.
</script>

<template>
  <div>
    <MPageLoader v-if="showLoader" label="Loading yields" caption="Reading distributions from chain" />

    <!-- Cold-error: no items ever loaded. Reload-failures fall through to
         the soft-error strip at the bottom so previously-loaded rows stay
         on screen. -->
    <div
      v-else-if="epochsStore.error && epochsStore.items.length === 0"
      class="flex flex-col items-center justify-center py-20 gap-4"
    >
      <p class="text-base text-cool">{{ epochsStore.error }}</p>
      <MButton
        variant="outline"
        @click="address && epochsStore.load(address as Address)"
      >Retry</MButton>
    </div>

    <div v-else class="flex flex-col gap-6">
      <!-- Path C deep-link miss banner — renders when ?token=X didn't
           resolve. Frontend H-1 / Code Reviewer L2 fix: explicitly
           attribute the failure to the user's assistant instead of
           silently rendering no highlight. -->
      <div
        v-if="prefillTokenMissError"
        data-testid="yields-prefill-token-miss"
        role="alert"
        class="flex items-start gap-3 px-4 py-3 rounded-xl
               bg-gold/8 dark:bg-signal/8 border border-gold/25 dark:border-signal/25"
      >
        <AlertTriangle :size="16" :stroke-width="1.8" class="text-compute dark:text-signal flex-shrink-0 mt-0.5" />
        <div class="flex-1 min-w-0">
          <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
            Couldn't find token <span class="font-mono">{{ prefillTokenMissError }}</span> in your catalog.
          </p>
          <p class="font-sans text-xs text-cool mt-1">
            The link from your assistant referenced a token we don't recognise. Your full claimable list is below — pick the epoch you want to claim.
          </p>
        </div>
      </div>

      <!-- Privacy proof hero strip -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460, delay: 60 } }"
        data-testid="yields-privacy-proof"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-gradient-to-br from-mist/60 via-white/40 to-haze/30
               dark:from-[#171717]/60 dark:via-[#1c1b1b]/60 dark:to-[#171717]/60
               backdrop-blur-md p-5 md:p-6"
      >
        <div class="flex items-start gap-4">
          <div class="flex items-center gap-2 flex-shrink-0">
            <div class="w-9 h-9 rounded-full bg-gold/12 dark:bg-signal/12 flex items-center justify-center">
              <ShieldCheck :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
            </div>
            <div class="hidden md:flex items-center gap-2 text-cool/60">
              <span class="font-sans text-xs">·</span>
              <Lock :size="13" :stroke-width="1.8" class="text-cool" />
              <span class="font-sans text-xs">·</span>
              <KeyRound :size="13" :stroke-width="1.8" class="text-gold dark:text-signal" />
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-1">
              How yield works here
            </p>
            <p class="font-sans text-[13px] leading-relaxed text-midnight/80 dark:text-white/80">
              Each epoch credits your encrypted
              <span class="font-mono text-compute dark:text-signal">mhUSDC</span> balance
              when you claim — the per-claim amount is never stored on-chain.
              To verify a payout landed, check your mhUSDC balance on
              <span class="font-mono text-midnight dark:text-white">/portfolio</span>.
            </p>
          </div>
        </div>
      </section>

      <!-- Yield Epochs panel -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
        class="relative overflow-hidden rounded-2xl
               border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]
               p-6 md:p-8"
      >
        <div aria-hidden="true"
             class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none bg-gold/10 dark:bg-signal/8" />

        <div class="relative z-10">
          <div class="flex items-start justify-between gap-4 mb-6 flex-wrap">
            <div class="min-w-0">
              <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Yield Epochs
              </h3>
              <p class="font-sans text-sm text-cool mt-1">
                {{ epochsStore.unclaimedCount > 0
                  ? 'Funded epochs ready to claim — pull-based per ADR-005.'
                  : 'No unclaimed funded epochs right now.' }}
              </p>
            </div>
            <div
              v-if="epochsStore.items.length > 0"
              data-testid="yields-meta-strip"
              class="flex items-center gap-2 flex-wrap font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold"
            >
              <span data-testid="yields-meta-tracked">
                {{ epochsStore.items.length }} Tracked
              </span>
              <span aria-hidden="true" class="text-cool/40">·</span>
              <span data-testid="yields-meta-tokens">
                {{ epochsStore.tokensTracked }} {{ epochsStore.tokensTracked === 1 ? 'Token' : 'Tokens' }}
              </span>
              <template v-if="epochsStore.unclaimedCount > 0">
                <span aria-hidden="true" class="text-cool/40">·</span>
                <span
                  data-testid="yields-meta-claimable"
                  class="flex items-center gap-1.5 bg-positive/10 border border-positive/25 px-2.5 py-1 rounded-full text-positive"
                >
                  <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />
                  {{ epochsStore.unclaimedCount }} Claimable
                </span>
              </template>
            </div>
          </div>

          <div v-if="epochsStore.loading && epochsStore.items.length === 0" class="py-8 flex items-center justify-center">
            <Loader2 :size="20" class="animate-spin text-cool" />
          </div>

          <div v-else-if="epochsStore.items.length === 0" class="flex flex-col items-center gap-3 py-10 text-center">
            <div class="w-14 h-14 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 flex items-center justify-center">
              <Inbox :size="24" :stroke-width="1.4" class="text-cool/70" />
            </div>
            <p class="font-sans text-sm text-cool">No epochs yet.</p>
            <p class="font-sans text-[11px] text-cool/70 max-w-sm">
              When an issuer opens an epoch and funds it, you'll see a claim row here.
              Holdings on
              <span class="font-mono text-midnight dark:text-white">/portfolio</span>
              accrue value via NAV; epochs are how that value gets paid out as
              <span class="font-mono text-compute dark:text-signal">mhUSDC</span>.
            </p>
          </div>

          <div v-else class="space-y-3 max-h-[640px] overflow-y-auto pr-1">
            <div
              v-for="e in epochsStore.items"
              :key="`${e.snapshotAddress}:${e.epochId}`"
              data-testid="epoch-row"
              :data-epoch-id="String(e.epochId)"
              :data-token-address="e.tokenAddress.toLowerCase()"
              :data-highlighted="(
                highlightedTokenAddr === e.tokenAddress.toLowerCase()
                && highlightedEpochId === String(e.epochId)
              ) ? 'true' : 'false'"
              :class="[
                'flex items-center justify-between gap-4 p-4 md:p-5 rounded-xl',
                'border bg-mist/40 dark:bg-[#171717]',
                'transition-colors duration-300',
                highlightedTokenAddr === e.tokenAddress.toLowerCase()
                  && highlightedEpochId === String(e.epochId)
                  ? 'border-gold ring-2 ring-gold/40 dark:border-signal dark:ring-signal/40 shadow-[0_0_24px_-4px_rgba(255,186,32,0.45)] dark:shadow-[0_0_24px_-4px_rgba(255,220,161,0.35)]'
                  : 'border-haze dark:border-white/5 hover:border-gold/30 dark:hover:border-signal/25',
              ]"
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
                    · {{ e.claimed ? 'claimed — credited to mhUSDC' : e.epoch.funded ? 'ready to claim' : 'awaiting funding' }}
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

      <!-- NAV Trend panel -->
      <section
        v-if="selectableTokens.length > 0 && selectedToken"
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 200 } }"
        data-testid="yields-nav-trend-panel"
        class="relative overflow-hidden rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-6 md:p-8"
      >
        <div aria-hidden="true"
             class="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-[80px] pointer-events-none bg-compute/5 dark:bg-signal/5" />

        <div class="relative z-10">
          <div class="flex items-start justify-between gap-4 mb-5 flex-wrap">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <TrendingUp :size="18" :stroke-width="1.6" class="text-compute dark:text-signal" />
                <h3 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                  NAV Trend
                </h3>
              </div>
              <p class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool mt-1.5">
                Per-token net asset value · public oracle data
              </p>
            </div>
            <div
              class="flex gap-1 bg-mist/60 dark:bg-[#0d0e10] border border-haze dark:border-white/5 rounded-lg p-1"
            >
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

          <!-- Token selector pill row (only when >1 token to choose from) -->
          <div
            v-if="selectableTokens.length > 1"
            data-testid="yields-token-selector"
            class="flex gap-1 bg-mist/60 dark:bg-[#0d0e10] border border-haze dark:border-white/5 rounded-lg p-1 mb-4 w-fit max-w-full overflow-x-auto"
          >
            <button
              v-for="t in selectableTokens"
              :key="t.address"
              type="button"
              @click="selectedToken = t.address"
              :data-testid="`yields-token-${t.symbol}`"
              :class="[
                'font-sans text-[10px] uppercase tracking-[0.22em] font-semibold px-4 py-1.5 rounded-md transition-all duration-200 cursor-pointer whitespace-nowrap',
                selectedToken && selectedToken.toLowerCase() === t.address.toLowerCase()
                  ? 'bg-haze/70 dark:bg-white/10 text-gold dark:text-signal shadow-[0_4px_12px_-4px_rgba(0,0,0,0.18)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)]'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              {{ t.symbol }}
            </button>
          </div>

          <NavTrendChart :token-address="selectedToken" :range="activeRange" />

          <div class="mt-3 flex items-start gap-2">
            <Lock :size="11" :stroke-width="1.8" class="text-cool/70 mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool/70 italic leading-relaxed">
              NAV reflects the underlying asset's price, not your earnings.
              Per-investor yield amounts stay encrypted; multiply NAV change by
              your decrypted holding (on /portfolio) for a personal estimate.
            </p>
          </div>
        </div>
      </section>

      <!-- Wave 3.5 source-of-truth notice (when no chart anchor exists) -->
      <section
        v-else-if="epochsStore.items.length === 0"
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460, delay: 200 } }"
        data-testid="yields-empty-anticipation"
        class="rounded-2xl border border-haze dark:border-white/5 bg-mist/30 dark:bg-white/[0.02] p-6 md:p-8"
      >
        <div class="flex items-start gap-4">
          <div class="w-12 h-12 rounded-full bg-gold/12 dark:bg-signal/12 flex items-center justify-center flex-shrink-0">
            <Coins :size="20" :stroke-width="1.6" class="text-compute dark:text-signal" />
          </div>
          <div class="min-w-0">
            <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
              Ready when an issuer funds the next epoch.
            </p>
            <p class="font-sans text-[12px] text-cool mt-1.5 leading-relaxed max-w-2xl">
              Issuers open an epoch, snapshot balances, and fund it.
              Once funded, you'll claim from this page and your encrypted
              <span class="font-mono text-compute dark:text-signal">mhUSDC</span> balance grows.
              The chart returns once you have at least one snapshotted epoch.
            </p>
          </div>
        </div>
      </section>
    </div>

    <!-- Soft error strip: a reload after a successful first load failed
         (e.g. post-claim refetch). Items above are stale; offer Retry
         without wiping them off-screen. -->
    <div
      v-if="epochsStore.error && epochsStore.items.length > 0"
      data-testid="yields-soft-error"
      class="mt-4 flex items-start gap-3 p-4 rounded-xl border border-negative/25 bg-negative/5"
    >
      <AlertTriangle :size="16" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
      <div class="flex-1 min-w-0">
        <p class="font-sans text-[12px] text-cool leading-relaxed">{{ epochsStore.error }}</p>
        <button
          type="button"
          @click="address && epochsStore.load(address as Address)"
          class="mt-1.5 font-sans text-[11px] text-negative hover:underline cursor-pointer"
        >Retry</button>
      </div>
    </div>
  </div>
</template>
