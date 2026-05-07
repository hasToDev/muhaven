<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, reactive } from 'vue'
import { useActivityStore } from '@/stores/activity'
import { useMarketplaceStore } from '@/stores/marketplace'
import { formatUSD, formatAddress } from '@/lib/utils'
import { useFhe } from '@/composables/useFhe'
import { useWallet } from '@/composables/useWallet'
import * as SnapshotService from '@/services/v35/SnapshotService'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import MPrivacyProofPanel from '@/components/ui/MPrivacyProofPanel.vue'
import type { ActivityItemDto, ActivityItemType } from '@/services/api'
import {
  TrendingUp, ArrowDown, ArrowRightLeft, Coins, BarChart3, Lock,
  Inbox, ChevronDown, Loader2, Eye, ShieldCheck, RefreshCw, Wallet,
  Send, Download,
} from 'lucide-vue-next'

const activity = useActivityStore()
const marketplace = useMarketplaceStore()
const fhe = useFhe()
const { address: walletAddress } = useWallet()

// Phase 9.A · Option Z — `cash` collapses wrap+unwrap (per the open
// decision in PHASE_9A_OPTION_Z_PLAN.md). Phase 9.A · Option Z follow-up
// adds a `transfer` filter that collapses `transfer-in` + `transfer-out`
// — same UX shape as `cash` (two events render under one filter).
type FilterType = 'all' | 'buy' | 'sell' | 'yield' | 'cash' | 'transfer'
const activeFilter = ref<FilterType>('all')
const expandedId = ref<string | null>(null)

// Decrypt-on-demand cache for wrap/unwrap rows. Key: item.id. Value: bigint
// (raw mhUSDC base units, 6 decimals). Reset on page nav by virtue of the
// component scope.
const revealedAmounts = reactive<Record<string, bigint>>({})
// Per-row in-flight tracking — using a record (not a single ref) so two
// rows decrypting in parallel don't clobber each other's spinner state.
const decryptingById = reactive<Record<string, boolean>>({})
const decryptErrorById = reactive<Record<string, string>>({})

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function isCashType(t: ActivityItemType): boolean {
  return t === 'wrap' || t === 'unwrap'
}

function isTransferType(t: ActivityItemType): boolean {
  return t === 'transfer-in' || t === 'transfer-out'
}

function isYieldClaimType(t: ActivityItemType): boolean {
  return t === 'yield'
}

/**
 * Decryptable types — rows that carry an encrypted amount handle in
 * `metadata.encrypted_amount_handle`:
 *   - cash rows (wrap/unwrap) — euint64 mhUSDC base units.
 *   - transfer rows (transfer-in/-out) — euint128 share amount on a
 *     per-RWA token.
 *   - yield rows — euint64 mhUSDC base units, dispatched against the
 *     YieldSnapshot proxy's `refreshAuditGrant` (Phase 9.A audit-handle
 *     follow-up; closes the cumulative `_balances[investor]` chain-
 *     depth issue per `project_cofhe_tn_chain_length_cap`).
 *
 * The decrypt path branches by type — different handle widths and
 * different refresh-grant target contracts.
 */
function isDecryptableType(t: ActivityItemType): boolean {
  return isCashType(t) || isTransferType(t) || isYieldClaimType(t)
}

function matchesFilter(item: ActivityItemDto, f: FilterType): boolean {
  if (f === 'all') return true
  if (f === 'cash') return isCashType(item.type)
  if (f === 'transfer') return isTransferType(item.type)
  if (f === 'sell') return item.type === 'sell' || item.type === 'sell-queued'
  return item.type === f
}

const filtered = computed(() =>
  activity.items.filter(i => matchesFilter(i, activeFilter.value)),
)

const filterCounts = computed(() => ({
  all: activity.items.length,
  buy: activity.items.filter(i => matchesFilter(i, 'buy')).length,
  sell: activity.items.filter(i => matchesFilter(i, 'sell')).length,
  yield: activity.items.filter(i => matchesFilter(i, 'yield')).length,
  cash: activity.items.filter(i => matchesFilter(i, 'cash')).length,
  transfer: activity.items.filter(i => matchesFilter(i, 'transfer')).length,
}))

const yieldsThisWeek = computed(() => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return activity.items.filter(
    i => i.type === 'yield' && new Date(i.timestamp).getTime() >= sevenDaysAgo,
  ).length
})

const cashEventsThisWeek = computed(() => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return activity.items.filter(
    i => isCashType(i.type) && new Date(i.timestamp).getTime() >= sevenDaysAgo,
  ).length
})

const transferEventsThisWeek = computed(() => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return activity.items.filter(
    i => isTransferType(i.type) && new Date(i.timestamp).getTime() >= sevenDaysAgo,
  ).length
})

const filterMeta: Record<FilterType, { label: string }> = {
  all: { label: 'All' },
  buy: { label: 'Buy' },
  sell: { label: 'Sell' },
  yield: { label: 'Yield' },
  cash: { label: 'Cash' },
  transfer: { label: 'Transfer' },
}

const activityMeta: Record<ActivityItemType, {
  icon: typeof TrendingUp
  iconClass: string
  iconBg: string
  iconBorder: string
  amountClass: string
}> = {
  buy: {
    icon: TrendingUp,
    iconClass: 'text-positive',
    iconBg: 'bg-positive/10',
    iconBorder: 'border-positive/30',
    amountClass: 'text-positive',
  },
  sell: {
    icon: ArrowDown,
    iconClass: 'text-cool',
    iconBg: 'bg-haze/40 dark:bg-white/5',
    iconBorder: 'border-haze dark:border-white/10',
    amountClass: 'text-midnight dark:text-white',
  },
  'sell-queued': {
    icon: ArrowDown,
    iconClass: 'text-gold dark:text-signal',
    iconBg: 'bg-gold/10 dark:bg-signal/10',
    iconBorder: 'border-gold/25 dark:border-signal/25',
    amountClass: 'text-midnight dark:text-white',
  },
  yield: {
    icon: Coins,
    iconClass: 'text-positive',
    iconBg: 'bg-positive/10',
    iconBorder: 'border-positive/30',
    amountClass: 'text-positive',
  },
  wrap: {
    icon: ArrowRightLeft,
    iconClass: 'text-compute dark:text-signal',
    iconBg: 'bg-compute/10 dark:bg-signal/10',
    iconBorder: 'border-compute/25 dark:border-signal/25',
    amountClass: 'text-midnight dark:text-white',
  },
  unwrap: {
    icon: ArrowRightLeft,
    iconClass: 'text-cool',
    iconBg: 'bg-haze/40 dark:bg-white/5',
    iconBorder: 'border-haze dark:border-white/10',
    amountClass: 'text-midnight dark:text-white',
  },
  // Phase 9.A · Option Z follow-up — outbound transfer (sender's
  // perspective). Cool palette + send glyph: visually neutral, the
  // direction is conveyed by the icon + row title.
  'transfer-out': {
    icon: Send,
    iconClass: 'text-cool',
    iconBg: 'bg-haze/40 dark:bg-white/5',
    iconBorder: 'border-haze dark:border-white/10',
    amountClass: 'text-midnight dark:text-white',
  },
  // Phase 9.A · Option Z follow-up — inbound transfer (recipient's
  // perspective). Positive accent so received shares feel like a
  // credit, mirroring the buy / yield rows.
  'transfer-in': {
    icon: Download,
    iconClass: 'text-positive',
    iconBg: 'bg-positive/10',
    iconBorder: 'border-positive/30',
    amountClass: 'text-positive',
  },
  fee: {
    icon: Wallet,
    iconClass: 'text-cool',
    iconBg: 'bg-haze/40 dark:bg-white/5',
    iconBorder: 'border-haze dark:border-white/10',
    amountClass: 'text-cool',
  },
}

function tokenSymbol(addr: string | null): string {
  if (!addr) return ''
  return marketplace.getByAddress(addr)?.symbol ?? formatAddress(addr)
}

/**
 * Phase 9.A · Option Z follow-up — counterparty address truncated for
 * display (e.g. `0xddf5…0116`). Lives in `metadata.counterparty` on
 * Transfer rows. Reuses the shared `formatAddress` helper so the
 * truncation matches every other surface (wallet badge, /trade glance
 * bar, etc.).
 */
function counterpartyFromMetadata(item: ActivityItemDto): string {
  const cp = item.metadata?.counterparty
  return typeof cp === 'string' && cp.startsWith('0x') ? formatAddress(cp) : ''
}

function rowTitle(item: ActivityItemDto): string {
  const sym = tokenSymbol(item.token_address)
  switch (item.type) {
    case 'buy':
      return sym ? `Bought ${sym}` : 'Purchase'
    case 'sell':
      return sym ? `Sold ${sym}` : 'Sale'
    case 'sell-queued':
      return sym ? `Queued sell · ${sym}` : 'Queued redemption'
    case 'yield':
      return sym ? `Yield claim · ${sym}` : 'Yield claim'
    case 'wrap':
      return 'Wrapped USDC → mhUSDC'
    case 'unwrap':
      return 'Unwrapped mhUSDC → USDC'
    case 'transfer-out': {
      const cp = counterpartyFromMetadata(item)
      const symFrag = sym ? ` ${sym}` : ' shares'
      return cp ? `Sent${symFrag} to ${cp}` : `Sent${symFrag}`
    }
    case 'transfer-in': {
      const cp = counterpartyFromMetadata(item)
      const symFrag = sym ? ` ${sym}` : ' shares'
      return cp ? `Received${symFrag} from ${cp}` : `Received${symFrag}`
    }
    case 'fee':
      return 'Fee event'
  }
}

function statusLabel(item: ActivityItemDto): string {
  if (item.type === 'sell-queued') return 'queued'
  return item.status
}

function statusAccent(status: string): { text: string; ring: string; bg: string } {
  switch (status) {
    case 'claimed':
    case 'confirmed':
      return { text: 'text-positive', ring: 'border-positive/30', bg: 'bg-positive/10' }
    case 'pending':
      return { text: 'text-gold', ring: 'border-gold/30', bg: 'bg-gold/10' }
    case 'queued':
      return { text: 'text-compute dark:text-signal', ring: 'border-compute/30 dark:border-signal/30', bg: 'bg-compute/10 dark:bg-signal/10' }
    default:
      return { text: 'text-cool', ring: 'border-haze dark:border-white/10', bg: 'bg-haze/30 dark:bg-white/5' }
  }
}

// Reactive `now` tick for relative-time labels — incremented every 30s so
// rows that started at "Just now" age into "30s ago" / "2m ago" / etc.
// without a manual page reload. Reading `nowTick` inside `formatTime`
// makes the computed dependent on it; cleared on unmount.
const nowTick = ref(Date.now())
let nowTickInterval: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  nowTickInterval = setInterval(() => {
    nowTick.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (nowTickInterval) {
    clearInterval(nowTickInterval)
    nowTickInterval = null
  }
})

function formatTime(timestamp: string): string {
  // Touch `nowTick` so this fn re-runs on tick; the value itself isn't
  // used (we re-read `Date.now()` for sub-tick accuracy).
  void nowTick.value
  const d = new Date(timestamp)
  const diffMs = Date.now() - d.getTime()
  const diffSec = Math.max(0, Math.floor(diffMs / 1000))
  const diffMin = Math.floor(diffSec / 60)
  const diffH = Math.floor(diffMin / 60)
  const diffD = Math.floor(diffH / 24)

  // Finer granularity in the first hour: previously every event <1h old
  // read "Just now" forever, which felt like the row was frozen even
  // though the indexer + DB had moved on. Now "Just now" is reserved for
  // the first 30 seconds; after that the row counts up in
  // seconds → minutes → hours.
  if (diffSec < 30) return 'Just now'
  if (diffMin < 1) return `${diffSec}s ago`
  if (diffH < 1) return `${diffMin}m ago`
  if (diffD < 1) return `${diffH}h ago`
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString()
}

async function decryptAmount(item: ActivityItemDto) {
  const handle = item.metadata?.encrypted_amount_handle
  if (!handle) return
  if (revealedAmounts[item.id] !== undefined) return
  if (decryptingById[item.id]) return
  decryptingById[item.id] = true
  delete decryptErrorById[item.id]
  try {
    // Two flavours of audit handle, both stored in
    // `metadata.encrypted_amount_handle`:
    //   - cash rows (wrap / unwrap) carry an `euint64` mhUSDC base-units
    //     value; `decryptAuditHandleForView` falls back to
    //     `MuHavenStable.refreshAuditGrant`.
    //   - transfer rows (transfer-in / -out) carry an `euint128` share
    //     amount on a per-RWA token; `decryptTokenAuditHandleForView`
    //     falls back to that token's `refreshAuditGrant`. The token
    //     address is required and lives on `item.token_address`.
    let value: bigint
    if (isCashType(item.type)) {
      value = await fhe.decryptAuditHandleForView(handle)
    } else if (isTransferType(item.type)) {
      if (!item.token_address) {
        throw new Error('Transfer row missing token_address — cannot decrypt')
      }
      value = await fhe.decryptTokenAuditHandleForView(
        handle,
        item.token_address as `0x${string}`,
      )
    } else if (isYieldClaimType(item.type)) {
      // Yield-claim decoupled-decrypt path · Round 3 (2026-05-04).
      // The audit handle in YieldClaimed.amount (encShare64) is
      // wrapper-touching — empirical testing on staging showed cofhe
      // TN's wrapper-scoped indexer refuses it even at the documented
      // "5-op" threshold. Round 2 fell back to encRatio +
      // snapshotBalance, but encRatio (depth ~max(encYCanonical,
      // encTotalSupply) + 1) ALSO 204s on staging because its
      // denominator inherits the wrapper-tainted ancestry through
      // each investor's `_balances[i]`.
      //
      // Round 3: decrypt three depth-shallow OR known-good handles —
      //   - encTotalYield (depth ~3, fresh-from-issuer, never touches
      //     the wrapper, never aggregated)
      //   - snapshotBalance (frozen at snapshot time, same shape as
      //     `_balances[investor]` which decrypts fine per memory)
      //   - encTotalSupply (sum-of-snapshot-balances, same shape as
      //     snapshotBalance for 1-investor demos; depth grows with
      //     holderCount but stays in the working range for ≤4)
      // Compute `claimAmount = floor(snapshotBalance × totalYield /
      // totalSupply)` locally. Sidesteps `encRatio` entirely.
      //
      // Contract-side ACL grants (post-Round-3 upgrade): claimYield
      // stamps kernel + ephemeralEOA on encTotalYield + encTotalSupply
      // (additive — Round 2's encRatio grants stay in place for any
      // single-investor case where encRatio happens to land in the
      // working range).
      //
      // Inputs:
      //   - epochId (from item.reference_id, populated by the indexer
      //     from YieldClaimed.epochId).
      //   - snapshotAddr (resolved via SnapshotService — singleton
      //     fallback for wizard-deployed tokens).
      //   - investor address (= holder address; for activity rows the
      //     authenticated user IS the holder).
      if (!item.token_address) {
        throw new Error('Yield-claim row missing token_address — cannot decrypt')
      }
      if (!item.reference_id) {
        throw new Error('Yield-claim row missing epoch reference — re-index needed')
      }
      const snapshotAddr = SnapshotService.snapshotProxyFor(
        item.token_address as `0x${string}`,
      )
      if (!snapshotAddr) {
        throw new Error(
          `No YieldSnapshot proxy configured for token ${item.token_address} — `
          + 'set VITE_YIELD_SNAPSHOT_ADDRESS in frontend/.env.stage and rebuild.',
        )
      }
      if (!walletAddress.value) {
        throw new Error('Wallet not connected — cannot resolve snapshot balance')
      }
      const { YieldSnapshotClient } = await import('@muhaven/sdk')
      const { buildReadContext } = await import('@/services/v35/context')
      const snapshotClient = new YieldSnapshotClient(buildReadContext(), snapshotAddr)
      const epochId = BigInt(item.reference_id)

      // Two parallel reads, three parallel decrypts.
      const [epoch, snapshotBalanceHandle] = await Promise.all([
        snapshotClient.getEpoch(epochId),
        snapshotClient.getSnapshotBalance(epochId, walletAddress.value as `0x${string}`),
      ])
      // encTotalSupply for a 1-investor epoch is literally the same
      // handle as snapshotBalance (snapshotBatch's `runningSupply =
      // bal` branch). De-dupe to avoid two parallel decrypt requests
      // for the same ctHash — TN treats each as independent and the
      // second usually flat-out 404s during the first's processing
      // window.
      const supplyEqualsBalance =
        epoch.encTotalSupply.toLowerCase() === snapshotBalanceHandle.toLowerCase()
      const [totalYield, snapshotBalance, totalSupply] = await Promise.all([
        // encTotalYield: kernel + eph ACL granted by claimYield (post-
        // 2026-05-04 Round 3 upgrade). Depth ~3 (asEuint128 →
        // asEuint64 → asEuint128), wrapper-free. Reliable.
        //
        // Use the YieldSnapshot-aggregate decryptor (no refresh
        // fallback). The default `decryptUint128ForView` path's
        // 403 fallback dispatches `MuHavenToken.refreshDecryptGrant`
        // against the legacy Wave 3 token proxy by default — wrong
        // contract for a YieldSnapshot handle, simulation reverts
        // with `0x`. See `decryptYieldEpochAggregateForView` natspec.
        fhe.decryptYieldEpochAggregateForView(epoch.encTotalYield),
        // Snapshot balance: same handle as MuHavenToken._balances at
        // snapshot time. Investor has ACL via the original mint —
        // decrypts via the per-RWA token path. The per-RWA
        // `tokenAddress` is required so the 403 fallback's
        // `refreshDecryptGrant` targets the right MuHavenToken
        // (TBILL1 / GOLD1) instead of the legacy Wave 3 default.
        fhe.decryptUint128ForView(
          snapshotBalanceHandle,
          item.token_address as `0x${string}`,
        ),
        // encTotalSupply: kernel + eph ACL granted by claimYield
        // (Round 3). For 1-investor case, alias to snapshotBalance to
        // skip the redundant TN round-trip. Same wrong-contract
        // hazard as encTotalYield above; same `decryptYieldEpochAggregateForView`
        // fix.
        supplyEqualsBalance
          ? Promise.resolve<bigint | null>(null)
          : fhe.decryptYieldEpochAggregateForView(epoch.encTotalSupply),
      ])
      const supply = supplyEqualsBalance ? snapshotBalance : (totalSupply as bigint)

      // Compute claim amount in JS, mirroring the contract's
      // floor-division order so the displayed value equals what
      // `trustedPayout` actually moved on-chain. Contract:
      //   encRatio  = floor(encTotalYield / encTotalSupply)
      //   encShare  = encBalance × encRatio       (no further /)
      //   encShare64 = asEuint64(encShare)        (truncates u64)
      // → JS:
      //   ratio = totalYield / supply             (BigInt floor)
      //   share = balance × ratio                 (matches encShare128)
      // Reordering to `(balance × totalYield) / supply` would over-
      // count by ≤ (supply-1) per share — a discrepancy a careful
      // user cross-checking against on-chain mhUSDC delta would spot.
      // Truncation to u64 is omitted: legitimate yields stay inside
      // u64 by construction (totalYield itself is u64-bounded by
      // PUSDC's width) and a pathological overflow is loud-better.
      if (supply === 0n) {
        throw new Error('Snapshot total supply is zero — cannot compute claim amount')
      }
      const ratio = totalYield / supply
      value = snapshotBalance * ratio
    } else {
      throw new Error(`No decrypt path for type=${item.type}`)
    }
    revealedAmounts[item.id] = value
  } catch (e) {
    decryptErrorById[item.id] = e instanceof Error ? e.message : 'Decrypt failed'
  } finally {
    delete decryptingById[item.id]
  }
}

async function refreshAmount(item: ActivityItemDto) {
  // Force a re-decrypt: clear the cache entry so `decryptAmount` runs
  // its full path (catches the case where the handle was rotated by a
  // contract upgrade between visits — rare, but defensive).
  delete revealedAmounts[item.id]
  await decryptAmount(item)
}

/**
 * Format a revealed audit amount for display. Cash rows (wrap/unwrap)
 * + yield-claim rows are mhUSDC base units (6 decimals → USD); transfer
 * rows are raw share counts per Wave 3.5 convention (1 share == 1n
 * on-chain). For transfer rows we also tack the symbol on so the row
 * reads "12 TBILL1" instead of just "12".
 */
function formatRevealedAmount(item: ActivityItemDto): string {
  const v = revealedAmounts[item.id]
  if (v === undefined) return ''
  if (isCashType(item.type) || isYieldClaimType(item.type)) {
    return formatUSD(Number(v) / 1e6)
  }
  // Transfer — raw share count.
  const sym = tokenSymbol(item.token_address)
  const numStr = Number(v).toLocaleString('en-US')
  return sym ? `${numStr} ${sym}` : numStr
}

onMounted(async () => {
  // Marketplace tokens give us symbol resolution for buy/sell/yield rows.
  // Don't await — we'd rather render activity instantly with truncated
  // addresses than block the page on the tokens fetch. The labels swap to
  // symbols reactively once the list lands.
  if (!marketplace.loaded) void marketplace.load()
  // Always refetch on mount. The previous `if (activity.loaded) return`
  // guard was an inbox-staleness footgun: a user who visits /activity
  // within the indexer's 15s polling window after a trade would see an
  // empty list, the store would latch `loaded=true`, and every revisit
  // would skip the refetch — even after the indexer had caught up. The
  // round-trip cost is tiny vs. an inbox showing nothing.
  await activity.load()
})

const showLoader = computed(() =>
  !activity.loaded && !activity.error && activity.loading,
)
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading activity"
      caption="Indexing on-chain events"
    />

    <!-- Error -->
    <div v-else-if="activity.error" class="flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ activity.error }}</p>
      <MButton variant="outline" @click="activity.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-6">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <!-- Timeline column -->
        <div class="lg:col-span-8 w-full flex flex-col gap-5">
          <!-- Filter pills -->
          <div class="flex items-center gap-2.5 overflow-x-auto pb-1 no-scrollbar">
            <button
              v-for="f in (['all', 'buy', 'sell', 'yield', 'cash', 'transfer'] as FilterType[])"
              :key="f"
              type="button"
              @click="activeFilter = f"
              :data-testid="`activity-filter-${f}`"
              :class="[
                'font-sans text-xs font-medium px-5 py-2 rounded-full whitespace-nowrap transition-all duration-200 cursor-pointer border',
                activeFilter === f
                  ? 'bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal border-gold/40 dark:border-signal/35 shadow-[0_0_12px_-2px_rgba(255,186,32,0.25)]'
                  : 'bg-mist/50 dark:bg-[#171717] text-cool hover:text-midnight dark:hover:text-white border-transparent hover:border-haze dark:hover:border-white/10',
              ]"
            >
              {{ filterMeta[f].label }}
              <span class="ml-1.5 opacity-70 tabular-nums">{{ filterCounts[f] }}</span>
            </button>
          </div>

          <!-- Timeline card -->
          <section
            v-motion
            :initial="{ opacity: 0, y: 20 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
            class="rounded-2xl border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717] overflow-hidden
                   shadow-[0_14px_40px_-12px_rgba(63,46,12,0.06)]
                   dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.55)]"
          >
            <!-- Empty -->
            <div
              v-if="filtered.length === 0"
              class="flex flex-col items-center py-16 gap-3"
              data-testid="activity-empty"
            >
              <Inbox :size="36" :stroke-width="1.4" class="text-cool/35" />
              <p class="font-sans text-sm text-cool">No matching activity</p>
            </div>

            <!-- Rows -->
            <div v-else class="flex flex-col">
              <div
                v-for="item in filtered"
                :key="item.id"
                :data-testid="`activity-row-${item.type}`"
                class="border-b border-haze/60 dark:border-white/5 last:border-b-0
                       hover:bg-mist/40 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div class="p-5 md:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div class="flex items-start sm:items-center gap-4 min-w-0">
                    <div
                      :class="[
                        'w-10 h-10 rounded-xl flex items-center justify-center border flex-shrink-0',
                        activityMeta[item.type].iconBg,
                        activityMeta[item.type].iconBorder,
                      ]"
                    >
                      <component
                        :is="activityMeta[item.type].icon"
                        :size="15"
                        :stroke-width="1.8"
                        :class="activityMeta[item.type].iconClass"
                      />
                    </div>
                    <div class="flex flex-col gap-1.5 min-w-0">
                      <div class="flex items-center gap-2.5 flex-wrap">
                        <span class="font-sans text-sm font-semibold text-midnight dark:text-white">
                          {{ rowTitle(item) }}
                        </span>

                        <!-- Cash + transfer rows: per-row Decrypt affordance.
                             Cash handles are mhUSDC euint64 base units;
                             transfer handles are euint128 raw share counts —
                             `decryptAmount` branches by type internally. -->
                        <!-- Decrypt only renders when the row actually
                             carries an audit handle. Pre-upgrade
                             YieldClaimed events lack the `amount` field
                             entirely (audit-handle slate landed
                             2026-05-03); their indexer rows have
                             metadata=null and the button stays hidden so
                             the user doesn't click into a silent no-op. -->
                        <template v-if="isDecryptableType(item.type) && item.metadata?.encrypted_amount_handle">
                          <button
                            v-if="revealedAmounts[item.id] === undefined"
                            type="button"
                            @click="decryptAmount(item)"
                            :disabled="!!decryptingById[item.id]"
                            :data-testid="`activity-${item.type}-decrypt-cta`"
                            class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md
                                   border border-haze dark:border-white/10
                                   bg-mist/40 dark:bg-white/[0.02]
                                   font-mono text-xs tabular-nums tracking-tight
                                   text-cool hover:text-compute dark:hover:text-signal
                                   hover:border-gold/40 dark:hover:border-signal/40
                                   transition-colors cursor-pointer
                                   disabled:opacity-60 disabled:cursor-wait"
                            :title="'Decrypt with permit · ' + (item.metadata?.encrypted_amount_handle ?? 'no handle')"
                          >
                            <Loader2
                              v-if="decryptingById[item.id]"
                              :size="11"
                              class="animate-spin"
                            />
                            <Eye v-else :size="11" :stroke-width="1.8" />
                            <!-- Cash + yield-claim rows show a USD bullet
                                 placeholder; transfer rows show a share-
                                 count bullet so the locked state hints
                                 at the unit. -->
                            <span v-if="isCashType(item.type) || isYieldClaimType(item.type)">$••••.••</span>
                            <span v-else>•••• {{ tokenSymbol(item.token_address) }}</span>
                          </button>
                          <span
                            v-else
                            class="inline-flex items-center gap-1.5 font-mono text-sm font-medium tabular-nums tracking-tight"
                            :class="activityMeta[item.type].amountClass"
                            :data-testid="`activity-${item.type}-amount`"
                          >
                            {{ formatRevealedAmount(item) }}
                            <ShieldCheck
                              :size="13"
                              :stroke-width="1.8"
                              class="text-gold dark:text-signal"
                            />
                            <button
                              type="button"
                              @click="refreshAmount(item)"
                              :disabled="!!decryptingById[item.id]"
                              :data-testid="`activity-${item.type}-refresh-cta`"
                              class="inline-flex items-center justify-center w-5 h-5 rounded
                                     text-cool hover:text-compute dark:hover:text-signal
                                     transition-colors cursor-pointer
                                     disabled:opacity-60 disabled:cursor-wait"
                              :title="'Re-decrypt amount'"
                            >
                              <Loader2
                                v-if="decryptingById[item.id]"
                                :size="11"
                                class="animate-spin"
                              />
                              <RefreshCw v-else :size="11" :stroke-width="1.8" />
                            </button>
                          </span>
                        </template>
                      </div>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span
                          :class="[
                            'font-sans text-[9px] uppercase tracking-[0.22em] font-semibold px-2 py-0.5 rounded border',
                            statusAccent(statusLabel(item)).text,
                            statusAccent(statusLabel(item)).ring,
                            statusAccent(statusLabel(item)).bg,
                          ]"
                        >
                          {{ statusLabel(item) }}
                        </span>
                        <div
                          class="flex items-center gap-1 px-2 py-0.5 rounded border border-haze dark:border-white/10 bg-mist/50 dark:bg-[#0d0e10]"
                        >
                          <Lock :size="10" :stroke-width="1.8" class="text-cool" />
                          <span class="font-mono text-[9px] text-cool uppercase tracking-[0.18em]">FHE encrypted</span>
                        </div>
                        <span
                          v-if="decryptErrorById[item.id]"
                          class="font-mono text-[10px] text-negative"
                        >{{ decryptErrorById[item.id] }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="flex items-center gap-4 sm:flex-shrink-0 pl-14 sm:pl-0">
                    <span class="font-sans text-[11px] text-cool whitespace-nowrap tabular-nums">
                      {{ formatTime(item.timestamp) }}
                    </span>
                    <button
                      type="button"
                      @click="toggleExpand(item.id)"
                      :data-testid="`activity-row-toggle-${item.id}`"
                      :aria-expanded="expandedId === item.id"
                      :aria-controls="`activity-proof-${item.id}`"
                      class="flex items-center gap-1 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                             text-compute dark:text-signal hover:text-compute/80 dark:hover:text-signal/80
                             transition-colors cursor-pointer"
                    >
                      <span>Proof</span>
                      <ChevronDown
                        :size="13"
                        :stroke-width="2"
                        aria-hidden="true"
                        :class="['transition-transform duration-200', expandedId === item.id && 'rotate-180']"
                      />
                    </button>
                  </div>
                </div>

                <!-- Expanded privacy proof -->
                <transition
                  enter-active-class="transition-opacity duration-300 ease-out"
                  leave-active-class="transition-opacity duration-200 ease-in"
                  enter-from-class="opacity-0"
                  leave-to-class="opacity-0"
                >
                  <div
                    v-if="expandedId === item.id"
                    :id="`activity-proof-${item.id}`"
                    role="region"
                    :aria-label="`Privacy proof for ${item.type} event`"
                    class="px-5 md:px-6 pb-5 md:pb-6 sm:pl-20"
                  >
                    <MPrivacyProofPanel :tx-hash="item.tx_hash" :default-open="true" />
                  </div>
                </transition>
              </div>
            </div>

            <!-- Load more footer -->
            <div
              v-if="activity.hasMore"
              class="bg-mist/50 dark:bg-[#0d0e10] p-4 flex justify-center border-t border-haze dark:border-white/5"
            >
              <button
                type="button"
                :disabled="activity.loadingMore"
                @click="activity.loadMore()"
                data-testid="activity-load-more"
                class="flex items-center gap-2 px-6 py-2.5 rounded-lg
                       border border-haze dark:border-white/10
                       font-sans text-xs uppercase tracking-[0.2em] font-semibold
                       text-cool hover:text-compute dark:hover:text-signal
                       hover:border-gold/40 dark:hover:border-signal/40
                       transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                <Loader2
                  v-if="activity.loadingMore"
                  :size="13"
                  class="animate-spin text-compute dark:text-signal"
                />
                <span v-else class="w-2 h-2 rounded-full bg-compute/60 dark:bg-signal/60 animate-pulse" />
                <span>{{ activity.loadingMore ? 'Loading…' : 'Load more' }}</span>
              </button>
            </div>
          </section>
        </div>

        <!-- Analytics column -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 200 } }"
          class="lg:col-span-4 w-full flex flex-col gap-4 lg:sticky lg:top-24"
        >
          <h3 class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold px-1">
            System Overview
          </h3>

          <!-- Total events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold">
                Total Events
              </span>
              <div class="w-11 h-11 rounded-xl bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center">
                <BarChart3 :size="18" :stroke-width="1.8" class="text-compute dark:text-signal" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ activity.items.length }}
            </div>
            <div class="w-full bg-haze/50 dark:bg-white/8 h-1.5 rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-gold to-signal dark:from-signal dark:to-gold rounded-full transition-all duration-700"
                :style="{ width: `${Math.min(activity.items.length * 6, 100)}%` }"
              />
            </div>
          </div>

          <!-- Yield events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-positive font-semibold">
                Yield Claims
              </span>
              <div class="w-11 h-11 rounded-xl bg-positive/10 border border-positive/30 flex items-center justify-center">
                <Coins :size="18" :stroke-width="1.8" class="text-positive" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ filterCounts.yield }}
            </div>
            <div class="flex items-center gap-1.5">
              <TrendingUp :size="14" :stroke-width="1.8" class="text-positive" />
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold text-positive tabular-nums">
                {{ yieldsThisWeek }} this week
              </span>
            </div>
          </div>

          <!-- Cash events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold">
                Cash conversions
              </span>
              <div class="w-11 h-11 rounded-xl bg-compute/10 dark:bg-signal/10 border border-compute/25 dark:border-signal/25 flex items-center justify-center">
                <ArrowRightLeft :size="18" :stroke-width="1.8" class="text-compute dark:text-signal" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ filterCounts.cash }}
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold text-cool italic">
              {{ cashEventsThisWeek }} this week · auditable on click
            </p>
          </div>

          <!-- Transfer events (Phase 9.A · Option Z follow-up) -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold">
                P2P transfers
              </span>
              <div class="w-11 h-11 rounded-xl bg-haze/40 dark:bg-white/5 border border-haze dark:border-white/10 flex items-center justify-center">
                <Send :size="18" :stroke-width="1.8" class="text-cool" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ filterCounts.transfer }}
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold text-cool italic">
              {{ transferEventsThisWeek }} this week · amount on click
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
