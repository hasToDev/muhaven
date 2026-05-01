<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { StableClient } from '@muhaven/sdk'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { usePortfolioStore } from '@/stores/portfolio'
import { buildWriteContext } from '@/services/v35/context'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as LegacyPusdcService from '@/services/contracts/LegacyPusdcService'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MAddressQR from '@/components/ui/MAddressQR.vue'
import {
  CheckCircle2, Lock, Shield, EyeOff, ArrowRight, Loader2, Copy, Check,
  RefreshCw, ExternalLink, Coins, Layers, Wallet, Sparkles, Eye,
} from 'lucide-vue-next'

// CashPage — Phase 9.A first-run cockpit + wrap wizard.
//
//   • "Cash" mode (default; the universal first action for investors):
//       USDC → mhUSDC via legacy-PUSDC + `MuHavenStable.wrap`. This is
//       the post-register landing page; the right-aside doubles as the
//       investor's wallet cockpit (address + QR + balances + faucet).
//
//   • "Asset" mode (issuer-side, hidden):
//       underlying ERC-20 RWA → fhERC-20 RWA via `MuHavenVault.wrap`.
//       Reachable only via `?mode=asset` query param so the toggle stays
//       out of the investor's mental model. Same mechanics as before.
//
// Renamed from WrapPage in Phase 9.A — "Wrap" was jargon for the universal
// first action; "Cash" matches the user's "where's my money" mental model
// and pairs naturally with "Portfolio" as the second nav item.

type Mode = 'cash' | 'asset'

const route = useRoute()
const { address, connected } = useWallet()
const { initialize: initFhe, getEphemeralEOA } = useFhe()

// Phase 9.A: mhUSDC decrypted balance is shared cross-page state — the
// portfolio store already holds the same value (`pusdcConfidentialBalance`
// + `decryptPusdc()` action) for the Cash Buffer card on /portfolio.
// Using one source means a wrap or trade auto-syncs every surface that
// renders the value (CashPage tile, TradePage glance bar, Portfolio
// dashboard) without each page maintaining its own ref.
const portfolio = usePortfolioStore()

const isXl = useMediaQuery('(min-width: 1280px)')

const wrapperAvailable = computed(() => MuHavenStableService.isAvailable())

// Asset mode is opt-in via `?mode=asset` so the investor view stays single-
// purpose. When the query param is absent we force cash mode AND hide the
// toggle. Issuer/dev flows that need vault wrap reach it explicitly.
const assetModeRequested = computed(() => route.query.mode === 'asset')
const showModeToggle = computed(() =>
  wrapperAvailable.value && assetModeRequested.value,
)

const mode = ref<Mode>(
  assetModeRequested.value ? 'asset'
    : wrapperAvailable.value ? 'cash'
      : 'asset',
)

const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const errMsg = ref<string | null>(null)

// Cash-mode operator state — once granted, future wraps skip the approval.
const operatorSet = ref<boolean | null>(null)

// Steps shown only while a wrap is in flight (inline above the Convert
// button). "Enter Amount" intentionally dropped — by the time the rail
// is visible the user has already entered the amount. Two real steps
// remain per mode.
const cashSteps = [
  { label: 'Approve USDC', description: 'Granting allowance so the wrapper can pull your USDC…' },
  { label: 'Mint mhUSDC', description: 'Encrypting your USDC into spendable mhUSDC…' },
]
const assetSteps = [
  { label: 'Approve', description: 'Approving ERC-20 to vault…' },
  { label: 'Wrap', description: 'Wrapping into fhERC-20…' },
]
const steps = computed(() => mode.value === 'cash' ? cashSteps : assetSteps)

const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

// ── Wallet aside readouts ──────────────────────────────────────────────

const copied = ref(false)
const balancesLoading = ref(false)
const usdcBalance = ref<bigint | null>(null)

// Anti-layout-shift gate. The welcome ribbon's `v-if` depends on
// `isFirstRun` which depends on the async USDC balance read; rendering
// the main convert card before the read settled meant the card would
// animate in alone, then the ribbon would mount ~half a second later
// when the RPC resolved and push the card downward. Holding both
// sections behind a single `balancesLoaded` flag guarantees they
// commit to a layout in the same tick — ribbon (if first-run) and
// card animate together via the stagger on the card's :visible-once.
//
// Flipped true:
//   • after `loadBalances()` resolves (success OR error)
//   • when there's no wallet to load against (initial state, render
//     immediately so the disconnected view isn't blank)
//   • by a 1500ms timeout fallback (degraded RPC: render rather than
//     leave the page blank; late-arriving RPC could re-trigger the
//     pop-in but only on truly slow networks, accepted edge case)
const balancesLoaded = ref(false)

// True first-run state: USDC has been read AND is zero AND the user has
// no decrypted mhUSDC. Gates the welcome ribbon so returning users
// topping up don't see onboarding copy on every visit. mhUSDC value
// lives in the portfolio store now (`pusdcConfidentialBalance`); same
// gate logic as before, just reads the shared source.
const isFirstRun = computed(() =>
  usdcBalance.value === 0n
  && (portfolio.pusdcConfidentialBalance === null || portfolio.pusdcConfidentialBalance === 0n),
)

async function loadBalances() {
  if (!address.value) {
    // No wallet → nothing to fetch, but the page still needs to render
    // (the disconnected view shows the form + an aside with `—` balances).
    balancesLoaded.value = true
    return
  }
  balancesLoading.value = true
  try {
    usdcBalance.value = await Erc20Service.balanceOf(
      addresses.usdc, address.value as `0x${string}`,
    )
  } catch (e) {
    console.warn('[CashPage] USDC balance read failed', e)
    usdcBalance.value = null
  } finally {
    balancesLoading.value = false
    balancesLoaded.value = true
  }
}

/**
 * Unified refresh: re-read USDC AND re-decrypt mhUSDC, but only if the
 * user has already revealed mhUSDC. If the balance is still locked we
 * leave it locked — refreshing shouldn't trigger a session signature
 * for a value the user hasn't asked to see.
 */
async function refreshAll() {
  if (!address.value) return
  await loadBalances()
  if (portfolio.pusdcConfidentialBalance !== null) {
    await portfolio.decryptPusdc(address.value as `0x${string}`)
  }
}

/**
 * Reveal mhUSDC via the portfolio store's `decryptPusdc` action. Same
 * FHE flow under the hood (initFhe → MuHavenStable.confidentialBalanceOf
 * → decryptMhUsdcForView with legacy-PUSDC fallback) — using the store
 * means CashPage tile, TradePage glance bar, and Portfolio Cash Buffer
 * all read the same value, and a wrap or trade refresh updates every
 * surface at once.
 */
async function decryptMhUsdcBalance() {
  if (!address.value) return
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

async function refreshOperatorStatus() {
  if (!address.value || mode.value !== 'cash' || !wrapperAvailable.value) {
    operatorSet.value = null
    return
  }
  try {
    operatorSet.value = await LegacyPusdcService.isOperator(
      address.value as `0x${string}`,
      v35Addresses.muHavenStable,
    )
  } catch (e) {
    console.warn('[CashPage] operator status read failed', e)
    operatorSet.value = null
  }
}

async function copyAddress() {
  if (!address.value) return
  await navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

watch(connected, (val) => {
  if (val) {
    loadBalances()
    refreshOperatorStatus()
  }
})

watch(mode, () => {
  // Reset progress + scoped state when toggling between flows so a half-
  // finished asset wrap doesn't leak into a cash-mode progress rail.
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
  refreshOperatorStatus()
})

onMounted(() => {
  if (connected.value) {
    loadBalances()
    refreshOperatorStatus()
  } else {
    // No wallet on mount — render the page immediately so the user sees
    // the form rather than a blank column while we wait for an event
    // that may never come (`watch(connected)` covers the late-connect
    // case and re-fires `loadBalances`).
    balancesLoaded.value = true
  }
  // 1500ms timeout fallback. If the USDC RPC stalls past this point we
  // commit to rendering the page anyway — a blank column for several
  // seconds is worse than a possible late-arriving ribbon push. The
  // timeout is generous enough that healthy staging RPCs always resolve
  // first; only genuinely degraded sessions hit the fallback.
  setTimeout(() => { balancesLoaded.value = true }, 1500)
})

// ── Mode switcher ──────────────────────────────────────────────────────

function setMode(next: Mode) {
  if (mode.value === next) return
  if (next === 'cash' && !wrapperAvailable.value) return
  mode.value = next
}

// ── Submit ─────────────────────────────────────────────────────────────

async function handleSubmit() {
  if (mode.value === 'cash') return handleCashWrap()
  return handleAssetWrap()
}

const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60

/**
 * USDC → encrypted mhUSDC. Investors hold cleartext Circle USDC after
 * funding their kernel from the Circle faucet; mhUSDC is what
 * `MuHavenSubscription.purchase` pulls. Two on-chain wraps happen
 * sequentially under the user-visible "Mint mhUSDC" step:
 *   a. legacy PUSDC contract pulls USDC + mints PUSDC to the kernel
 *      (`pusdc.wrap(kernel, amount)`)
 *   b. MuHavenStable pulls PUSDC + mints mhUSDC 1:1
 *      (`stable.wrap(encAmount, ephemeralEOA)`)
 * We surface them as one UX step because the investor doesn't care about
 * the intermediate PUSDC layer — they just want spendable mhUSDC.
 *
 * Approvals (USDC ERC-20 to the PUSDC contract, PUSDC operator to the
 * stable contract) are checked + granted only when missing. Subsequent
 * wraps skip the approvals.
 */
async function handleCashWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  if (!wrapperAvailable.value) {
    errMsg.value = 'MuHavenStable wrapper not configured for this build.'
    return
  }
  isProcessing.value = true
  errMsg.value = null

  try {
    // USDC and PUSDC both use 6 decimals — same scaling.
    const amountUnits = BigInt(Math.round(numericAmount.value * 1_000_000))
    if (amountUnits <= 0n) throw new Error('Amount must be positive')

    const kernel = address.value as `0x${string}`

    // ── Step 0 (display) → Approve USDC for the wrapper ───────────────
    // Approve only when allowance < amount. Approve `amountUnits` exactly
    // (not max) so the surface area stays tight; investors who repeat
    // wraps will pay a fresh approve each time but it's a 1-tx ERC-20
    // call — minor cost vs. perpetual unlimited approval risk.
    currentStep.value = 0
    const allowance = await Erc20Service.allowance(
      addresses.usdc, kernel, addresses.pusdc,
    )
    if (allowance < amountUnits) {
      await Erc20Service.approve(addresses.usdc, addresses.pusdc, amountUnits)
      toast.info('USDC approved', {
        description: 'Wrapper can now pull your USDC',
      })
    }

    // ── Step 1 (display) → USDC → mhUSDC (collapses two on-chain hops) ─
    currentStep.value = 1

    // (a) USDC → PUSDC under the hood. Mints PUSDC to the kernel as the
    //     intermediate collateral the wrapper will then encrypt.
    await LegacyPusdcService.wrap(kernel, amountUnits)

    // (b) Wrapper operator approval, if missing. Wraps 2 and onward
    //     skip this — operator is granted with a long expiry.
    if (operatorSet.value !== true) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
      await LegacyPusdcService.setOperator(v35Addresses.muHavenStable, expiry)
      operatorSet.value = true
    }

    // (c) Mint mhUSDC via the SDK (encrypts client-side, grants ACL
    //     on the new mhUSDC handle to the active session EOA).
    await initFhe()
    const ctx = await buildWriteContext()
    const stable = new StableClient(ctx, v35Addresses.muHavenStable)
    const eph = getEphemeralEOA() as `0x${string}`

    const hash = await stable.wrap(amountUnits, eph)
    txHash.value = hash
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: 'USDC converted 1:1 into mhUSDC — ready for atomic buys.',
    })
    // Refresh USDC + auto-decrypt the new mhUSDC balance so the user
    // sees their fresh confidential cash without an extra click.
    loadBalances()
    decryptMhUsdcBalance()
  } catch (e) {
    // Print the full error CHAIN — TxFailedError wraps the underlying
    // viem/sender error in `cause`, but `toast.error` only shows the
    // top-level message. Walking `cause` here reveals the actual revert
    // reason / RPC error / encoding issue underneath. Without this, a
    // bare "Transaction failed for MuHavenStable.wrap (not submitted)"
    // hides whatever viem actually saw.
    console.error('[CashPage] cash wrap failed — full chain:')
    // tsconfig targets ES2020, so `Error.cause` isn't on the lib type. Walk
    // it via a structural read so we don't need to widen the project's lib.
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      if (cur instanceof Error) {
        console.error(`  [${depth}] ${cur.constructor.name}:`, cur)
        const next = (cur as Error & { cause?: unknown }).cause
        if (next) {
          cur = next
          depth += 1
          continue
        }
      } else {
        console.error(`  [${depth}] ${typeof cur}:`, cur)
      }
      break
    }
    errMsg.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

/** Existing RWA wrap — underlying ERC-20 → fhERC-20 via MuHavenVault. */
async function handleAssetWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  errMsg.value = null

  try {
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))

    currentStep.value = 0
    const underlying = await VaultService.underlyingToken()
    await Erc20Service.approve(underlying, addresses.muHavenVault, amountWei)

    currentStep.value = 1
    const hash = await VaultService.wrap(amountWei)

    txHash.value = hash
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: 'ERC-20 wrapped into fhERC-20 — balance now encrypted on-chain',
    })
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
}

// ── Mode-aware copy ────────────────────────────────────────────────────

const headerTitle = computed(() =>
  mode.value === 'cash' ? 'Convert USDC to mhUSDC' : 'Vault Wrap',
)
const headerSubtitle = computed(() =>
  mode.value === 'cash'
    ? 'Convert your Circle USDC into encrypted mhUSDC. Required once before your first purchase — subsequent buys spend your existing mhUSDC.'
    : 'Wrap an existing RWA ERC-20 into a confidential fhERC-20.',
)
const amountLabel = computed(() =>
  mode.value === 'cash' ? 'Amount (USDC)' : 'Amount (18 decimals)',
)
const ctaLabel = computed(() => {
  if (isProcessing.value) return mode.value === 'cash' ? 'Converting…' : 'Wrapping…'
  return mode.value === 'cash' ? 'Convert to mhUSDC' : 'Approve & Wrap'
})
const successTitle = computed(() =>
  mode.value === 'cash' ? 'mhUSDC ready' : 'Wrap confirmed',
)
const successCopy = computed(() =>
  mode.value === 'cash'
    ? 'USDC converted 1:1 into mhUSDC — your balance is encrypted to this session and ready to spend on the Trade page.'
    : 'ERC-20 wrapped into fhERC-20 — your balance is now encrypted on-chain.',
)
</script>

<template>
  <div>
    <div class="xl:mr-80">
      <!-- ── Anti-layout-shift gate ───────────────────────────────────
           Both the welcome ribbon and the convert card mount only after
           `balancesLoaded` flips true. This guarantees they commit to a
           layout in the same tick — without the gate the convert card
           animated in alone, then the ribbon mounted ~half a second
           later when the USDC RPC resolved and pushed the card down,
           which read as a layout bug. The gate also drives the
           ribbon-vs-card stagger on the convert card's :visible-once
           (delay: 120ms when first-run, 0ms otherwise — under the
           ~150ms perceptual-grouping threshold so the eye reads the
           pair as one composition, not two events). -->
      <template v-if="balancesLoaded">
      <!-- ── Welcome ribbon — first-run only ──────────────────────────
           Shown when USDC=0 and platform mhUSDC empty: a gentle two-step
           pointer (fund right-aside → convert below). Hidden once the
           user has any balance, so returning top-ups stay quiet. -->
      <section
        v-if="mode === 'cash' && isFirstRun && !showSuccess && !errMsg"
        v-motion
        :initial="{ opacity: 0, y: 12 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460 } }"
        data-testid="cash-welcome-ribbon"
        class="max-w-2xl mx-auto mb-6 rounded-2xl overflow-hidden
               border border-gold/25 dark:border-signal/20
               bg-gradient-to-br from-gold/8 via-mist/40 to-transparent
               dark:from-signal/8 dark:via-[#1c1b1b]/60 dark:to-transparent
               p-5 md:p-6"
      >
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-gold/15 dark:bg-signal/15 flex items-center justify-center shrink-0">
            <Sparkles :size="16" :stroke-width="1.8" class="text-gold dark:text-signal" />
          </div>
          <div class="flex flex-col gap-1.5">
            <h1 class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tracking-tight leading-tight">
              Welcome to MuHaven
            </h1>
            <p class="font-sans text-[13px] text-cool leading-relaxed">
              <span class="font-medium text-midnight dark:text-white">1.</span> Copy your wallet address (right) and tap
              <span class="font-medium text-midnight dark:text-white">Get test USDC</span> to receive testnet USDC.
              <br class="hidden md:block">
              <span class="font-medium text-midnight dark:text-white">2.</span> Convert USDC to <span class="font-mono text-[12px]">mhUSDC</span> below — encrypted cash you'll spend on the Trade page.
            </p>
          </div>
        </div>
      </section>

      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: isFirstRun ? 120 : 0 } }"
        class="relative max-w-2xl mx-auto rounded-2xl overflow-hidden border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div aria-hidden="true"
             class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent" />
        <div aria-hidden="true"
             class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none"
             :class="mode === 'cash' ? 'bg-compute/8 dark:bg-signal/8' : 'bg-gold/8 dark:bg-signal/8'" />

        <div class="p-8 md:p-10 relative">
          <!-- Mode toggle — investor view defaults to cash with the toggle
               hidden. Pass `?mode=asset` to surface the asset (vault wrap)
               flow alongside cash for issuer/dev use. -->
          <div
            v-if="!showSuccess && !errMsg && showModeToggle"
            data-testid="wrap-mode-toggle"
            class="relative inline-flex items-center gap-1 mb-8
                   rounded-full border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#1c1b1b]/80 p-1
                   shadow-[inset_0_1px_2px_rgba(63,46,12,0.04)]
                   dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          >
            <div
              aria-hidden="true"
              class="absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full
                     bg-gradient-to-r transition-all duration-300 ease-out
                     shadow-[0_2px_10px_-2px_rgba(255,186,32,0.45)]
                     dark:shadow-[0_2px_14px_-2px_rgba(255,220,161,0.35)]"
              :class="[
                mode === 'cash'
                  ? 'left-1 from-compute to-gold dark:from-signal dark:to-signal/85'
                  : 'left-[calc(50%+0.05rem)] from-gold to-gold/90 dark:from-signal dark:to-signal/70',
              ]"
            />
            <button
              type="button"
              @click="setMode('cash')"
              :disabled="isProcessing"
              data-testid="wrap-mode-cash"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[130px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'cash'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Coins :size="13" :stroke-width="2" />
              Cash · mhUSDC
            </button>
            <button
              type="button"
              @click="setMode('asset')"
              :disabled="isProcessing"
              data-testid="wrap-mode-asset"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[130px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'asset'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Layers :size="13" :stroke-width="2" />
              Asset · RWA
            </button>
          </div>

          <div v-if="showSuccess" data-testid="wrap-success-card" class="flex flex-col items-center gap-5 py-6">
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">{{ successTitle }}</p>
              <p class="font-sans text-sm text-cool max-w-md">{{ successCopy }}</p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a :href="arbiscanTx(txHash)" target="_blank" rel="noopener"
                 class="text-compute dark:text-signal hover:underline">
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">
              {{ mode === 'cash' ? 'Convert again' : 'Make another wrap' }}
            </MButton>
          </div>

          <div v-else-if="errMsg" data-testid="wrap-error-card" class="flex flex-col items-center gap-5 py-8">
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">Something went wrong</p>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <div v-else class="flex flex-col gap-8">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center">
                <Shield :size="18" :stroke-width="1.8" />
              </div>
              <div>
                <p class="font-accent italic text-xl text-midnight dark:text-white leading-tight">{{ headerTitle }}</p>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">{{ headerSubtitle }}</p>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <label for="wrap-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                {{ amountLabel }}
              </label>
              <div class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2 transition-colors focus-within:border-gold dark:focus-within:border-signal">
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">$</span>
                <input
                  id="wrap-amount-input"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Wrap amount"
                  :disabled="isProcessing"
                  data-testid="wrap-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button
                  v-for="qa in quickAmounts"
                  :key="qa"
                  type="button"
                  @click="amount = qa"
                  :disabled="isProcessing"
                  :data-testid="`wrap-quick-${qa}`"
                  class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                         bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                         text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                         border border-haze dark:border-white/10
                         px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                >
                  ${{ Number(qa).toLocaleString() }}
                </button>
              </div>
              <p
                v-if="mode === 'cash'"
                class="font-sans text-[10px] text-cool/80 leading-relaxed"
                data-testid="wrap-cash-hint"
              >
                1:1 backed: every USDC you wrap is held as collateral. Unwrap to USDC any time.
              </p>
            </div>

            <!-- Inline progress rail — visible only while a wrap is in
                 flight. Two pill steps (Approve → Mint) with active /
                 done state. Replaces the right-aside "Current Step"
                 section that lived statically on the page even when
                 nothing was happening. -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="isProcessing"
                data-testid="wrap-inline-rail"
                class="rounded-lg p-4 border border-gold/25 dark:border-signal/20
                       bg-gold/6 dark:bg-signal/5 flex flex-col gap-3"
              >
                <div class="flex items-center gap-3">
                  <div
                    v-for="(s, i) in steps"
                    :key="s.label"
                    class="flex-1 flex items-center gap-2 min-w-0"
                  >
                    <div
                      :class="[
                        'w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center transition-all',
                        i < currentStep
                          ? 'bg-gold dark:bg-signal'
                          : i === currentStep
                            ? 'bg-gold dark:bg-signal ring-4 ring-gold/15 dark:ring-signal/20'
                            : 'bg-mist/60 dark:bg-[#1c1b1b] border border-haze dark:border-white/15',
                      ]"
                    >
                      <Check v-if="i < currentStep" :size="11" :stroke-width="2.5" class="text-white dark:text-midnight" />
                      <Loader2 v-else-if="i === currentStep" :size="11" class="animate-spin text-white dark:text-midnight" />
                    </div>
                    <span
                      :class="[
                        'font-sans text-[10px] uppercase tracking-[0.18em] font-semibold truncate',
                        i <= currentStep ? 'text-compute dark:text-signal' : 'text-cool',
                      ]"
                    >
                      {{ s.label }}
                    </span>
                    <div
                      v-if="i < steps.length - 1"
                      :class="[
                        'flex-shrink-0 h-px w-3 transition-colors',
                        i < currentStep ? 'bg-gold dark:bg-signal' : 'bg-haze dark:bg-white/10',
                      ]"
                      aria-hidden="true"
                    />
                  </div>
                </div>
                <p
                  v-if="steps[currentStep]"
                  class="font-sans text-[11px] text-cool leading-tight pl-7"
                >
                  {{ steps[currentStep].description }}
                </p>
              </div>
            </transition>

            <button
              type="button"
              @click="handleSubmit"
              :disabled="isProcessing || !amount.trim() || numericAmount <= 0"
              data-testid="wrap-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <Shield v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">{{ ctaLabel }}</span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>
          </div>
        </div>
      </section>
      </template>
    </div>

    <Teleport to="body" :disabled="!isXl">
      <aside
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
        class="mt-10 xl:mt-0 flex flex-col gap-8 w-full
               xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
               xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
      >
        <!-- ── Wallet card — address + QR + chain pill ──────────────── -->
        <div>
          <div class="flex items-center justify-between mb-5">
            <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold inline-flex items-center gap-2">
              <Wallet :size="13" :stroke-width="2" class="text-compute dark:text-signal" />
              Your wallet
            </h2>
            <span
              class="font-sans text-[9px] uppercase tracking-[0.18em] font-medium
                     text-compute/80 dark:text-signal/80
                     bg-compute/8 dark:bg-signal/10
                     border border-compute/20 dark:border-signal/20
                     px-2 py-0.5 rounded"
            >
              Arb Sepolia
            </span>
          </div>

          <div
            class="rounded-xl p-5 border border-haze dark:border-white/8
                   bg-white dark:bg-[#1c1b1b]/80
                   shadow-[0_2px_14px_-6px_rgba(63,46,12,0.1)]
                   dark:shadow-[0_2px_14px_-6px_rgba(0,0,0,0.6)]
                   flex flex-col items-center gap-4"
          >
            <MAddressQR
              :address="address ?? null"
              :size="148"
              caption="Scan with any wallet to send USDC here"
            />

            <div class="w-full flex flex-col gap-2">
              <span class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80 text-center">
                Smart account address
              </span>
              <button
                type="button"
                @click="copyAddress"
                :disabled="!address"
                data-testid="cash-wallet-copy-address"
                :aria-label="copied ? 'Address copied' : 'Copy smart account address'"
                class="group w-full inline-flex items-center justify-between gap-2
                       rounded-lg px-3 py-2.5
                       bg-mist/60 dark:bg-white/[0.04]
                       border border-haze dark:border-white/8
                       hover:border-gold/50 dark:hover:border-signal/30
                       transition-colors duration-200 cursor-pointer
                       disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span class="font-mono text-[11px] text-compute dark:text-signal truncate">
                  {{ address ?? '—' }}
                </span>
                <span
                  class="flex-shrink-0 inline-flex items-center gap-1 font-sans text-[10px] uppercase tracking-[0.18em] font-semibold
                         text-cool group-hover:text-compute dark:group-hover:text-signal transition-colors"
                >
                  <Check v-if="copied" :size="12" class="text-positive" />
                  <Copy v-else :size="12" />
                  {{ copied ? 'Copied' : 'Copy' }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- ── Balances strip ──────────────────────────────────────── -->
        <div class="flex flex-col gap-3">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold">Balances</h3>

          <!-- USDC: plaintext ERC-20 -->
          <div class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1">
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">USDC</span>
              <span class="font-sans text-[9px] text-cool/70 uppercase tracking-[0.18em]">Public testnet</span>
            </div>
            <span
              class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums"
              data-testid="cash-usdc-balance"
            >
              {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}
            </span>
            <a
              v-if="usdcBalance !== null && usdcBalance === 0n"
              :href="CIRCLE_FAUCET_URL"
              target="_blank"
              rel="noopener"
              data-testid="fund-account-faucet-link"
              class="mt-1 inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold text-gold hover:text-gold/80 transition-colors self-start"
            >
              Get test USDC
              <ExternalLink :size="11" />
            </a>
          </div>

          <!-- mhUSDC: encrypted spendable cash. Two states:
               • Pre-decrypt (portfolio.pusdcConfidentialBalance === null): show "Encrypted"
                 pill + Reveal button. The on-chain balance handle is
                 sealed; only the user can decrypt. We never auto-fetch
                 this on mount — each decrypt costs a session signature.
               • Post-decrypt (bigint): show formatted USD + Refresh. -->
          <div class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">mhUSDC</span>
              <span
                class="font-sans text-[9px] uppercase tracking-[0.18em] font-medium
                       text-compute/80 dark:text-signal/80
                       border border-compute/20 dark:border-signal/20
                       px-1.5 py-0.5 rounded"
              >
                Encrypted
              </span>
            </div>

            <!-- Decrypted state: big number. Refresh action lives in the
                 single unified button below — keeps the tile clean and
                 prevents two competing "Refresh" surfaces in the aside. -->
            <template v-if="portfolio.pusdcConfidentialBalance !== null">
              <span
                class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums"
                data-testid="cash-mhusdc-balance"
              >
                {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
              </span>
              <span class="font-sans text-[10px] text-cool/80 leading-tight">
                Confidential cash · spend on Trade
              </span>
            </template>

            <!-- Pre-decrypt state: blurred placeholder + Reveal CTA -->
            <template v-else>
              <span
                class="font-accent italic text-2xl text-cool/40 dark:text-body-dark/30 tabular-nums select-none blur-[2.5px] tracking-[0.05em]"
                aria-hidden="true"
                data-testid="cash-mhusdc-locked"
              >
                $••••.••
              </span>
              <span class="font-sans text-[10px] text-cool/80 leading-tight">
                Confidential cash · only you can decrypt
              </span>
              <button
                type="button"
                @click="decryptMhUsdcBalance"
                :disabled="portfolio.pusdcDecrypting || !address"
                data-testid="cash-mhusdc-decrypt-cta"
                class="self-start mt-1 inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold
                       text-compute dark:text-signal
                       border border-compute/30 dark:border-signal/30
                       hover:text-white dark:hover:text-[#412d00]
                       hover:bg-compute dark:hover:bg-signal
                       px-3 py-1.5 rounded transition-all duration-200 cursor-pointer
                       disabled:opacity-60 disabled:cursor-wait"
              >
                <Loader2 v-if="portfolio.pusdcDecrypting" :size="11" class="animate-spin" />
                <Eye v-else :size="11" :stroke-width="2" />
                Reveal
              </button>
            </template>

            <p
              v-if="portfolio.pusdcError"
              class="font-sans text-[10px] text-negative leading-tight mt-1"
            >
              {{ portfolio.pusdcError }}
            </p>
          </div>

          <!-- Unified Refresh — re-fetches USDC + re-decrypts mhUSDC iff
               already revealed. We never trigger a fresh decrypt for a
               locked balance: that costs a session signature for a
               value the user hasn't asked to see. -->
          <div class="flex items-center justify-end pt-1">
            <button
              type="button"
              @click="refreshAll"
              :disabled="balancesLoading || portfolio.pusdcDecrypting || !address"
              data-testid="cash-balances-refresh"
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw :size="12" :class="(balancesLoading || portfolio.pusdcDecrypting) && 'animate-spin'" />
              Refresh
            </button>
          </div>
        </div>

        <!-- Security Notice — privacy framing, always visible. The
             progress rail used to live above this section but moved
             inline above the Convert button so it's only on screen
             while a wrap is actually running. -->
        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">Security Notice</h3>
          <div class="rounded-lg p-4 border border-gold/25 bg-gold/5 flex items-start gap-3">
            <EyeOff :size="16" :stroke-width="1.8" class="text-gold mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              {{ mode === 'cash'
                ? 'Wrap amount is encrypted via Fhenix FHE. mhUSDC balance grants decrypt rights to this session only.'
                : 'ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.' }}
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
