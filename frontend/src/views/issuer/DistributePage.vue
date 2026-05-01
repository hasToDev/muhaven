<script setup lang="ts">
import { ref, onMounted, computed, watch, useTemplateRef } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useIssuerDistributionStore } from '@/stores/issuer-distribution'
import { useWallet } from '@/composables/useWallet'
import { useWalletStore } from '@/stores/wallet'
import { useFhe } from '@/composables/useFhe'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import * as SnapshotService from '@/services/v35/SnapshotService'
import { arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  CheckCircle2, AlertTriangle, Eye, Loader2, RefreshCw, ChevronDown, Check,
  Users, Landmark, Lock, ArrowRight, Coins, ChevronRight, ShieldCheck,
  KeyRound, TrendingUp, Receipt, Clock,
} from 'lucide-vue-next'
import type { EpochView } from '@muhaven/sdk'

// DistributePage — Wave 3.5 (Phase 9.A · /distribute rewrite). Wraps the
// `YieldSnapshot` lifecycle: open → snapshot (paginated) → finalize →
// fund. Replaces the legacy push-based escrow path that's being retired
// post-earlybot merge. Three-agent co-spec (UX Researcher / UX Architect
// / UI Designer) — see DEV_LOG.md continuation 10.
//
// Design priorities:
// - One UX, not two: production wizard with sensible auto-defaults is
//   the dev-test path. No hidden test-mode button.
// - Resume from on-chain: detectInFlight + sessionStorage so a reload
//   mid-distribution recovers cleanly. The contract is the source of
//   truth; sessionStorage is a tab-continuity convenience.
// - Mental model: closing the books on a period (accounting-shaped),
//   not transfer-shaped. mhUSDC reads as operating cash.

const tokenStore = useIssuerTokensStore()
const distributionStore = useIssuerDistributionStore()
const { address: walletAddress, connected } = useWallet()
const walletStore = useWalletStore()
const fhe = useFhe()

// ── Form state ─────────────────────────────────────────────────────────

const selectedToken = ref<Address | ''>('')
const amount = ref('')
const tokenDropdownOpen = ref(false)
const tokenDropdownRef = useTemplateRef<HTMLDivElement>('tokenDropdownRef')
onClickOutside(tokenDropdownRef, () => { tokenDropdownOpen.value = false })

const showReceipt = ref(false)
const receiptData = ref<{
  token: string
  amount: string
  epochId: string
  holders: number
  claimExpiry: string
  txHash: string | null
}>({
  token: '',
  amount: '',
  epochId: '',
  holders: 0,
  claimExpiry: '',
  txHash: null,
})

// ── Preflight state ────────────────────────────────────────────────────

const preflightStatus = ref<SnapshotService.PreflightStatus | null>(null)
const preflightLoading = ref(false)
const preflightExpanded = ref(false)
const preflightError = ref<string | null>(null)

// mhUSDC balance reveal state (issuer's own balance)
const mhUsdcBalance = ref<bigint | null>(null)
const mhUsdcDecrypting = ref(false)
const mhUsdcLoading = ref(false)

// ── Recent epochs strip ────────────────────────────────────────────────

interface RecentEpochRow {
  snapshotAddress: Address
  epochId: bigint
  epoch: EpochView
  tokenSymbol: string
  tokenName: string
}
const recentEpochs = ref<RecentEpochRow[]>([])
const recentEpochsLoading = ref(false)

// ── Steps ──────────────────────────────────────────────────────────────

const STEPS = [
  { label: 'Open', description: 'Allocate epoch' },
  { label: 'Snapshot', description: 'Capture holders' },
  { label: 'Finalize', description: 'Lock the snapshot' },
  { label: 'Fund', description: 'mhUSDC → epoch' },
  { label: 'Done', description: 'Holders can claim' },
] as const

// ── Computeds ──────────────────────────────────────────────────────────

const activeTokens = computed(() =>
  tokenStore.tokens.filter(t => t.status === 'active'),
)

const selectedTokenInfo = computed(() =>
  tokenStore.tokens.find(t => t.address === selectedToken.value),
)

const amountUnits = computed<bigint>(() => {
  const v = amount.value.trim()
  if (!v) return 0n
  const [whole = '0', frac = ''] = v.split('.')
  const fracPadded = (frac + '000000').slice(0, 6)
  const wholeBI = BigInt(whole.replace(/\D/g, '') || '0')
  const fracBI = BigInt(fracPadded.replace(/\D/g, '') || '0')
  return wholeBI * 1_000_000n + fracBI
})

const amountValid = computed(() => amountUnits.value > 0n)

const holderTotal = computed(() => preflightStatus.value?.holderCount ?? 0)
const batchCountPreview = computed(() =>
  Math.max(1, Math.ceil(holderTotal.value / 50)),
)

const mhUsdcShortfall = computed<bigint>(() => {
  if (mhUsdcBalance.value === null) return 0n
  if (mhUsdcBalance.value >= amountUnits.value) return 0n
  return amountUnits.value - mhUsdcBalance.value
})

const allPreflightGreen = computed(() => {
  const p = preflightStatus.value
  if (!p) return false
  // Green = no shortfall (or balance unrevealed but trusted) AND both
  // operator approvals in place. We DO want to nag if balance < amount.
  const balanceOk = mhUsdcBalance.value === null
    ? true  // unrevealed — assume green; the wizard will auto-wrap if short
    : mhUsdcBalance.value >= amountUnits.value
  return balanceOk
    && p.legacyToWrapperOperatorOk
    && p.wrapperToSnapshotOperatorOk
    && holderTotal.value > 0
})

const canDistribute = computed(() =>
  selectedToken.value
    && amountValid.value
    && holderTotal.value > 0
    && !distributionStore.isProcessing,
)

// ── Mount + reactivity ─────────────────────────────────────────────────

const showLoader = computed(() =>
  !tokenStore.loaded && !tokenStore.error && tokenStore.loading,
)

onMounted(async () => {
  if (!tokenStore.loaded) await tokenStore.load()
  if (activeTokens.value.length > 0 && !selectedToken.value) {
    selectedToken.value = activeTokens.value[0].address as Address
  }
  // Hydrate any in-flight distribution from sessionStorage + on-chain.
  if (walletAddress.value) {
    await distributionStore.hydrate(walletAddress.value as Address)
    // If a sessionStorage record snapped us into a non-idle phase,
    // expose it on the form so the user can resume; the wizard renders
    // from `distributionStore.phase`.
    if (distributionStore.phase !== 'idle') {
      selectedToken.value = distributionStore.tokenAddress!
      amount.value = (Number(distributionStore.totalYieldUnits) / 1_000_000).toString()
    }
  }
  // Recent epochs strip
  loadRecentEpochs()
})

watch(selectedToken, async (next) => {
  preflightStatus.value = null
  mhUsdcBalance.value = null
  preflightError.value = null
  if (next && walletAddress.value) await runPreflight()
})

watch(() => walletAddress.value, async (next) => {
  if (next && selectedToken.value) await runPreflight()
})

// Suggest a sensible default amount once preflight resolves: the entire
// revealed mhUSDC balance, divided by holder count if > 0. The user can
// edit. Skipped when the user has typed something or when the balance
// hasn't been revealed yet (we don't auto-decrypt — that's a passkey).
watch([mhUsdcBalance, holderTotal], ([bal, holders]) => {
  if (amount.value !== '' || !bal || holders === 0) return
  // Heuristic: 1% of balance, or balance if very small. Avoids defaulting
  // a real issuer's full mhUSDC float; demo / dev kernels with small
  // balances won't notice.
  const suggested = bal > 100_000_000n ? bal / 100n : bal
  amount.value = (Number(suggested) / 1_000_000).toFixed(2)
})

// ── Preflight ──────────────────────────────────────────────────────────

async function runPreflight() {
  if (!selectedToken.value || !walletAddress.value) return
  // In-flight guard — onMounted + the selectedToken/walletAddress
  // watchers can both fire `runPreflight()` if both flip in the same
  // tick. Without the guard, concurrent runs clobber the response.
  if (preflightLoading.value) return
  preflightLoading.value = true
  preflightError.value = null
  try {
    preflightStatus.value = await SnapshotService.preflight(
      walletAddress.value as Address,
      selectedToken.value as Address,
    )
    // Auto-expand if anything is off.
    if (
      !preflightStatus.value.legacyToWrapperOperatorOk
      || !preflightStatus.value.wrapperToSnapshotOperatorOk
      || preflightStatus.value.holderCount === 0
    ) {
      preflightExpanded.value = true
    }
  } catch (e) {
    preflightError.value = e instanceof Error ? e.message : 'Preflight failed'
  } finally {
    preflightLoading.value = false
  }
}

async function decryptMhUsdc() {
  if (!walletAddress.value || mhUsdcDecrypting.value) return
  if (!preflightStatus.value) return
  mhUsdcDecrypting.value = true
  try {
    await fhe.initialize()
    mhUsdcBalance.value = await fhe.decryptMhUsdcForView(
      preflightStatus.value.mhUsdcHandle,
    )
  } catch (e) {
    toast.error('mhUSDC decrypt failed', {
      description: e instanceof Error ? e.message : 'Unknown error',
    })
  } finally {
    mhUsdcDecrypting.value = false
  }
}

async function refreshMhUsdcAndPreflight() {
  if (!walletAddress.value || mhUsdcLoading.value) return
  mhUsdcLoading.value = true
  // Drop the revealed value so the row collapses back to the locked
  // state on refresh — user opts in again if they want to re-decrypt.
  // Skip the collapse if the user prefers persistence: the alternative
  // is to silently re-decrypt, which costs a fresh permit signature.
  try {
    await runPreflight()
    mhUsdcBalance.value = null
  } finally {
    mhUsdcLoading.value = false
  }
}

// ── Recent epochs ──────────────────────────────────────────────────────

async function loadRecentEpochs() {
  if (tokenStore.tokens.length === 0) return
  recentEpochsLoading.value = true
  try {
    const issuerTokens = tokenStore.tokens.map(t => t.address as Address)
    const raw = await SnapshotService.loadRecentEpochs(issuerTokens, 10)
    recentEpochs.value = raw.map((r) => {
      const meta = tokenStore.tokens.find(
        t => t.address.toLowerCase() === r.epoch.token.toLowerCase(),
      )
      return {
        snapshotAddress: r.snapshotAddress,
        epochId: r.epochId,
        epoch: r.epoch,
        tokenSymbol: meta?.symbol ?? r.epoch.token.slice(0, 8),
        tokenName: meta?.name ?? 'Unknown token',
      }
    })
  } catch {
    // Recent strip is non-blocking
  } finally {
    recentEpochsLoading.value = false
  }
}

// ── Distribution orchestration ─────────────────────────────────────────

async function handleDistribute() {
  if (!canDistribute.value) return
  if (!connected.value || !walletAddress.value) {
    toast.error('Wallet not connected', {
      description: 'Sign in with your passkey to distribute yield',
    })
    return
  }
  const account = walletAddress.value as Address
  const token = selectedToken.value as Address
  const snapshotAddr = SnapshotService.snapshotProxyFor(token)
  if (!snapshotAddr) {
    toast.error('Snapshot proxy not configured', {
      description: 'This token has no YieldSnapshot proxy in the deployment file',
    })
    return
  }

  preflightError.value = null

  try {
    // Phase 1: preflight grants + auto-wrap.
    if (!preflightStatus.value) {
      await runPreflight()
    }
    const p = preflightStatus.value
    if (!p) throw new Error('Preflight not ready')
    if (p.holderCount === 0) {
      throw new Error(
        `No holders for ${selectedTokenInfo.value?.symbol ?? 'this token'} yet — mint MuHavenToken to a KYC-approved address first`,
      )
    }

    // Auto-decrypt mhUSDC if the user hasn't revealed it yet. We need a
    // ground-truth balance to know whether to auto-wrap — without this,
    // an unrevealed under-funded issuer would hit fundEpoch's silent-fail
    // path (`_silentFailBound` returns zero) and every claim would
    // silent-fail to zero too. Per the blocker note in
    // `scripts/run-yield-epoch.ts` (Phase 8 / ADR-041 preflight wrap).
    if (mhUsdcBalance.value === null) {
      await fhe.initialize()
      mhUsdcBalance.value = await fhe.decryptMhUsdcForView(p.mhUsdcHandle)
    }

    // Operator approvals — silent via session key (added this phase).
    // legacy → wrapper grant: only needed for the auto-wrap step. Grant
    // when we KNOW we'll wrap; otherwise skip.
    const balance = mhUsdcBalance.value
    const needsWrap = balance < amountUnits.value
    if (needsWrap && !p.legacyToWrapperOperatorOk) {
      await SnapshotService.grantLegacyToWrapperOperator()
    }
    if (!p.wrapperToSnapshotOperatorOk) {
      await SnapshotService.grantWrapperToSnapshotOperator(snapshotAddr)
    }
    if (needsWrap) {
      const eph = fhe.getEphemeralEOA() as Address
      await SnapshotService.autoWrapForDistribution(
        amountUnits.value - balance,
        eph,
      )
    }

    // Phase 2: kick off the wizard.
    distributionStore.start({
      token,
      snapshotAddr,
      totalYieldUnits: amountUnits.value,
      holderTotal: p.holderCount,
    })

    // Phase 3: drive the lifecycle. Each phase persists to sessionStorage
    // before the next; a reload during snapshotting picks up where it
    // left off.
    await distributionStore.runDistribution(account)

    if (distributionStore.phase === 'done' && distributionStore.epochId !== null) {
      const epoch = await SnapshotService.detectInFlight(token)
      receiptData.value = {
        token: selectedTokenInfo.value?.symbol ?? '',
        amount: amount.value,
        epochId: distributionStore.epochId.toString(),
        holders: p.holderCount,
        claimExpiry: epoch
          ? new Date(Number(epoch.epoch.claimExpiry) * 1000).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })
          : '—',
        txHash: distributionStore.lastTxHash,
      }
      showReceipt.value = true
      toast.success('Distribution complete', {
        description: `Epoch #${distributionStore.epochId} funded — investors can pull-claim from /yields`,
      })
      // Refresh side state.
      mhUsdcBalance.value = null
      await runPreflight()
      await loadRecentEpochs()
    } else if (distributionStore.phase === 'error') {
      toast.error('Distribution failed', {
        description: distributionStore.errorMessage ?? 'Unknown error',
      })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Distribution failed'
    preflightError.value = msg
    toast.error('Distribution failed', { description: msg })
  }
}

async function resumeDistribution() {
  if (!walletAddress.value) return
  await distributionStore.runDistribution(walletAddress.value as Address)
  if (distributionStore.phase === 'done' && distributionStore.epochId !== null) {
    const epoch = await SnapshotService.detectInFlight(distributionStore.tokenAddress!)
    receiptData.value = {
      token: selectedTokenInfo.value?.symbol ?? '',
      amount: amount.value,
      epochId: distributionStore.epochId.toString(),
      holders: distributionStore.holderTotal,
      claimExpiry: epoch
        ? new Date(Number(epoch.epoch.claimExpiry) * 1000).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        })
        : '—',
      txHash: distributionStore.lastTxHash,
    }
    showReceipt.value = true
    await loadRecentEpochs()
  }
}

function pickToken(addr: string) {
  selectedToken.value = addr as Address
  tokenDropdownOpen.value = false
}

function resetForm() {
  showReceipt.value = false
  amount.value = ''
  distributionStore.reset()
}

function epochStatusLabel(epoch: EpochView): string {
  if (epoch.funded) return 'funded'
  if (epoch.finalized) return 'awaiting funds'
  return 'snapshotting'
}

function epochAccentClass(epoch: EpochView) {
  if (epoch.funded) return 'bg-positive/15 text-positive border-positive/30'
  if (epoch.finalized) return 'bg-gold/15 text-gold border-gold/30 dark:bg-signal/15 dark:text-signal dark:border-signal/30'
  return 'bg-cool/15 text-cool border-haze dark:border-white/10'
}

function fmtClaimWindow(claimExpiry: bigint): string {
  const ms = Number(claimExpiry) * 1000
  const days = Math.max(0, Math.ceil((ms - Date.now()) / (24 * 3600 * 1000)))
  if (days === 0) return 'window closed'
  return `${days}d remaining`
}
</script>

<template>
  <div>
    <MPageLoader
      v-if="showLoader"
      label="Loading issuer data"
      caption="Reading tokens + on-chain state"
    />

    <div v-else class="flex flex-col gap-6">
      <!-- Privacy proof hero strip — matches /yields language -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460, delay: 60 } }"
        data-testid="distribute-privacy-proof"
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
              How a yield epoch works here
            </p>
            <p class="font-sans text-[13px] leading-relaxed text-midnight/80 dark:text-white/80">
              Open an epoch, snapshot holders, finalize the snapshot, fund it from
              <span class="font-mono text-compute dark:text-signal">mhUSDC</span>.
              You see totals only — per-investor shares stay encrypted.
              Investors pull-claim from /yields when they're ready; you don't
              gate or sign their claims.
            </p>
          </div>
        </div>
      </section>

      <!-- mhUSDC liquidity strip -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460, delay: 100 } }"
        data-testid="distribute-mhusdc-strip"
        class="relative overflow-hidden rounded-2xl p-6 md:p-7
               border border-haze dark:border-white/5
               bg-white dark:bg-[#171717]"
      >
        <div
          aria-hidden="true"
          class="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-[80px] pointer-events-none
                 bg-gold/10 dark:bg-signal/8"
        />
        <div class="relative z-10 flex items-start justify-between flex-wrap gap-5">
          <div class="flex items-start gap-6 flex-wrap">
            <div>
              <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-1.5">
                Available mhUSDC
              </p>
              <p class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight leading-none min-h-[2.5rem] flex items-center">
                <template v-if="mhUsdcBalance !== null">
                  {{ formatUSD(Number(mhUsdcBalance) / 1e6) }}
                  <ShieldCheck :size="20" :stroke-width="1.8" class="ml-2 text-compute dark:text-signal" />
                </template>
                <span v-else class="inline-flex items-center gap-2 text-cool/60">
                  <Lock :size="16" :stroke-width="1.8" />
                  <span class="font-sans not-italic text-sm tracking-tight">$••••.••</span>
                </span>
              </p>
              <p
                v-if="mhUsdcBalance === null"
                class="font-sans text-[11px] text-cool mt-1.5"
              >Encrypted · click Reveal to decrypt</p>
              <p
                v-else
                class="font-sans text-[11px] text-cool mt-1.5"
              >Decrypted in this session</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="mhUsdcBalance === null"
              type="button"
              @click="decryptMhUsdc"
              :disabled="mhUsdcDecrypting || preflightLoading || !preflightStatus"
              data-testid="distribute-mhusdc-reveal"
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                     text-compute dark:text-signal
                     border border-compute/30 dark:border-signal/30
                     hover:text-white dark:hover:text-[#412d00]
                     hover:bg-compute dark:hover:bg-signal
                     px-4 py-2 rounded transition-all duration-200 cursor-pointer
                     disabled:opacity-60 disabled:cursor-wait disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:hover:text-compute dark:disabled:hover:text-signal"
            >
              <Loader2 v-if="mhUsdcDecrypting" :size="11" class="animate-spin" />
              <Eye v-else :size="11" :stroke-width="2" />
              {{ mhUsdcDecrypting ? 'Decrypting…' : 'Reveal mhUSDC' }}
            </button>
            <button
              type="button"
              @click="refreshMhUsdcAndPreflight"
              :disabled="mhUsdcLoading"
              data-testid="distribute-mhusdc-refresh"
              class="p-2 rounded border border-haze dark:border-white/10 text-cool
                     hover:text-compute dark:hover:text-signal
                     hover:border-gold/40 dark:hover:border-signal/40
                     transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              title="Refresh state (re-runs preflight + clears revealed balance)"
            >
              <Loader2 v-if="mhUsdcLoading || preflightLoading" :size="13" class="animate-spin" />
              <RefreshCw v-else :size="13" :stroke-width="1.8" />
            </button>
          </div>
        </div>
      </section>

      <!-- Stepper -->
      <section
        v-if="distributionStore.isProcessing || distributionStore.phase === 'error' || showReceipt"
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 360 } }"
        data-testid="distribute-stepper"
        class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#1c1b1b]/30 backdrop-blur-md py-4 px-6"
      >
        <div class="flex items-center justify-between max-w-3xl mx-auto">
          <template v-for="(s, i) in STEPS" :key="s.label">
            <div class="flex flex-col items-center gap-1.5 min-w-[60px]">
              <div
                :class="[
                  'h-7 w-7 rounded-full flex items-center justify-center transition-all duration-300',
                  i < distributionStore.stepperIndex
                    ? 'bg-gold/15 dark:bg-signal/15 border border-gold/40 dark:border-signal/40 text-compute dark:text-signal'
                    : i === distributionStore.stepperIndex
                      ? 'bg-gold dark:bg-signal text-midnight shadow-[0_0_14px_rgba(255,186,32,0.45)] dark:shadow-[0_0_14px_rgba(255,220,161,0.4)]'
                      : 'bg-white dark:bg-[#171717] border border-haze dark:border-white/15 text-cool',
                  i === distributionStore.stepperIndex && distributionStore.isProcessing && 'animate-pulse',
                ]"
              >
                <Check v-if="i < distributionStore.stepperIndex" :size="13" :stroke-width="2.5" />
                <span v-else class="font-sans text-[10px] font-bold tabular-nums">{{ i + 1 }}</span>
              </div>
              <span
                :class="[
                  'font-sans text-[9px] uppercase tracking-[0.22em] text-center font-semibold transition-colors',
                  i < distributionStore.stepperIndex
                    ? 'text-compute dark:text-signal'
                    : i === distributionStore.stepperIndex
                      ? 'text-gold dark:text-signal font-bold'
                      : 'text-cool/60',
                ]"
              >{{ s.label }}</span>
              <!-- Inline snapshot sub-progress -->
              <div
                v-if="i === 1 && distributionStore.phase === 'snapshotting' && distributionStore.holderTotal > 0"
                data-testid="distribute-snapshot-progress"
                class="mt-1 w-32 flex flex-col gap-1"
              >
                <span class="font-mono text-[9px] text-cool tabular-nums text-center">
                  {{ distributionStore.holderProcessed }}/{{ distributionStore.holderTotal }}
                </span>
                <div class="h-1 bg-white dark:bg-white/8 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-gradient-to-r from-gold to-signal dark:from-signal dark:to-gold rounded-full transition-all duration-300"
                    :style="{ width: `${distributionStore.holderTotal === 0 ? 0 : (distributionStore.holderProcessed / distributionStore.holderTotal) * 100}%` }"
                  />
                </div>
                <span
                  v-if="distributionStore.batchCount > 0"
                  class="font-mono text-[9px] text-cool/70 text-center"
                >batch {{ distributionStore.batchIndex }}/{{ distributionStore.batchCount }}</span>
              </div>
            </div>
            <div
              v-if="i < STEPS.length - 1"
              aria-hidden="true"
              :class="[
                'flex-1 h-px mx-2 transition-colors mt-3',
                i < distributionStore.stepperIndex
                  ? 'bg-gold/40 dark:bg-signal/40'
                  : 'bg-haze dark:bg-white/10',
              ]"
            />
          </template>
        </div>
      </section>

      <!-- Wizard panel -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 200 } }"
        class="relative overflow-hidden rounded-2xl
               border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-xl
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div aria-hidden="true"
             class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none bg-gold/10 dark:bg-signal/8" />

        <div class="relative z-10 flex flex-col">
          <!-- Receipt -->
          <div
            v-if="showReceipt"
            data-testid="distribute-receipt"
            class="flex flex-col items-center gap-6 p-8 md:p-10"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Epoch funded
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                {{ receiptData.holders }} holders snapshotted ·
                <span class="font-medium text-compute dark:text-signal">mhUSDC</span>
                pulled atomically from the issuer wallet.
              </p>
            </div>
            <div class="w-full max-w-xl rounded-xl border border-haze dark:border-white/5 bg-mist/50 dark:bg-[#0d0e10] p-6 space-y-3.5">
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Epoch ID</span>
                <span data-testid="distribute-receipt-epoch-id" class="font-mono text-sm text-midnight dark:text-white">
                  #{{ receiptData.epochId }}
                </span>
              </div>
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Token</span>
                <span class="font-sans text-sm font-medium text-midnight dark:text-white">{{ receiptData.token }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Total amount</span>
                <span class="font-mono text-sm text-midnight dark:text-white">${{ receiptData.amount }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Holders</span>
                <span class="font-sans text-sm font-medium text-midnight dark:text-white">{{ receiptData.holders }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Claim window</span>
                <span data-testid="distribute-receipt-claim-window" class="font-sans text-sm font-medium text-compute dark:text-signal">
                  Open until {{ receiptData.claimExpiry }}
                </span>
              </div>
              <div
                v-if="receiptData.txHash"
                class="flex justify-between items-center border-t border-haze/60 dark:border-white/5 pt-3.5"
              >
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Fund tx</span>
                <a
                  :href="arbiscanTx(receiptData.txHash)"
                  target="_blank"
                  rel="noopener"
                  class="font-mono text-xs text-compute dark:text-signal hover:underline"
                >
                  {{ receiptData.txHash.slice(0, 10) }}…
                </a>
              </div>
            </div>
            <p class="font-sans text-[11px] text-cool italic text-center max-w-md">
              Investors will pull-claim on /yields when they're ready — you don't
              gate or sign their claims, and per-investor shares stay encrypted.
            </p>
            <span
              class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border
                     border-compute/25 dark:border-signal/25
                     bg-compute/8 dark:bg-signal/10
                     text-compute dark:text-signal
                     font-sans text-[10px] uppercase tracking-[0.22em] font-semibold"
            >
              <Lock :size="11" :stroke-width="1.8" />
              You see totals only · per-investor shares stay encrypted
            </span>
            <MButton variant="outline" @click="resetForm">New distribution</MButton>
          </div>

          <!-- Error state with retry -->
          <div
            v-else-if="distributionStore.phase === 'error'"
            data-testid="distribute-error"
            class="flex flex-col items-center gap-5 p-8 md:p-10"
          >
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <AlertTriangle :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">
              Distribution paused
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-lg">
              {{ distributionStore.errorMessage ?? 'Unknown error' }}
            </p>
            <p
              v-if="distributionStore.epochId !== null"
              class="font-sans text-[12px] text-cool/80 text-center max-w-md"
            >
              Epoch <span class="font-mono text-midnight dark:text-white">#{{ distributionStore.epochId }}</span>
              is partway through ·
              {{ distributionStore.holderProcessed }}/{{ distributionStore.holderTotal }} holders snapshotted.
              Resume continues from where it stopped.
            </p>
            <div class="flex gap-3">
              <MButton variant="outline" @click="resetForm">Cancel</MButton>
              <MButton variant="primary" @click="resumeDistribution" data-testid="distribute-resume-cta">
                Resume distribution
              </MButton>
            </div>
          </div>

          <!-- Form -->
          <template v-else>
            <!-- Header bar -->
            <div class="px-6 py-4 border-b border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex items-center justify-between gap-3">
              <div class="flex flex-col">
                <h3 class="font-sans font-bold text-base text-midnight dark:text-white tracking-tight">
                  Yield Epoch
                </h3>
                <p class="font-sans text-[10px] text-cool mt-0.5">
                  Close the books on a period · pull-based per ADR-005
                </p>
              </div>
              <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-haze dark:border-white/10 bg-white dark:bg-[#0e0e0e]">
                <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-positive font-semibold">FHE Active</span>
              </div>
            </div>

            <!-- Body -->
            <div class="p-6 flex flex-col gap-6">
              <!-- Asset selector -->
              <div class="flex flex-col gap-2">
                <label class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Asset
                </label>
                <div ref="tokenDropdownRef" class="relative">
                  <button
                    type="button"
                    @click="tokenDropdownOpen = !tokenDropdownOpen"
                    :disabled="distributionStore.isProcessing"
                    :aria-expanded="tokenDropdownOpen"
                    aria-haspopup="listbox"
                    data-testid="distribute-token-select"
                    class="w-full flex items-center justify-between gap-3 rounded-lg px-4 py-3
                           bg-white dark:bg-[#0e0e0e]
                           border border-haze dark:border-white/10
                           hover:border-gold/40 dark:hover:border-signal/40
                           transition-colors cursor-pointer
                           disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div class="flex items-center gap-3 min-w-0">
                      <div class="h-8 w-8 rounded-full flex-shrink-0 bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center text-compute dark:text-signal">
                        <Landmark :size="14" :stroke-width="1.8" />
                      </div>
                      <span class="font-sans font-semibold text-sm text-midnight dark:text-white truncate">
                        <template v-if="selectedTokenInfo">
                          {{ selectedTokenInfo.symbol }}
                          <span class="font-normal text-cool">· {{ selectedTokenInfo.name }}</span>
                        </template>
                        <template v-else>Choose a token…</template>
                      </span>
                    </div>
                    <ChevronDown
                      :size="16"
                      :stroke-width="1.8"
                      aria-hidden="true"
                      :class="['text-cool transition-transform flex-shrink-0', tokenDropdownOpen && 'rotate-180']"
                    />
                  </button>
                  <ul
                    v-if="tokenDropdownOpen"
                    role="listbox"
                    class="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg overflow-hidden
                           bg-white dark:bg-[#1f1e1e]
                           border border-haze dark:border-white/10
                           shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)]
                           dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.65)]"
                  >
                    <li v-for="t in activeTokens" :key="t.address">
                      <button
                        type="button"
                        role="option"
                        :aria-selected="t.address === selectedToken"
                        @click="pickToken(t.address)"
                        class="w-full text-left flex items-center gap-3 px-4 py-3
                               hover:bg-mist/50 dark:hover:bg-white/[0.04]
                               transition-colors cursor-pointer"
                      >
                        <div class="h-7 w-7 rounded-full flex-shrink-0 bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center text-compute dark:text-signal">
                          <Landmark :size="12" :stroke-width="1.8" />
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="font-sans font-semibold text-sm text-midnight dark:text-white truncate">
                            {{ t.symbol }}
                          </div>
                          <div class="font-sans text-[11px] text-cool truncate">{{ t.name }}</div>
                        </div>
                        <Check
                          v-if="t.address === selectedToken"
                          :size="14"
                          :stroke-width="2.2"
                          class="text-compute dark:text-signal flex-shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  </ul>
                </div>
              </div>

              <!-- Empty state for cold issuer (no holders) -->
              <div
                v-if="preflightStatus && preflightStatus.holderCount === 0"
                data-testid="distribute-empty-no-holders"
                class="rounded-xl p-6 border border-haze dark:border-white/5 bg-mist/30 dark:bg-white/[0.02] flex items-start gap-4"
              >
                <div class="w-12 h-12 rounded-full bg-gold/12 dark:bg-signal/12 flex items-center justify-center flex-shrink-0">
                  <Users :size="20" :stroke-width="1.6" class="text-compute dark:text-signal" />
                </div>
                <div class="min-w-0 flex-1">
                  <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                    No holders yet for {{ selectedTokenInfo?.symbol ?? 'this token' }}.
                  </p>
                  <p class="font-sans text-[12px] text-cool mt-1.5 leading-relaxed max-w-md">
                    An epoch needs at least one KYC-approved holder. Mint
                    <span class="font-mono text-midnight dark:text-white">MuHavenToken</span>
                    to a whitelisted address, then return here.
                  </p>
                  <div class="mt-3 flex gap-3">
                    <MButton variant="primary" @click="$router.push('/tokens')">
                      Mint tokens
                    </MButton>
                    <MButton variant="outline" @click="$router.push('/compliance')">
                      View KYC list
                    </MButton>
                  </div>
                </div>
              </div>

              <!-- Encrypted amount input -->
              <div
                v-if="!preflightStatus || preflightStatus.holderCount > 0"
                class="flex flex-col gap-2"
              >
                <label
                  for="distribute-amount-input"
                  class="font-sans text-[10px] uppercase tracking-[0.22em] text-compute dark:text-signal font-semibold flex items-center gap-1.5"
                >
                  <Lock :size="10" :stroke-width="2" aria-hidden="true" />
                  Encrypted total amount
                </label>
                <div class="relative bg-white dark:bg-[#0e0e0e] border-b border-compute/30 dark:border-signal/30 px-4 pb-2 pt-2 transition-colors focus-within:border-compute/70 dark:focus-within:border-signal/70">
                  <span aria-hidden="true" class="absolute left-4 bottom-2 font-accent italic text-2xl text-cool">$</span>
                  <input
                    id="distribute-amount-input"
                    v-model="amount"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    min="0"
                    aria-label="Total yield to distribute, in mhUSDC"
                    :disabled="distributionStore.isProcessing"
                    data-testid="distribute-amount-input"
                    class="w-full bg-transparent border-0 pl-8 text-right
                           font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight
                           placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none
                           disabled:opacity-50
                           [&::-webkit-outer-spin-button]:appearance-none
                           [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
                <!-- Holder fan-out preview + shortfall warning -->
                <div class="flex items-center justify-between gap-3 mt-1 flex-wrap">
                  <p
                    v-if="holderTotal > 0"
                    class="font-sans text-[11px] text-cool flex items-center gap-1.5"
                  >
                    <Users :size="12" :stroke-width="1.8" />
                    Snapshotting
                    <span class="font-medium text-midnight dark:text-white tabular-nums">
                      {{ holderTotal === 1 ? 'all 1 holder' : `all ${holderTotal} holders` }}
                    </span>
                    in
                    <span class="font-medium text-midnight dark:text-white tabular-nums">
                      {{ batchCountPreview === 1 ? '1 batch' : `${batchCountPreview} batches` }}
                    </span>
                    · ~{{ batchCountPreview * 30 }}s on Arb Sepolia
                  </p>
                  <span
                    v-if="amountValid && mhUsdcBalance !== null && mhUsdcShortfall > 0n"
                    data-testid="distribute-shortfall"
                    class="font-sans text-[11px] text-gold flex items-center gap-1.5"
                  >
                    <AlertTriangle :size="12" :stroke-width="1.8" />
                    Short {{ formatUSD(Number(mhUsdcShortfall) / 1e6) }} — auto-wraps before fund
                  </span>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="px-6 py-4 border-t border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex flex-col gap-3">
              <p
                v-if="!walletStore.sessionKeyActive"
                class="font-sans text-[10px] text-cool italic"
              >
                First distribute installs a scoped session key — subsequent signatures happen silently.
              </p>
              <p
                v-if="preflightError"
                class="font-sans text-[12px] text-negative"
                data-testid="distribute-preflight-error"
              >{{ preflightError }}</p>
              <div class="flex justify-end">
                <button
                  type="button"
                  @click="handleDistribute"
                  :disabled="!canDistribute"
                  data-testid="distribute-cta"
                  class="btn-gold-sweep px-6 py-2.5 rounded-lg font-sans font-bold text-[12px] tracking-[0.18em] uppercase
                         flex items-center gap-2 cursor-pointer
                         transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99]
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                >
                  <Loader2 v-if="distributionStore.isProcessing" :size="14" class="animate-spin" />
                  <Coins v-else :size="13" :stroke-width="2" />
                  <span>{{ distributionStore.isProcessing
                    ? 'Distributing…'
                    : amountValid
                      ? `Distribute · ${formatUSD(Number(amountUnits) / 1e6)}`
                      : 'Distribute'
                  }}</span>
                  <ArrowRight v-if="!distributionStore.isProcessing" :size="13" :stroke-width="2" />
                </button>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Recent epochs strip — full width below wizard, on-chain reads -->
      <section
        v-if="recentEpochs.length > 0 || recentEpochsLoading"
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 280 } }"
        data-testid="distribute-recent-epochs"
        class="rounded-2xl border border-haze dark:border-white/5 bg-white/50 dark:bg-[#1c1b1b]/40 backdrop-blur-xl overflow-hidden"
      >
        <div class="px-6 py-4 border-b border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <TrendingUp :size="14" :stroke-width="1.8" class="text-cool" />
            <h4 class="font-sans font-bold text-base text-midnight dark:text-white tracking-tight">
              Recent Epochs
            </h4>
          </div>
          <span
            v-if="recentEpochs.length > 0"
            class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool"
          >Last {{ recentEpochs.length }}</span>
        </div>
        <div class="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div
            v-if="recentEpochs.length === 0 && recentEpochsLoading"
            class="md:col-span-2 flex items-center justify-center py-6"
          >
            <Loader2 :size="16" class="animate-spin text-cool" />
          </div>
          <div
            v-for="r in recentEpochs"
            :key="`${r.snapshotAddress}:${r.epochId}`"
            data-testid="distribute-recent-epoch-row"
            :data-epoch-id="String(r.epochId)"
            class="flex items-center justify-between gap-3 rounded-lg p-3.5
                   bg-white/70 dark:bg-[#0d0e10]/70
                   border border-haze/70 dark:border-white/5
                   hover:border-gold/30 dark:hover:border-signal/25
                   transition-colors"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div
                :class="[
                  'h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 border',
                  r.epoch.funded
                    ? 'bg-positive/10 border-positive/30 text-positive'
                    : r.epoch.finalized
                      ? 'bg-gold/10 border-gold/30 text-gold dark:bg-signal/10 dark:border-signal/30 dark:text-signal'
                      : 'bg-mist/60 dark:bg-white/5 border-haze dark:border-white/10 text-cool',
                ]"
              >
                <CheckCircle2 v-if="r.epoch.funded" :size="15" :stroke-width="1.8" />
                <Clock v-else-if="r.epoch.finalized" :size="15" :stroke-width="1.8" />
                <Receipt v-else :size="15" :stroke-width="1.8" />
              </div>
              <div class="flex flex-col min-w-0">
                <span class="font-sans text-sm font-bold text-midnight dark:text-white tabular-nums truncate">
                  Epoch #{{ r.epochId }} · {{ r.tokenSymbol }}
                </span>
                <span class="font-sans text-[11px] text-cool mt-0.5 truncate">
                  {{ r.epoch.holderCount }} holders ·
                  <template v-if="r.epoch.funded">{{ fmtClaimWindow(r.epoch.claimExpiry) }}</template>
                  <template v-else>{{ epochStatusLabel(r.epoch) }}</template>
                </span>
              </div>
            </div>
            <span
              :class="[
                'inline-flex items-center gap-1.5 font-sans text-[9px] uppercase tracking-[0.22em] font-bold px-2 py-0.5 rounded-full border flex-shrink-0',
                epochAccentClass(r.epoch),
              ]"
            >
              <span
                aria-hidden="true"
                :class="[
                  'w-1 h-1 rounded-full',
                  r.epoch.funded ? 'bg-positive' : r.epoch.finalized ? 'bg-gold' : 'bg-cool',
                ]"
              />
              {{ epochStatusLabel(r.epoch) }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
