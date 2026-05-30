<script setup lang="ts">
import { ref, reactive, onActivated, onDeactivated, onBeforeUnmount, computed, watch, defineAsyncComponent } from 'vue'
import { usePortfolioStore } from '@/stores/portfolio'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useWallet } from '@/composables/useWallet'
import MFaucetBanner from '@/components/ui/MFaucetBanner.vue'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import RebalancePanel from '@/components/portfolio/RebalancePanel.vue'
import { getPublicClient } from '@/services/v35/context'
import { erc20Abi, muHavenTokenAbi } from '@/contracts/abis'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { muHavenStableAbi } from '@muhaven/sdk'
import {
  Shield, Lock, ShieldCheck, KeyRound, Key, Eye, ArrowUp,
  Loader2, Unlock, RefreshCw,
} from 'lucide-vue-next'
import { formatUSD, cn } from '@/lib/utils'

// Named so App.vue's <keep-alive :include> can target this page (WS-1).
defineOptions({ name: 'PortfolioPage' })

// Defer Chart.js off the critical path: the donut only renders on the
// allocation hero tab, so async-loading it keeps Chart.js out of the initial
// page chunk and shortens first paint. WS-1 polish.
const PortfolioDonut = defineAsyncComponent(() => import('@/components/charts/PortfolioDonut.vue'))

const portfolio = usePortfolioStore()
const marketplace = useMarketplaceStore()
const { address } = useWallet()

type HeroTab = 'value' | 'allocation'
const activeTab = ref<HeroTab>('value')

// Always refetch on mount. The previous `if (portfolio.loaded) return`
// guard was a cross-account staleness footgun: a recipient who sees
// a transfer-in row on /activity (which always refetches per 7cdbdfb)
// would navigate to /portfolio expecting the new TBILL1 to appear,
// but the cache-skip held them on the pre-transfer holdings list.
// Same shape for the sender post-transfer-out — `decryptedBalance`
// in the cache is stale once the on-chain handle rotates.
//
// First-fetch loader still gates on `!portfolio.loaded` (`showLoader`
// below), so revisits don't flash a logo while the data is in
// flight. Decrypt state is reset by `load()` and re-cleared via
// `refreshAfterTrade` / `refreshAfterTransfer` on the action pages.
// Keep-alive lifecycle (WS-1). This page is cached across navigation, so
// onMounted/onBeforeUnmount fire only on TRUE mount/unmount; per-entry work
// runs on onActivated, per-exit teardown on onDeactivated.
//
// Two guards make rapid Cash<->Portfolio nav cheap (the RPC-429 fix):
//   - refetch is THROTTLED: skip portfolio.load() if it ran < LOAD_THROTTLE_MS
//     ago. A re-visit within the window shows the still-fresh cached holdings
//     instantly; an explicit Refresh / post-trade refresh bypasses this (it
//     calls load() directly, not through here).
//   - watcher arming is DEBOUNCED: viem's watchContractEvent fires one
//     eth_newFilter PER WATCHER the instant it's armed (~13 here), and
//     multicall does NOT batch those — re-arming on every entry was the real
//     429 source. We only arm after the user settles >ARM_DEBOUNCE_MS on the
//     page; onDeactivated cancels a pending arm, so flitting never arms.
const isActive = ref(false)
const ARM_DEBOUNCE_MS = 1200
const LOAD_THROTTLE_MS = 8000
let armTimer: ReturnType<typeof setTimeout> | null = null
let lastLoadAt = 0

function clearArmTimer() {
  if (armTimer) { clearTimeout(armTimer); armTimer = null }
}
function armWatchersDebounced() {
  clearArmTimer()
  armTimer = setTimeout(() => {
    armTimer = null
    const a = address.value as `0x${string}` | undefined
    if (isActive.value && a) void setupInboundWatchers(a)
  }, ARM_DEBOUNCE_MS)
}
function refetchThrottled() {
  const addr = address.value as `0x${string}` | undefined
  if (!addr) return
  if (Date.now() - lastLoadAt < LOAD_THROTTLE_MS) return
  lastLoadAt = Date.now()
  void portfolio.load(addr)
}

onActivated(() => {
  isActive.value = true
  if (!address.value) return
  refetchThrottled()
  armWatchersDebounced()
})

onDeactivated(() => {
  isActive.value = false
  clearArmTimer()
  teardownInboundWatchers()
})

// ── Inbound auto-refresh + holding bloom ───────────────────────────────
//
// Symmetry with /cash: /portfolio also subscribes to inbound transfers
// (per-RWA `MuHavenToken.Transfer` filtered to `to: kernelAddress` +
// `MuHavenStable.Transfer` for the strip's mhUSDC cell) and bloom-pulses
// the affected card on receipt. Without this, a recipient watching
// /portfolio when a P2P share transfer lands has to navigate to
// /activity and back to see their new holding — bad UX, given /cash
// already auto-refreshes for analogous events.
//
// `holdingBloomActive` keys by lowercased token address; the affected
// holding card binds to it for the gold-ring overlay. New tokens
// (auto-discovered by `portfolio.load`'s marketplace walk) get a
// bloom too — the overlay mounts when their card first renders if
// the key is set at that moment.
const holdingBloomActive = reactive<Record<string, boolean>>({})
const mhusdcStripBloomActive = ref(false)
const inboundRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inboundBloomClearTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inboundWatcherCleanups: Array<() => void> = []
// Safety-net poll. See CashPage for rationale: viem's
// watchContractEvent uses eth_newFilter polling and some Arb Sepolia
// RPCs garbage-collect filters mid-session, killing the watcher
// silently. This interval refreshes portfolio.load() (and re-decrypts
// mhUSDC if revealed) every SAFETY_POLL_MS regardless of watcher
// state. No bloom — bloom is the watcher's job.
let safetyPollTimer: ReturnType<typeof setInterval> | null = null

const PORTFOLIO_BLOOM_DEBOUNCE_MS = 1500
const PORTFOLIO_BLOOM_HOLD_MS = 1200 // slightly longer than /cash — holding cards are larger surfaces
const PORTFOLIO_SAFETY_POLL_MS = 30_000

async function handleHoldingInbound(tokenAddress: `0x${string}`) {
  if (!address.value) return
  const addr = address.value as `0x${string}`
  const lower = tokenAddress.toLowerCase()

  // Bloom the affected card (mounts even if the token isn't in
  // `portfolio.holdings` yet — the matching <transition> on the card
  // template will fire when the holding renders post-load).
  holdingBloomActive[lower] = true
  const prevTimer = inboundBloomClearTimers.get(lower)
  if (prevTimer) clearTimeout(prevTimer)
  inboundBloomClearTimers.set(
    lower,
    setTimeout(() => {
      delete holdingBloomActive[lower]
    }, PORTFOLIO_BLOOM_HOLD_MS),
  )

  // Snapshot which holdings were revealed pre-refresh so we can re-
  // decrypt them after `portfolio.load()` rebuilds the array (which
  // resets every `decryptedBalance` to null). Auto-discovered NEW
  // holdings stay locked — no surprise session signature for a
  // value the user never asked to see.
  const revealedSet = new Set(
    portfolio.holdings
      .filter(h => h.decryptedBalance !== null)
      .map(h => h.tokenAddress.toLowerCase()),
  )

  try {
    await portfolio.load(addr)
  } catch (e) {
    console.warn('[PortfolioPage] inbound refresh load() failed', e)
    return
  }

  // Re-decrypt previously-revealed holdings sequentially. Same
  // serialisation rationale as `decryptAll` — N+1 concurrent refresh
  // UserOps from one kernel collide on nonce/bundler queueing.
  for (let i = 0; i < portfolio.holdings.length; i++) {
    const h = portfolio.holdings[i]
    if (revealedSet.has(h.tokenAddress.toLowerCase())) {
      try {
        await portfolio.decryptHolding(i, addr)
      } catch (e) {
        console.warn(
          `[PortfolioPage] post-inbound re-decrypt of ${h.symbol} failed`,
          e,
        )
      }
    }
  }
}

function debouncedHoldingInbound(tokenAddress: `0x${string}`) {
  const lower = tokenAddress.toLowerCase()
  const prev = inboundRefreshTimers.get(lower)
  if (prev) clearTimeout(prev)
  inboundRefreshTimers.set(
    lower,
    setTimeout(() => {
      void handleHoldingInbound(tokenAddress)
    }, PORTFOLIO_BLOOM_DEBOUNCE_MS),
  )
}

let mhusdcStripBloomClearTimer: ReturnType<typeof setTimeout> | null = null
let mhusdcStripRefreshTimer: ReturnType<typeof setTimeout> | null = null

function debouncedMhusdcStripInbound() {
  if (mhusdcStripRefreshTimer) clearTimeout(mhusdcStripRefreshTimer)
  mhusdcStripRefreshTimer = setTimeout(() => {
    mhusdcStripBloomActive.value = true
    if (mhusdcStripBloomClearTimer) clearTimeout(mhusdcStripBloomClearTimer)
    mhusdcStripBloomClearTimer = setTimeout(() => {
      mhusdcStripBloomActive.value = false
    }, PORTFOLIO_BLOOM_HOLD_MS)
    // Re-decrypt only if the user opted into reveal — same privacy
    // rule as /cash (no surprise session signature on inbound).
    if (portfolio.pusdcConfidentialBalance !== null && address.value) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  }, PORTFOLIO_BLOOM_DEBOUNCE_MS)
}

// USDC strip cell — symmetric to mhUSDC but rebinds via portfolio.load()
// (not decrypt). Pre-fix the USDC tile only refreshed on full page mount;
// faucets, cross-account transfers, and post-trade USDC top-ups never
// surfaced until manual reload.
let usdcStripRefreshTimer: ReturnType<typeof setTimeout> | null = null
function debouncedUsdcStripInbound() {
  if (usdcStripRefreshTimer) clearTimeout(usdcStripRefreshTimer)
  usdcStripRefreshTimer = setTimeout(() => {
    if (!address.value) return
    void portfolio.load(address.value as `0x${string}`)
  }, PORTFOLIO_BLOOM_DEBOUNCE_MS)
}

function teardownInboundWatchers() {
  for (const cleanup of inboundWatcherCleanups) {
    try { cleanup() } catch { /* best-effort */ }
  }
  inboundWatcherCleanups.length = 0
  for (const t of inboundRefreshTimers.values()) clearTimeout(t)
  inboundRefreshTimers.clear()
  for (const t of inboundBloomClearTimers.values()) clearTimeout(t)
  inboundBloomClearTimers.clear()
  if (mhusdcStripRefreshTimer) { clearTimeout(mhusdcStripRefreshTimer); mhusdcStripRefreshTimer = null }
  if (mhusdcStripBloomClearTimer) { clearTimeout(mhusdcStripBloomClearTimer); mhusdcStripBloomClearTimer = null }
  if (usdcStripRefreshTimer) { clearTimeout(usdcStripRefreshTimer); usdcStripRefreshTimer = null }
  if (safetyPollTimer) { clearInterval(safetyPollTimer); safetyPollTimer = null }
  for (const k of Object.keys(holdingBloomActive)) delete holdingBloomActive[k]
  mhusdcStripBloomActive.value = false
}

async function setupInboundWatchers(kernelAddress: `0x${string}`) {
  teardownInboundWatchers()

  // Marketplace gives us the per-RWA token addresses to subscribe to.
  // Wait for it to load if not warm yet — the watchers depend on the
  // address list being known.
  if (!marketplace.loaded) {
    try { await marketplace.load() } catch (e) {
      console.warn('[PortfolioPage] marketplace.load failed; inbound watchers disabled', e)
      return
    }
  }
  // Re-check after the await: if the user navigated away (deactivated this
  // kept-alive page) while marketplace.load was in flight, do NOT arm the
  // watchers/safety poll — that would leave a BACKGROUNDED page polling, the
  // exact leak keep-alive is meant to kill. onActivated re-arms on return.
  if (!isActive.value) return
  const publicClient = getPublicClient()

  for (const t of marketplace.tokens) {
    const tokenAddr = t.address as `0x${string}`
    const unwatch = publicClient.watchContractEvent({
      address: tokenAddr,
      abi: muHavenTokenAbi,
      eventName: 'Transfer',
      args: { to: kernelAddress },
      pollingInterval: 12_000,
      onLogs: () => debouncedHoldingInbound(tokenAddr),
      onError: (err) => {
        console.warn(`[PortfolioPage] ${t.symbol} inbound watcher error`, err)
      },
    })
    inboundWatcherCleanups.push(unwatch)
  }

  // mhUSDC strip cell — same shape as /cash's mhUSDC tile.
  if (!isZeroAddress(v35Addresses.muHavenStable)) {
    const unwatchMhusdc = publicClient.watchContractEvent({
      address: v35Addresses.muHavenStable,
      abi: muHavenStableAbi,
      eventName: 'Transfer',
      args: { to: kernelAddress },
      pollingInterval: 12_000,
      onLogs: () => debouncedMhusdcStripInbound(),
      onError: (err) => {
        console.warn('[PortfolioPage] mhUSDC inbound watcher error', err)
      },
    })
    inboundWatcherCleanups.push(unwatchMhusdc)
  }

  // USDC strip cell — same shape as /cash's USDC watcher. Without
  // this, the USDC tile on /portfolio only refreshed on full page
  // mount — faucet drops, cross-account transfers, and post-trade USDC
  // top-ups silently failed to update. portfolio.load() rereads the
  // USDC balance alongside the holdings, so refresh is centralized.
  const unwatchUsdc = publicClient.watchContractEvent({
    address: addresses.usdc,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { to: kernelAddress },
    pollingInterval: 12_000,
    onLogs: () => debouncedUsdcStripInbound(),
    onError: (err) => {
      console.warn('[PortfolioPage] USDC inbound watcher error', err)
    },
  })
  inboundWatcherCleanups.push(unwatchUsdc)

  // Safety-net poll. See CashPage rationale: when viem's filter-based
  // watchContractEvent silently dies (RPC garbage-collects the
  // filter), this interval guarantees the dashboard reflects on-chain
  // state within ~30s regardless. portfolio.load() refreshes USDC +
  // holdings + investor count in one shot. mhUSDC re-decrypt only
  // fires if the user has revealed it (privacy: no surprise session
  // signature on a passive interval).
  safetyPollTimer = setInterval(() => {
    if (!isActive.value || !address.value) return
    void portfolio.load(address.value as `0x${string}`)
    if (portfolio.pusdcConfidentialBalance !== null) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  }, PORTFOLIO_SAFETY_POLL_MS)
}

// Account switch WHILE active → the new kernel needs fresh holdings + its own
// watchers. Bypass the load throttle (lastLoadAt=0) and re-arm (debounced).
// Gated on isActive so a switch landing while backgrounded is a no-op —
// onActivated re-syncs on return. No `immediate`: first-entry is onActivated.
watch(
  () => address.value,
  (addr) => {
    if (!isActive.value) return
    clearArmTimer()
    teardownInboundWatchers()
    if (addr) {
      lastLoadAt = 0
      refetchThrottled()
      armWatchersDebounced()
    }
  },
)
onBeforeUnmount(() => {
  clearArmTimer()
  teardownInboundWatchers()
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
//
// Two paths feed the count:
//   - decryptAll batch — uses local planned/done refs so the counter shows
//     the SIZE of the batch, decrementing as each decrypt completes
//     (`Revealing 3…` → `Revealing 2…` → …). With the sequential refresh
//     loop landed in 64658ef, the store's `decrypting` flags are only ever
//     true on a single holding, so a count derived from store state would
//     stick at "Revealing 1…" the whole time and lose the progress signal.
//   - single-holding click — falls back to the store-derived count
//     (`holdings.filter(decrypting).length + (pusdcDecrypting ? 1 : 0)`),
//     which mirrors the per-card spinner.
const decryptAllPlanned = ref(0)
const decryptAllDone = ref(0)

const singleDecryptCount = computed(() => {
  let n = 0
  for (const h of portfolio.holdings) if (h.decrypting) n++
  if (portfolio.pusdcDecrypting) n++
  return n
})

const pendingDecryptCount = computed(() => {
  if (decryptAllPlanned.value > 0) {
    return Math.max(0, decryptAllPlanned.value - decryptAllDone.value)
  }
  return singleDecryptCount.value
})
const revealing = computed(() => pendingDecryptCount.value > 0)

async function decryptAll() {
  if (!address.value) return
  const acct = address.value as `0x${string}`
  const pending = portfolio.holdings
    .map((h, i) => h.decryptedBalance === null ? i : -1)
    .filter(i => i >= 0)
  const pusdcPending =
    portfolio.pusdcConfidentialBalance === null && !portfolio.pusdcDecrypting

  // Reveal All previously fired N+1 decrypts via Promise.all. On a fresh
  // session, each one 403s on the TN's permit check (the wrap-time eph is
  // gone), and the per-handle refreshDecryptGrant fallback inside
  // `useFhe.decryptForView` queues a session-key UserOp. N+1 concurrent
  // UserOps from the same kernel collide on nonces / bundler queueing —
  // some land, some hit `WaitForUserOperationReceiptTimeoutError` and
  // fall back to a passkey prompt. Sequential keeps the kernel quiet:
  // each refresh tx confirms before the next decrypt starts. Cost on
  // staging (1-2 RWAs + mhUSDC) is the few seconds it takes for each
  // refresh to confirm, vs. the previous worst case of one timeout
  // (~30s) followed by the user approving a fallback passkey prompt.
  //
  // Future-Wave: batch all refreshes into a single kernel `executeBatch`
  // UserOp — same UX, one round-trip, scales to many holdings.
  decryptAllPlanned.value = pending.length + (pusdcPending ? 1 : 0)
  decryptAllDone.value = 0
  try {
    for (const i of pending) {
      await portfolio.decryptHolding(i, acct)
      decryptAllDone.value++
    }
    if (pusdcPending) {
      await portfolio.decryptPusdc(acct)
      decryptAllDone.value++
    }
  } finally {
    decryptAllPlanned.value = 0
    decryptAllDone.value = 0
  }
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

/**
 * Wave 5 zero-burn: returns a badge label for non-active tokens so the
 * holder sees "this is winding down" inline on the row, or empty string
 * for active tokens (badge hidden). Resolves through `marketplace`
 * because the portfolio holding object doesn't carry `status`; the
 * marketplace store is loaded on the same page as portfolio (both
 * mounted from PortfolioPage's `onMounted`) so the lookup is hot.
 * Returns '' on cache miss — the badge then doesn't render, which is
 * the right behaviour for tokens that aren't in the marketplace catalog
 * (e.g. a P2P-received token that the user holds but the marketplace
 * page hasn't loaded yet).
 */
function holdingStatusBadge(tokenAddress: string): string {
  const data = marketplace.getByAddress(tokenAddress)
  if (!data) return ''
  if (data.status === 'winding_down') return 'Winding down'
  if (data.status === 'paused') return 'Paused'
  if (data.status === 'archived') return 'Archived'
  return ''
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

// Wave 5: hide fully-exited positions from the Holdings list. A holding
// revealed to exactly 0 (e.g. the whole position was just sold) should drop
// off rather than linger as a confusing "0 SYMBOL" row. Only KNOWN-zero is
// hidden — an unrevealed holding (decryptedBalance === null) stays visible
// behind its reveal gate, and any positive balance stays. The original store
// index `i` is preserved so per-card reveal (`decryptOne(i)`) still targets
// the right holding.
const visibleHoldings = computed(() =>
  portfolio.holdings
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.decryptedBalance !== 0n),
)

// Raw holdings exist but every one is a revealed zero (user exited every
// position) — drives a distinct "all positions closed" note so the Holdings
// header doesn't sit above an empty grid.
const allHoldingsExited = computed(
  () => portfolio.holdings.length > 0 && visibleHoldings.value.length === 0,
)

const hasRevealedAllocationSlice = computed(() =>
  portfolio.allocationSlices.some(s => !s.isLocked),
)

const lockedSliceCount = computed(() =>
  portfolio.allocationSlices.filter(s => s.isLocked).length,
)

/**
 * Show the "Allocation blurred" preview state only when nothing has been
 * revealed yet AND there's something to decrypt. Once everything has been
 * decrypted (even if every revealed value is zero) we fall through to the
 * donut + legend area, which has its own empty state — avoids stranding
 * users on a "Decrypt to see allocation" CTA after they already decrypted.
 */
const showBlurredAllocation = computed(() =>
  !hasRevealedAllocationSlice.value && lockedSliceCount.value > 0,
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
          <!-- Value tab. v-show (not v-if) so the sibling Allocation tab
               below stays mounted across tab clicks — keeps the Chart.js
               donut instance alive and stops the entrance animation from
               replaying on every Allocation click. First-time animation
               still plays on page load (chart resizes from 0×0 once the
               Allocation tab becomes visible). -->
          <div
            v-show="activeTab === 'value'"
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

          <!-- Allocation tab. Paired v-show with the Value tab above so
               the donut stays mounted across tab toggles. -->
          <div
            v-show="activeTab === 'allocation'"
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

            <!-- LOCKED allocation state — only when there's something
                 still encrypted AND nothing revealed yet (cold first-run:
                 zero USDC + locked mhUSDC + every RWA locked). Most users
                 skip this branch entirely because USDC is plaintext and
                 known once `portfolio.load` resolves. -->
            <div
              v-if="showBlurredAllocation"
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

            <!-- DECRYPTED allocation state — donut + legend.
                 Single source of truth: `portfolio.allocationSlices` drives
                 both the donut arcs and the legend rows. Includes USDC +
                 mhUSDC (cash cluster) + RWAs. The segmented bar above the
                 legend was dropped — duplicated the donut. -->
            <div v-else class="z-10 w-full flex flex-col md:flex-row items-center gap-8">
              <div class="w-44 md:w-52 flex-shrink-0">
                <PortfolioDonut
                  :slices="portfolio.allocationSlices"
                  :total="portfolio.totalDecryptedValue"
                />
              </div>
              <div class="flex-1 w-full" data-testid="portfolio-allocation-legend">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
                  <div
                    v-for="slice in portfolio.allocationSlices"
                    :key="slice.key"
                    data-testid="portfolio-allocation-legend-row"
                    :data-slice-key="slice.key"
                    :data-slice-locked="slice.isLocked"
                    class="flex items-center gap-2.5"
                  >
                    <!-- Solid swatch for revealed slices; dashed-outlined
                         square for locked entries — mirrors "encrypted /
                         awaiting reveal" without inventing a new visual. -->
                    <span
                      v-if="!slice.isLocked"
                      class="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      :style="{ backgroundColor: slice.color }"
                    />
                    <span
                      v-else
                      class="w-2.5 h-2.5 rounded-sm border border-dashed border-cool/50 flex-shrink-0"
                    />
                    <span class="font-sans text-xs text-slate dark:text-body-dark/80 flex-1 truncate">
                      {{ slice.name }}
                    </span>
                    <template v-if="!slice.isLocked">
                      <span class="font-sans text-xs text-cool tabular-nums">
                        {{ formatUSD(slice.value) }}
                      </span>
                      <span class="font-sans text-[10px] text-cool/70 w-10 text-right tabular-nums">
                        {{ slice.pct.toFixed(0) }}%
                      </span>
                    </template>
                    <Lock
                      v-else
                      :size="12"
                      :stroke-width="1.8"
                      class="text-cool/60 ml-auto flex-shrink-0"
                    />
                  </div>
                </div>

                <!-- Locked-positions notice. Renders only when something
                     in the legend is locked — gives the user a one-liner
                     "you're seeing a partial picture" + a Reveal All
                     shortcut. The hero already has Reveal All but this
                     surface lives where the eye is when scanning the
                     allocation tab. -->
                <div
                  v-if="lockedSliceCount > 0"
                  data-testid="portfolio-allocation-locked-notice"
                  class="mt-4 flex items-center gap-2 text-[11px] font-sans text-cool"
                >
                  <Lock :size="12" :stroke-width="1.8" class="flex-shrink-0" />
                  <span class="flex-1">
                    {{ lockedSliceCount }} position{{ lockedSliceCount === 1 ? '' : 's' }} still encrypted
                  </span>
                  <button
                    type="button"
                    @click="decryptAll"
                    :disabled="revealing"
                    data-testid="portfolio-allocation-locked-notice-cta"
                    class="font-semibold uppercase tracking-[0.18em] text-compute dark:text-signal hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  >
                    Reveal All
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom stats strip — Phase 9.A round 2: Cash section collapsed
               into here as a dense 3-cell strip (USDC | mhUSDC | Holdings).
               FHE Status dropped — footer privacy pill carries the message;
               the "Active · euint128" microcopy was engineer cosplay. -->
          <div
            role="group"
            aria-label="Cash and holdings summary"
            class="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x
                   divide-haze dark:divide-white/5
                   bg-mist/40 dark:bg-white/[0.02]"
          >
            <!-- USDC cell (plaintext ERC-20) -->
            <div
              data-testid="portfolio-strip-cash-cell"
              class="p-6 flex flex-col gap-1 min-h-[104px] justify-center"
            >
              <p class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
                USDC
              </p>
              <p class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums">
                {{ portfolio.usdcBalance !== null ? formatUSD(Number(portfolio.usdcBalance) / 1e6) : '—' }}
              </p>
              <p class="font-sans text-[10px] text-cool/70 tracking-wide">
                Plaintext · ERC-20
              </p>
            </div>

            <!-- mhUSDC cell (encrypted, opt-in reveal-in-cell) -->
            <div
              data-testid="portfolio-strip-mhusdc-cell"
              class="relative p-6 flex flex-col gap-1 min-h-[104px] justify-center"
            >
              <!-- Inbound bloom — fires on MuHavenStable.Transfer with
                   `to: kernel`. For revealed users, the value updates
                   in lockstep via `decryptPusdc`; locked users see the
                   bloom only and reveal manually. Same pattern as
                   /cash's mhUSDC tile. -->
              <transition
                enter-active-class="transition-opacity duration-300 ease-out"
                leave-active-class="transition-opacity duration-500 ease-in"
                enter-from-class="opacity-0"
                leave-to-class="opacity-0"
              >
                <div
                  v-if="mhusdcStripBloomActive"
                  aria-hidden="true"
                  data-testid="portfolio-strip-mhusdc-bloom"
                  class="absolute inset-0 pointer-events-none
                         ring-2 ring-gold/40 dark:ring-signal/40
                         shadow-[0_0_24px_-4px_rgba(255,186,32,0.45)]
                         dark:shadow-[0_0_24px_-4px_rgba(255,220,161,0.35)]"
                />
              </transition>
              <p class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
                mhUSDC
              </p>
              <!-- LOCKED: value-row is the click target. Wrapping the
                   blurred bullets + Eye icon in a button gives a clear,
                   sized hit area without making labels selectable as a
                   button (keyboard tab order stays clean). -->
              <button
                v-if="portfolio.pusdcConfidentialBalance === null"
                type="button"
                @click="decryptPusdc"
                :disabled="portfolio.pusdcDecrypting"
                :aria-label="portfolio.pusdcDecrypting ? 'Revealing encrypted cash balance' : 'Reveal encrypted cash balance'"
                data-testid="portfolio-strip-mhusdc-decrypt-cta"
                class="self-start inline-flex items-center gap-2 rounded-md px-2 -mx-2 py-1 -my-1
                       cursor-pointer hover:bg-gold/8 dark:hover:bg-signal/8
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold/60
                       transition-colors disabled:cursor-wait"
              >
                <span
                  class="font-accent italic text-2xl text-cool/40 dark:text-body-dark/30
                         tabular-nums select-none blur-[2px] tracking-[0.05em]"
                  aria-hidden="true"
                >
                  $••••.••
                </span>
                <Loader2 v-if="portfolio.pusdcDecrypting" :size="14" class="animate-spin text-gold dark:text-signal" />
                <Eye v-else :size="14" :stroke-width="1.8" class="text-gold dark:text-signal opacity-80" />
              </button>
              <p
                v-if="portfolio.pusdcConfidentialBalance === null"
                class="font-sans text-[10px] text-cool/70 tracking-wide"
              >
                {{ portfolio.pusdcDecrypting ? 'Revealing…' : 'Encrypted · click to reveal' }}
              </p>

              <!-- REVEALED: value + Refresh ghost icon. ShieldCheck-gold next
                   to the value mirrors the hero's Lock/Shield rhythm so the
                   eye reads "this is the encrypted one" without a heavy chip. -->
              <div
                v-if="portfolio.pusdcConfidentialBalance !== null"
                class="flex items-center gap-2"
              >
                <span class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums">
                  {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
                </span>
                <ShieldCheck :size="14" :stroke-width="1.8" class="text-gold dark:text-signal flex-shrink-0" />
                <button
                  type="button"
                  @click="decryptPusdc"
                  :disabled="portfolio.pusdcDecrypting"
                  data-testid="portfolio-strip-mhusdc-refresh-cta"
                  :title="portfolio.pusdcDecrypting ? 'Refreshing…' : 'Re-read + decrypt'"
                  :aria-label="portfolio.pusdcDecrypting ? 'Refreshing encrypted cash balance' : 'Refresh encrypted cash balance'"
                  class="ml-auto text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >
                  <Loader2 v-if="portfolio.pusdcDecrypting" :size="12" class="animate-spin" />
                  <RefreshCw v-else :size="12" />
                </button>
              </div>
              <p
                v-if="portfolio.pusdcConfidentialBalance !== null && !portfolio.pusdcStale"
                class="font-sans text-[10px] text-cool/70 tracking-wide"
              >
                Confidential stablecoin
              </p>
              <!-- Stale sub-line: most-recent passive refresh failed but the
                   cached value is still visible. Surface the failure mode
                   inline (financial dashboards must not lie about freshness)
                   with an inline Retry that re-fires the decrypt — same
                   action as the small RefreshCw button, just labeled. -->
              <p
                v-else-if="portfolio.pusdcConfidentialBalance !== null && portfolio.pusdcStale"
                data-testid="portfolio-strip-mhusdc-stale"
                class="font-sans text-[10px] text-cool/70 tracking-wide flex items-center gap-1"
              >
                <span>Last refresh failed</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  @click="decryptPusdc"
                  :disabled="portfolio.pusdcDecrypting"
                  class="text-compute dark:text-signal hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >retry</button>
              </p>
            </div>

            <!-- Holdings count cell -->
            <div
              data-testid="portfolio-strip-holdings-cell"
              class="p-6 flex flex-col gap-1 min-h-[104px] justify-center"
            >
              <p class="font-sans text-[10px] uppercase tracking-[0.2em] text-cool">
                Holdings
              </p>
              <p class="font-accent italic text-2xl text-midnight dark:text-white">
                {{ portfolio.holdings.length }}
              </p>
              <p class="font-sans text-[10px] text-cool/70 tracking-wide">
                {{ portfolio.holdings.length === 1 ? 'RWA asset' : 'RWA assets' }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- mhUSDC scoped error — under hero (was inside the now-deleted Cash
           section). Sits as its own row so a long error message can wrap;
           strip cells are too narrow for that. Inline Retry re-fires the
           same decrypt path. -->
      <div
        v-if="portfolio.pusdcError"
        data-testid="portfolio-strip-mhusdc-error"
        class="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-negative/8 border border-negative/20"
      >
        <p class="text-[11px] font-sans text-negative leading-relaxed flex-1">
          {{ portfolio.pusdcError }}
        </p>
        <button
          type="button"
          @click="decryptPusdc"
          :disabled="portfolio.pusdcDecrypting"
          class="text-[11px] font-sans font-semibold uppercase tracking-[0.18em]
                 text-compute dark:text-signal hover:underline cursor-pointer
                 disabled:opacity-50 disabled:cursor-wait"
        >
          Retry
        </button>
      </div>

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
          <!-- All positions exited (every holding revealed to zero). -->
          <p
            v-if="allHoldingsExited"
            data-testid="portfolio-all-exited"
            class="text-sm text-cool py-6 text-center"
          >
            No active positions — you've sold out of every holding.
            <RouterLink to="/trade" class="text-compute dark:text-signal hover:underline">Buy RWA shares</RouterLink>
            to get started again.
          </p>
          <!-- RWA holdings (known-zero balances hidden — see visibleHoldings) -->
          <div
            v-for="({ h, i }) in visibleHoldings"
            :key="h.tokenAddress"
            v-motion
            :initial="{ opacity: 0, y: 16 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: i * 90 } }"
            :data-testid="'portfolio-holding-card'"
            :data-token-address="h.tokenAddress"
            class="relative overflow-hidden rounded-xl p-5 md:p-6 border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717] hover:border-gold/40 dark:hover:border-signal/25
                   transition-colors duration-300
                   flex items-center justify-between gap-4"
          >
            <!-- Inbound bloom — fires when MuHavenToken.Transfer with
                 `to: kernel` lands on this token. Pure visual cue;
                 the underlying refresh + re-decrypt is handled by
                 `handleHoldingInbound`. Pointer-events-none so the
                 Decrypt button + APY remain clickable. -->
            <transition
              enter-active-class="transition-opacity duration-300 ease-out"
              leave-active-class="transition-opacity duration-500 ease-in"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <div
                v-if="holdingBloomActive[h.tokenAddress.toLowerCase()]"
                aria-hidden="true"
                :data-testid="`portfolio-holding-bloom-${h.symbol}`"
                class="absolute inset-0 rounded-xl pointer-events-none
                       ring-2 ring-gold/40 dark:ring-signal/40
                       shadow-[0_0_28px_-6px_rgba(255,186,32,0.45)]
                       dark:shadow-[0_0_28px_-6px_rgba(255,220,161,0.35)]"
              />
            </transition>
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
                <!-- Wave 5 zero-burn: surfaces non-active tokens
                     (winding_down / paused / archived) so holders know
                     the position is in legacy state. Existing balance
                     stays sellable on /trade; new buys are gated there.
                     Gold tint distinguishes it from the asset-class
                     chip's neutral mist. SR-only "Status:" prefix so
                     a screen reader reads "TBILL1, Treasury, Status:
                     Winding down" rather than the orphan label. -->
                <span
                  v-if="holdingStatusBadge(h.tokenAddress)"
                  :data-testid="`portfolio-holding-status-${h.symbol}`"
                  class="font-sans text-[10px] uppercase tracking-[0.18em] font-bold
                         px-2 py-0.5 rounded bg-gold/15 dark:bg-signal/10
                         border border-gold/30 dark:border-signal/25 text-gold dark:text-signal"
                >
                  <span class="sr-only">Status: </span>{{ holdingStatusBadge(h.tokenAddress) }}
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
           Auto-rebalance (Wave 5 Slice 3) — below Holdings (the priority
           section); collapses to a status strip + RWA-only verification.
           ══════════════════════════════════════════════════════════ -->
      <RebalancePanel :wallet-address="address ?? null" />

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

