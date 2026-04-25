<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { decodeEventLog } from 'viem'
import {
  SubscriptionClient,
  OracleClient,
  IdentityRegistryClient,
  muhavenSubscriptionAbi,
} from '@muhaven/sdk'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext, buildReadContext, getPublicClient } from '@/services/v35/context'
import { portfolioApi, balanceApi, type TokenResponseDto } from '@/services/api'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { addresses } from '@/contracts/addresses'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import { muHavenTokenAbi } from '@/contracts/abis'
import {
  CheckCircle2, Lock, ShieldCheck, EyeOff, TrendingUp, ChevronDown, ArrowRight,
  Loader2, Copy, Check, RefreshCw, ExternalLink, AlertTriangle, ShoppingCart, Undo2,
  Eye, Inbox, Zap, Coins,
} from 'lucide-vue-next'

// TradePage — Wave 3.5 atomic buy + instant-redeem against
// `MuHavenSubscription`. Mode is a top-level toggle; the form, status rail,
// and success card all swap shape per mode while reusing the same shell.
//
// On the redeem leg, the contract silently escalates to `RedemptionQueue`
// when `shares * NAV > instantCapRemaining` — pre-flight UX warns about
// the escalation before the investor signs, and the post-tx receipt parse
// surfaces the actual outcome (instant vs queued) to the success card.

type Mode = 'buy' | 'sell'

const route = useRoute()
const router = useRouter()
const marketplace = useMarketplaceStore()
const { address, connected } = useWallet()
const fhe = useFhe()
const { encryptUint128, getEphemeralEOA, decryptUint128ForView, decryptMhUsdcForView, initialize: initFhe } = fhe

const isXl = useMediaQuery('(min-width: 1280px)')

// ── Mode + form state ──────────────────────────────────────────────────

const mode = ref<Mode>('buy')
const selectedToken = ref<string>('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const settledAs = ref<'instant' | 'queued' | null>(null)
const queuedRequestId = ref<bigint | null>(null)
const errMsg = ref<string | null>(null)

// `?mode=sell` deep-links straight into Sell. Token comes from `?token=`.
function readQueryMode(): Mode {
  return (route.query.mode as string) === 'sell' ? 'sell' : 'buy'
}

const buySteps = [
  { label: 'Enter Amount', description: 'Pick shares + max hint' },
  { label: 'Encrypt', description: 'FHE inputs client-side' },
  { label: 'Purchase', description: 'Subscription.purchase() atomic buy' },
]
const sellSteps = [
  { label: 'Enter Amount', description: 'Pick shares to redeem' },
  { label: 'Encrypt', description: 'FHE inputs client-side' },
  { label: 'Redeem', description: 'Subscription.redeem() — instant or queued' },
]
const steps = computed(() => mode.value === 'buy' ? buySteps : sellSteps)
const railHeight = computed(() => Math.min(100, ((currentStep.value + 1) / steps.value.length) * 100))

const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

const selectedTokenData = computed<TokenResponseDto | undefined>(() =>
  selectedToken.value ? marketplace.getByAddress(selectedToken.value) : undefined,
)

// `maxSharesHint` defaults to 10% above the requested amount per FLOWS.md
// suggestion. Silent-fail protects against over-purchase / over-redeem
// anyway — the hint is about cap accounting, not the actual cap.
const HINT_HEADROOM = 1.1

const navDollars = computed<number>(() => {
  if (nav.value !== null) return Number(nav.value) / 1e6
  const latest = selectedTokenData.value?.latest_nav
  return latest ? parseFloat(latest.nav) : 1
})

const positionUsd = computed(() => numericAmount.value * navDollars.value)

const estimatedYield = computed(() => {
  const apy = selectedTokenData.value?.apy ? parseFloat(selectedTokenData.value.apy) : 4.8
  return (positionUsd.value * apy / 100 / 12).toFixed(2)
})

// ── NAV + freshness readout ─────────────────────────────────────────────

const nav = ref<bigint | null>(null)
const navUpdatedAt = ref<bigint | null>(null)
const isFresh = ref<boolean>(false)
const navLoading = ref(false)

async function refreshNav() {
  if (!selectedToken.value) return
  if (isZeroAddress(v35Addresses.oracle)) return
  navLoading.value = true
  try {
    const ctx = buildReadContext()
    const oracle = new OracleClient(ctx, v35Addresses.oracle)
    const token = selectedToken.value as `0x${string}`
    const [{ nav: navVal, updatedAt }, fresh] = await Promise.all([
      oracle.getNAV(token),
      oracle.isFresh(token),
    ])
    nav.value = navVal
    navUpdatedAt.value = updatedAt
    isFresh.value = fresh
  } catch (e) {
    console.warn('[TradePage] oracle read failed:', e)
  } finally {
    navLoading.value = false
  }
}

// ── KYC gate ────────────────────────────────────────────────────────────

const isVerified = ref<boolean | null>(null)
const devModeActive = ref<boolean | null>(null)

async function refreshKyc() {
  if (!address.value) return
  if (isZeroAddress(v35Addresses.identityRegistry)) return
  try {
    const identity = new IdentityRegistryClient(buildReadContext(), v35Addresses.identityRegistry)
    const [v, dev] = await Promise.all([
      identity.isVerified(address.value as `0x${string}`),
      identity.devMode(),
    ])
    isVerified.value = v
    devModeActive.value = dev
  } catch (e) {
    console.warn('[TradePage] KYC read failed:', e)
  }
}

watch(connected, (val) => { if (val) refreshKyc() })

// ── Sell-mode reads: holding balance + instant cap remaining ───────────

const holdingBalance = ref<bigint | null>(null)
const holdingDecrypting = ref(false)
const instantCapRemaining = ref<bigint | null>(null)
const capLoading = ref(false)

async function refreshHolding() {
  // Reset the decrypted readout — the user opts back in via Reveal so we
  // don't leak a stale plaintext from one token onto another's card.
  holdingBalance.value = null
}

async function decryptHoldingBalance() {
  if (!selectedToken.value || !address.value || holdingDecrypting.value) return
  holdingDecrypting.value = true
  try {
    const handle = (await getPublicClient().readContract({
      address: selectedToken.value as Address,
      abi: muHavenTokenAbi,
      functionName: 'encryptedBalanceOf',
      args: [address.value as Address],
    })) as `0x${string}`
    holdingBalance.value = await decryptUint128ForView(handle)
  } catch (e) {
    toast.error('Reveal balance failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    holdingDecrypting.value = false
  }
}

async function refreshInstantCap() {
  if (!selectedToken.value) {
    instantCapRemaining.value = null
    return
  }
  if (isZeroAddress(v35Addresses.subscription)) return
  capLoading.value = true
  try {
    const sub = new SubscriptionClient(buildReadContext(), v35Addresses.subscription)
    instantCapRemaining.value = await sub.getInstantCapRemaining(selectedToken.value as Address)
  } catch (e) {
    console.warn('[TradePage] instant cap read failed:', e)
    instantCapRemaining.value = null
  } finally {
    capLoading.value = false
  }
}

// `cost = shares * nav` in PUSDC base units. Cap is in PUSDC base units
// too. `nav` is also in PUSDC base units per share, so cost is exactly
// `shares * nav` — no decimal scaling. (See MuHavenSubscription.sol:48-56
// for the matching on-chain math.)
const estimatedCostPusdc = computed<bigint | null>(() => {
  if (numericAmount.value <= 0 || nav.value === null) return null
  const shares = BigInt(Math.floor(numericAmount.value))
  return shares * nav.value
})

const willEscalate = computed<boolean>(() => {
  if (mode.value !== 'sell') return false
  if (instantCapRemaining.value === null || estimatedCostPusdc.value === null) return false
  return estimatedCostPusdc.value > instantCapRemaining.value
})

const exceedsHolding = computed<boolean>(() => {
  if (mode.value !== 'sell' || holdingBalance.value === null) return false
  const shares = BigInt(Math.floor(numericAmount.value || 0))
  return shares > holdingBalance.value
})

// ── Phase 7.5 — mhUSDC pre-flight (buy mode) ───────────────────────────
//
// Buy flow pulls mhUSDC from the investor via Subscription's silent-fail
// pull. If balance < cost, the contract zeros out — investor pays gas
// for nothing. We surface a pre-flight warning + inline "Wrap PUSDC
// first" CTA so the failure mode lands as UI instead of an empty tx.

const mhUsdcAvailable = computed(() => MuHavenStableService.isAvailable())
const mhUsdcBalance = ref<bigint | null>(null)
const mhUsdcDecrypting = ref(false)

async function decryptMhUsdcBalance() {
  if (!address.value || mhUsdcDecrypting.value) return
  if (!mhUsdcAvailable.value) {
    mhUsdcBalance.value = null
    return
  }
  mhUsdcDecrypting.value = true
  try {
    await initFhe()
    const ctHash = await MuHavenStableService.confidentialBalanceOf(address.value as Address)
    mhUsdcBalance.value = await decryptMhUsdcForView(ctHash)
  } catch (e) {
    console.warn('[TradePage] mhUSDC decrypt failed', e)
    mhUsdcBalance.value = null
  } finally {
    mhUsdcDecrypting.value = false
  }
}

const insufficientMhUsdc = computed<boolean>(() => {
  if (mode.value !== 'buy') return false
  if (mhUsdcBalance.value === null || estimatedCostPusdc.value === null) return false
  return estimatedCostPusdc.value > mhUsdcBalance.value
})

watch(selectedToken, () => {
  refreshNav()
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

watch(mode, (m) => {
  // Switching mode resets in-flight error/success and refetches sell-only
  // reads. Form values stay so the user can flip without retyping.
  errMsg.value = null
  showSuccess.value = false
  settledAs.value = null
  queuedRequestId.value = null
  currentStep.value = 0
  if (m === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

// ── Wallet aside ────────────────────────────────────────────────────────

const copied = ref(false)
const balancesLoading = ref(false)
const usdcBalance = ref<bigint | null>(null)
const formattedBackendBalance = ref<string | null>(null)

async function loadBalances() {
  if (!address.value) return
  balancesLoading.value = true
  try {
    const [usdc, backend] = await Promise.allSettled([
      Erc20Service.balanceOf(addresses.usdc, address.value as `0x${string}`),
      balanceApi.get(),
    ])
    usdcBalance.value = usdc.status === 'fulfilled' ? usdc.value : null
    formattedBackendBalance.value = backend.status === 'fulfilled' ? backend.value.formatted_balance : null
  } finally {
    balancesLoading.value = false
  }
}

async function copyAddress() {
  if (!address.value) return
  await navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

watch(connected, (val) => { if (val) loadBalances() })

onMounted(async () => {
  if (connected.value) {
    loadBalances()
    refreshKyc()
  }
  if (!marketplace.loaded) await marketplace.load()

  mode.value = readQueryMode()

  const queryToken = route.query.token as string | undefined
  if (queryToken && marketplace.getByAddress(queryToken)) {
    selectedToken.value = queryToken
  } else if (marketplace.filtered.length > 0 && !selectedToken.value) {
    selectedToken.value = marketplace.filtered[0].address
  }
  // Trigger sell-mode reads if we deep-linked into ?mode=sell
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

// ── Mode switcher (URL sync) ────────────────────────────────────────────

function setMode(next: Mode) {
  if (mode.value === next) return
  mode.value = next
  router.replace({
    query: { ...route.query, mode: next === 'buy' ? undefined : 'sell' },
  })
}

function goWrap() {
  router.push('/wrap')
}

// ── Submit handler ──────────────────────────────────────────────────────

async function handleSubmit() {
  if (mode.value === 'buy') return handlePurchase()
  return handleRedeem()
}

async function handlePurchase() {
  if (!amount.value || isProcessing.value || !address.value || !selectedToken.value) return
  if (isZeroAddress(v35Addresses.subscription)) {
    errMsg.value =
      'Subscription contract not configured for this build. '
      + 'Set VITE_SUBSCRIPTION_ADDRESS in your env.'
    return
  }

  isProcessing.value = true
  errMsg.value = null

  try {
    currentStep.value = 1

    // Shares are raw integer units per Wave 3.5 contract convention:
    // `FHE.mul(shares, nav)` produces PUSDC base units (6-decimal). See
    // MuHavenSubscription.sol L48-56 + ADR-031 cleartext guard.
    const shares = BigInt(Math.floor(numericAmount.value))
    const maxSharesHint = BigInt(Math.ceil(numericAmount.value * HINT_HEADROOM))

    const ctx = await buildWriteContext()
    const sub = new SubscriptionClient(ctx, v35Addresses.subscription)
    const ephemeralEOA = getEphemeralEOA()

    currentStep.value = 2

    const hash = await sub.purchase(
      selectedToken.value as `0x${string}`,
      shares,
      maxSharesHint,
      ephemeralEOA,
      {
        onProgress: (e) => {
          if (e.stage === 'purchase') currentStep.value = 3
        },
      },
    )

    txHash.value = hash
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Purchase confirmed', {
      description: 'Atomic subscription purchase — PUSDC pulled + shares minted',
    })

    if (selectedTokenData.value) {
      portfolioApi.addPosition(
        selectedTokenData.value.address,
        selectedTokenData.value.symbol,
      ).catch(() => {})
    }
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Purchase failed'
    toast.error('Purchase failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

async function handleRedeem() {
  if (!amount.value || isProcessing.value || !address.value || !selectedToken.value) return
  if (isZeroAddress(v35Addresses.subscription)) {
    errMsg.value =
      'Subscription contract not configured for this build. '
      + 'Set VITE_SUBSCRIPTION_ADDRESS in your env.'
    return
  }

  isProcessing.value = true
  errMsg.value = null
  settledAs.value = null
  queuedRequestId.value = null

  try {
    currentStep.value = 1

    const shares = BigInt(Math.floor(numericAmount.value))
    const maxSharesHint = BigInt(Math.ceil(numericAmount.value * HINT_HEADROOM))

    const ctx = await buildWriteContext()
    const sub = new SubscriptionClient(ctx, v35Addresses.subscription)
    const ephemeralEOA = getEphemeralEOA()

    currentStep.value = 2

    const hash = await sub.redeem(
      selectedToken.value as `0x${string}`,
      shares,
      maxSharesHint,
      ephemeralEOA,
      {
        onProgress: (e) => {
          if (e.stage === 'redeemInstant') currentStep.value = 3
        },
      },
    )

    txHash.value = hash
    currentStep.value = 3

    // Parse the receipt to determine instant vs escalated. The contract
    // emits `Redeemed(escalated)` always, plus `EscalatedToQueue(...,
    // requestId)` on the escalate branch. Pre-flight UX shows "will
    // escalate" already; this confirms what actually happened.
    try {
      const receipt = await getPublicClient().getTransactionReceipt({ hash })
      const escalateLog = receipt.logs.find((log) => {
        try {
          const parsed = decodeEventLog({
            abi: muhavenSubscriptionAbi,
            data: log.data,
            topics: log.topics,
            strict: false,
          })
          return parsed.eventName === 'EscalatedToQueue'
        } catch {
          return false
        }
      })
      if (escalateLog) {
        const parsed = decodeEventLog({
          abi: muhavenSubscriptionAbi,
          data: escalateLog.data,
          topics: escalateLog.topics,
        }) as { eventName: 'EscalatedToQueue'; args: { requestId: bigint } }
        settledAs.value = 'queued'
        queuedRequestId.value = parsed.args.requestId
      } else {
        settledAs.value = 'instant'
      }
    } catch {
      // If receipt parsing fails we still got a confirmed tx hash; fall
      // back to whatever pre-flight predicted, defaulting to instant.
      settledAs.value = willEscalate.value ? 'queued' : 'instant'
    }

    showSuccess.value = true
    if (settledAs.value === 'queued') {
      toast.info('Redemption queued', {
        description: 'Cap was full this epoch — your shares are in the queue, claim when settled',
      })
    } else {
      toast.success('Redemption confirmed', {
        description: 'Shares burned + PUSDC paid out atomically',
      })
    }
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Redeem failed'
    toast.error('Redeem failed', { description: errMsg.value })
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
  settledAs.value = null
  queuedRequestId.value = null
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
}

// Pre-fill helpers for Sell mode — render only when the holding is
// decrypted so we know the upper bound is real.
function fillHalf() {
  if (holdingBalance.value === null || holdingBalance.value === 0n) return
  amount.value = (holdingBalance.value / 2n).toString()
}

function fillMax() {
  if (holdingBalance.value === null || holdingBalance.value === 0n) return
  amount.value = holdingBalance.value.toString()
}

// CTA copy + states swap by mode.
const ctaLabel = computed(() => {
  if (isProcessing.value) {
    return mode.value === 'buy' ? 'Encrypting & purchasing…' : 'Encrypting & redeeming…'
  }
  if (mode.value === 'buy') return 'Encrypt & Purchase'
  return willEscalate.value ? 'Encrypt & Redeem (queued)' : 'Encrypt & Redeem'
})

const ctaDisabled = computed(() => {
  if (isProcessing.value) return true
  if (!amount.value.trim() || numericAmount.value <= 0) return true
  if (isVerified.value === false && devModeActive.value !== true) return true
  if (mode.value === 'sell' && exceedsHolding.value) return true
  return false
})
</script>

<template>
  <div>
    <div class="xl:mr-80">
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="relative max-w-2xl mx-auto rounded-2xl overflow-hidden border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div
          aria-hidden="true"
          class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent"
        />
        <div
          aria-hidden="true"
          class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none"
          :class="mode === 'buy' ? 'bg-gold/8 dark:bg-signal/8' : 'bg-compute/8 dark:bg-signal/6'"
        />

        <div class="p-8 md:p-10 relative">
          <!-- Mode toggle — segmented pill, hidden on success/error so
               the resolved card stays the focal point -->
          <div
            v-if="!showSuccess && !errMsg"
            data-testid="trade-mode-toggle"
            class="relative inline-flex items-center gap-1 mb-8
                   rounded-full border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#1c1b1b]/80 p-1
                   shadow-[inset_0_1px_2px_rgba(63,46,12,0.04)]
                   dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          >
            <!-- Active pill (slides between segments via transform). -->
            <div
              aria-hidden="true"
              class="absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full
                     bg-gradient-to-r transition-all duration-300 ease-out
                     shadow-[0_2px_10px_-2px_rgba(255,186,32,0.45)]
                     dark:shadow-[0_2px_14px_-2px_rgba(255,220,161,0.35)]"
              :class="[
                mode === 'buy'
                  ? 'left-1 from-gold to-gold/90 dark:from-signal dark:to-signal/85'
                  : 'left-[calc(50%+0.05rem)] from-compute to-gold dark:from-signal dark:to-signal/70',
              ]"
            />
            <button
              type="button"
              @click="setMode('buy')"
              :disabled="isProcessing"
              data-testid="trade-mode-buy"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[110px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'buy'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <ShoppingCart :size="13" :stroke-width="2" />
              Buy
            </button>
            <button
              type="button"
              @click="setMode('sell')"
              :disabled="isProcessing"
              data-testid="trade-mode-sell"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[110px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'sell'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Undo2 :size="13" :stroke-width="2" />
              Sell
            </button>
          </div>

          <!-- ── Success states ─────────────────────────────────────── -->
          <div
            v-if="showSuccess && mode === 'buy'"
            data-testid="buy-success-card"
            class="flex flex-col items-center gap-5 py-6"
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
                Purchase confirmed
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                PUSDC was pulled and shares minted atomically — the exact amount was never in cleartext on-chain.
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">Make another purchase</MButton>
          </div>

          <!-- Sell — instant -->
          <div
            v-else-if="showSuccess && mode === 'sell' && settledAs === 'instant'"
            data-testid="redeem-instant-success-card"
            class="flex flex-col items-center gap-5 py-6"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <Zap :size="30" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Redemption confirmed
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                Shares burned and PUSDC paid out in a single tx — your new balance is encrypted to this session.
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">Redeem more</MButton>
          </div>

          <!-- Sell — queued -->
          <div
            v-else-if="showSuccess && mode === 'sell' && settledAs === 'queued'"
            data-testid="redeem-queued-success-card"
            class="flex flex-col items-center gap-5 py-6"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-gold/15 border border-gold/30 dark:bg-signal/15 dark:border-signal/30 flex items-center justify-center"
            >
              <Inbox :size="30" :stroke-width="1.8" class="text-gold dark:text-signal" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Added to redemption queue
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                Instant cap was already used this epoch — your shares moved to the queue and will settle next round.
              </p>
              <p v-if="queuedRequestId !== null" class="font-mono text-[11px] text-cool pt-2">
                request id:
                <span class="text-midnight dark:text-white tabular-nums">#{{ queuedRequestId.toString() }}</span>
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <div class="flex gap-3">
              <MButton variant="outline" @click="resetForm">Redeem more</MButton>
              <MButton @click="router.push('/redemptions')">Track in Redemptions</MButton>
            </div>
          </div>

          <!-- Error state -->
          <div
            v-else-if="errMsg"
            :data-testid="mode === 'buy' ? 'buy-error-card' : 'redeem-error-card'"
            class="flex flex-col items-center gap-5 py-8"
          >
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">
              Something went wrong
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <!-- Form -->
          <div v-else class="flex flex-col gap-8">
            <!-- KYC status row -->
            <div
              v-if="isVerified === false && devModeActive !== true"
              class="rounded-lg p-4 border border-negative/30 bg-negative/5 flex items-start gap-3"
              :data-testid="mode === 'buy' ? 'buy-kyc-blocked' : 'redeem-kyc-blocked'"
            >
              <AlertTriangle :size="18" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
              <div>
                <p class="font-sans text-sm font-semibold text-negative">KYC required</p>
                <p class="font-sans text-xs text-cool mt-0.5 leading-relaxed">
                  Your account is not whitelisted on the IdentityRegistry. Contact the issuer
                  to be added, or ask an admin to enable dev-mode for demo access.
                </p>
              </div>
            </div>

            <!-- Token selector -->
            <div v-if="marketplace.filtered.length > 0" class="flex flex-col gap-3">
              <label
                :for="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium"
              >
                {{ mode === 'buy' ? 'Select Asset' : 'Redeem From' }}
              </label>
              <div class="relative">
                <select
                  :id="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                  v-model="selectedToken"
                  :disabled="isProcessing"
                  :data-testid="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                  class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                         text-midnight dark:text-white font-sans text-sm md:text-base py-3 pl-1 pr-10
                         focus:outline-none focus:border-gold dark:focus:border-signal
                         transition-colors appearance-none cursor-pointer disabled:opacity-50"
                >
                  <option v-for="t in marketplace.filtered" :key="t.address" :value="t.address">
                    {{ t.name }} ({{ t.symbol }}) — {{ t.apy ? `${t.apy}% APY` : 'N/A' }}
                  </option>
                </select>
                <ChevronDown :size="16" :stroke-width="1.6" class="absolute right-2 top-1/2 -translate-y-1/2 text-cool pointer-events-none" />
              </div>

              <!-- NAV freshness banner -->
              <div
                v-if="nav !== null"
                class="flex items-center justify-between text-[11px] font-sans text-cool tabular-nums"
                :data-testid="mode === 'buy' ? 'buy-nav-readout' : 'sell-nav-readout'"
              >
                <span class="inline-flex items-center gap-1.5">
                  <span
                    :class="[
                      'w-1.5 h-1.5 rounded-full',
                      isFresh ? 'bg-positive' : 'bg-negative',
                    ]"
                  />
                  {{ isFresh ? 'NAV fresh' : 'NAV stale — ' + (mode === 'buy' ? 'purchase' : 'redeem') + ' will revert' }}
                </span>
                <span>
                  NAV: <span class="text-midnight dark:text-white">${{ (Number(nav) / 1e6).toFixed(4) }}</span>
                  <span v-if="navUpdatedAt" class="ml-2">
                    ({{ Math.max(0, Math.floor((Date.now() / 1000 - Number(navUpdatedAt)) / 60)) }}m ago)
                  </span>
                </span>
              </div>
            </div>

            <!-- ── Sell-only: holdings + cap readout ───────────── -->
            <div v-if="mode === 'sell' && selectedToken" class="flex flex-col gap-3">
              <div
                class="rounded-lg p-4 border border-haze dark:border-white/8
                       bg-mist/30 dark:bg-[#1c1b1b]/60 flex flex-col gap-3"
                data-testid="sell-holding-card"
              >
                <div class="flex items-center justify-between">
                  <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-medium">
                    Your holding
                  </span>
                  <button
                    v-if="holdingBalance === null"
                    type="button"
                    @click="decryptHoldingBalance"
                    :disabled="holdingDecrypting"
                    data-testid="sell-reveal-balance"
                    class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium
                           text-compute dark:text-signal hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-50"
                  >
                    <Loader2 v-if="holdingDecrypting" :size="11" class="animate-spin" />
                    <Eye v-else :size="11" />
                    Reveal
                  </button>
                </div>
                <div class="flex items-end justify-between gap-3">
                  <span
                    class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight"
                    data-testid="sell-holding-readout"
                  >
                    <template v-if="holdingBalance !== null">
                      {{ holdingBalance.toString() }}
                    </template>
                    <template v-else>
                      <span class="text-cool/50 font-sans not-italic text-base">— shares (encrypted)</span>
                    </template>
                  </span>
                  <div v-if="holdingBalance !== null && holdingBalance > 0n" class="flex gap-2">
                    <button
                      type="button"
                      @click="fillHalf"
                      :disabled="isProcessing"
                      data-testid="sell-fill-half"
                      class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                             bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                             text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                             border border-haze dark:border-white/10
                             px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                    >
                      Half
                    </button>
                    <button
                      type="button"
                      @click="fillMax"
                      :disabled="isProcessing"
                      data-testid="sell-fill-max"
                      class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                             bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                             text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                             border border-haze dark:border-white/10
                             px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                    >
                      Max
                    </button>
                  </div>
                </div>
                <div class="flex items-center justify-between text-[11px] font-sans text-cool tabular-nums pt-1 border-t border-haze/60 dark:border-white/5">
                  <span class="inline-flex items-center gap-1.5">
                    <Zap :size="11" :stroke-width="2" class="text-cool" />
                    Instant cap left
                  </span>
                  <span data-testid="sell-instant-cap">
                    <template v-if="capLoading">
                      <Loader2 :size="10" class="animate-spin inline" />
                    </template>
                    <template v-else-if="instantCapRemaining !== null">
                      <span class="text-midnight dark:text-white">
                        {{ formatUSD(Number(instantCapRemaining) / 1e6) }}
                      </span>
                    </template>
                    <template v-else>—</template>
                  </span>
                </div>
              </div>

              <!-- Will-escalate amber banner -->
              <div
                v-if="willEscalate"
                data-testid="sell-escalate-warning"
                class="rounded-lg p-3.5 border border-gold/30 dark:border-signal/30
                       bg-gold/8 dark:bg-signal/8 flex items-start gap-3"
              >
                <Inbox :size="15" :stroke-width="1.8" class="text-gold dark:text-signal mt-0.5 flex-shrink-0" />
                <p class="font-sans text-[11px] text-cool leading-relaxed">
                  This redemption exceeds the instant cap. Subscription will silently escalate to the redemption queue —
                  you'll claim PUSDC after the next epoch settles.
                </p>
              </div>

              <!-- Exceeds-holding revert warning -->
              <div
                v-if="exceedsHolding"
                data-testid="sell-exceeds-holding"
                class="rounded-lg p-3.5 border border-negative/30 bg-negative/5 flex items-start gap-3"
              >
                <AlertTriangle :size="15" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
                <p class="font-sans text-[11px] text-cool leading-relaxed">
                  Amount exceeds your decrypted holding. The contract would silent-fail — bring the amount down.
                </p>
              </div>
            </div>

            <!-- Amount input -->
            <div class="flex flex-col gap-3">
              <label
                :for="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium"
              >
                {{ mode === 'buy' ? 'Shares (18 decimals)' : 'Shares to redeem' }}
              </label>
              <div
                class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2
                       transition-colors focus-within:border-gold dark:focus-within:border-signal"
              >
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">#</span>
                <input
                  :id="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Share amount"
                  :disabled="isProcessing"
                  :data-testid="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
                <!-- Buy: quick amounts. Sell: covered by Half/Max above. -->
                <div v-if="mode === 'buy'" class="flex gap-2">
                  <button
                    v-for="qa in quickAmounts"
                    :key="qa"
                    type="button"
                    @click="amount = qa"
                    :disabled="isProcessing"
                    :data-testid="`buy-quick-${qa}`"
                    class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                           bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                           text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                           border border-haze dark:border-white/10
                           px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                  >
                    {{ Number(qa).toLocaleString() }}
                  </button>
                </div>
                <span v-else aria-hidden="true" />

                <span
                  v-if="numericAmount > 0"
                  class="flex items-center gap-1.5 font-sans text-xs text-compute dark:text-signal tabular-nums"
                >
                  <TrendingUp :size="13" :stroke-width="1.8" />
                  <span class="text-cool">{{ mode === 'buy' ? 'Est. position:' : 'Est. payout:' }}</span>
                  <span class="font-medium">${{ positionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}</span>
                  <span v-if="mode === 'buy'" class="text-cool">· mo. yield ${{ estimatedYield }}</span>
                </span>
              </div>
              <p class="font-sans text-[10px] text-cool/80 leading-relaxed">
                Silent-fail bounded by <span class="font-mono">maxSharesHint = shares × {{ HINT_HEADROOM.toFixed(2) }}</span>.
                Over-commit is safe — the contract zeros out above the hint.
              </p>
            </div>

            <!-- CTA -->
            <button
              type="button"
              @click="handleSubmit"
              :disabled="ctaDisabled"
              :data-testid="mode === 'buy' ? 'buy-cta' : 'redeem-cta'"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <ShieldCheck v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">{{ ctaLabel }}</span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>

            <!-- mhUSDC pre-flight: surface the silent-fail risk + an
                 inline wrap CTA. Only shown in buy mode when the wrapper
                 is configured AND the user has decrypted their mhUSDC
                 balance and it falls short of the estimated cost. -->
            <div
              v-if="mode === 'buy' && insufficientMhUsdc"
              data-testid="buy-insufficient-mhusdc"
              class="rounded-lg p-4 border border-gold/35 dark:border-signal/30
                     bg-gold/8 dark:bg-signal/8 flex flex-col gap-3"
            >
              <div class="flex items-start gap-3">
                <Coins :size="16" :stroke-width="1.8" class="text-gold dark:text-signal mt-0.5 flex-shrink-0" />
                <div class="flex-1 space-y-1">
                  <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                    Not enough mhUSDC for this buy
                  </p>
                  <p class="font-sans text-[11px] text-cool leading-relaxed">
                    Your decrypted mhUSDC balance is below the estimated cost.
                    The Subscription pull would silent-fail to zero — wrap more
                    PUSDC first to keep the buy intact.
                  </p>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-3 pl-7">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool tabular-nums">
                  have <span class="text-midnight dark:text-white">{{ mhUsdcBalance !== null ? formatUSD(Number(mhUsdcBalance) / 1e6) : '—' }}</span>
                  · need <span class="text-midnight dark:text-white">{{ estimatedCostPusdc !== null ? formatUSD(Number(estimatedCostPusdc) / 1e6) : '—' }}</span>
                </span>
                <button
                  type="button"
                  @click="goWrap"
                  data-testid="buy-wrap-mhusdc-cta"
                  class="ml-auto inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold
                         text-compute dark:text-signal hover:opacity-80 transition-opacity cursor-pointer"
                >
                  Wrap PUSDC
                  <ArrowRight :size="11" :stroke-width="2" />
                </button>
              </div>
            </div>

            <!-- mhUSDC reveal — opt-in. Hidden once decrypted; the
                 banner above takes over when the balance lands short. -->
            <div
              v-if="mode === 'buy' && mhUsdcAvailable && mhUsdcBalance === null"
              class="flex items-center justify-between gap-2 rounded-lg p-3
                     border border-haze dark:border-white/8 bg-mist/30 dark:bg-[#1c1b1b]/60"
            >
              <div class="flex items-center gap-2">
                <Coins :size="14" :stroke-width="1.8" class="text-cool" />
                <span class="font-sans text-[11px] text-cool leading-tight">
                  Pre-flight: reveal mhUSDC balance to catch silent-fail pulls.
                </span>
              </div>
              <button
                type="button"
                @click="decryptMhUsdcBalance"
                :disabled="mhUsdcDecrypting"
                data-testid="buy-reveal-mhusdc"
                class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold
                       text-compute dark:text-signal hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-50"
              >
                <Loader2 v-if="mhUsdcDecrypting" :size="11" class="animate-spin" />
                <Eye v-else :size="11" />
                Reveal
              </button>
            </div>

            <!-- Wrap link only makes sense in Buy mode -->
            <button
              v-if="mode === 'buy'"
              type="button"
              @click="goWrap"
              data-testid="buy-wrap-link"
              class="font-sans text-[11px] uppercase tracking-[0.22em] font-medium
                     text-cool hover:text-compute dark:hover:text-signal transition-colors
                     inline-flex items-center justify-center gap-1.5 self-center cursor-pointer"
            >
              {{ mhUsdcAvailable ? 'Or wrap an external ERC-20 token' : 'Or wrap an external ERC-20 token' }}
              <ArrowRight :size="11" :stroke-width="2" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Aside: balances + progress rail -->
    <Teleport to="body" :disabled="!isXl">
      <aside
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
        class="mt-10 xl:mt-0 flex flex-col gap-8 w-full
               xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
               xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
      >
        <div>
          <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">
            {{ mode === 'buy' ? 'Fund Your Account' : 'Account Snapshot' }}
          </h2>
          <div class="flex flex-col gap-5">
            <div class="flex flex-col gap-2">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Your Kernel Address</span>
              <div class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex items-center justify-between gap-3">
                <span class="font-mono text-xs text-compute dark:text-signal truncate">{{ address ?? '—' }}</span>
                <button
                  type="button"
                  @click="copyAddress"
                  :disabled="!address"
                  aria-label="Copy kernel address"
                  class="text-cool hover:text-compute dark:hover:text-signal transition-colors flex-shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check v-if="copied" :size="14" />
                  <Copy v-else :size="14" />
                </button>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <div class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">USDC Balance</span>
                <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums">
                  {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}
                </span>
              </div>
              <div class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Platform Balance</span>
                <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums">
                  {{ formattedBackendBalance ?? '$0.00' }}
                </span>
              </div>
            </div>

            <div class="flex items-center justify-between">
              <button
                type="button"
                @click="loadBalances"
                :disabled="balancesLoading || !address"
                class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium
                       text-cool hover:text-compute dark:hover:text-signal transition-colors
                       cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw :size="12" :class="balancesLoading && 'animate-spin'" />
                Refresh
              </button>
              <a
                v-if="mode === 'buy' && usdcBalance !== null && usdcBalance === 0n"
                :href="CIRCLE_FAUCET_URL"
                target="_blank"
                rel="noopener"
                data-testid="fund-account-faucet-link"
                class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-gold hover:text-gold/80 transition-colors"
              >
                Circle faucet
                <ExternalLink :size="11" />
              </a>
            </div>
          </div>
        </div>

        <!-- Progress rail -->
        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">
            Current Step
          </h3>
          <div class="relative flex flex-col gap-8">
            <div
              aria-hidden="true"
              class="absolute top-2.5 bottom-2.5 left-[10px] -translate-x-1/2 w-px bg-haze dark:bg-white/10"
            />
            <div
              aria-hidden="true"
              class="absolute top-2.5 left-[10px] -translate-x-1/2 w-px bg-gold dark:bg-signal shadow-[0_0_10px_rgba(255,186,32,0.5)] dark:shadow-[0_0_10px_rgba(255,220,161,0.5)] transition-all duration-500"
              :style="{ height: `${railHeight}%` }"
            />
            <div
              v-for="(s, i) in steps"
              :key="s.label"
              :class="['flex items-center gap-5 relative transition-opacity', i > currentStep && 'opacity-50']"
            >
              <div
                :class="[
                  'w-5 h-5 rounded-full flex-shrink-0 z-10 flex items-center justify-center transition-all',
                  i < currentStep
                    ? 'bg-gold dark:bg-signal'
                    : i === currentStep
                      ? 'bg-gold dark:bg-signal ring-4 ring-gold/10 dark:ring-signal/15 shadow-[0_0_15px_rgba(255,186,32,0.4)] dark:shadow-[0_0_15px_rgba(255,220,161,0.4)]'
                      : 'bg-mist/60 dark:bg-[#1c1b1b] border border-haze dark:border-white/15',
                ]"
              >
                <div v-if="i <= currentStep" class="w-2 h-2 rounded-full bg-white dark:bg-midnight" />
              </div>
              <div class="flex flex-col">
                <span
                  :class="[
                    'font-sans text-xs uppercase tracking-[0.22em] font-bold',
                    i <= currentStep ? 'text-compute dark:text-signal' : 'text-midnight dark:text-white',
                  ]"
                >{{ s.label }}</span>
                <span class="font-accent italic text-[11px] text-cool mt-0.5">{{ s.description }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">
            Security Notice
          </h3>
          <div class="rounded-lg p-4 border border-compute/20 dark:border-signal/20 bg-compute/5 dark:bg-signal/5 flex items-start gap-3">
            <EyeOff :size="16" :stroke-width="1.8" class="text-compute dark:text-signal mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              {{ mode === 'buy'
                ? 'Shares are encrypted client-side via Fhenix FHE. An ephemeral EOA is granted permit-decrypt rights so only this browser session can read the new balance.'
                : 'Burn amount + payout are encrypted client-side via Fhenix FHE. The same ephemeral EOA decrypts your post-burn balance — only this browser session can see it.' }}
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
