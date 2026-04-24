<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { SubscriptionClient, OracleClient, IdentityRegistryClient } from '@muhaven/sdk'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext, buildReadContext } from '@/services/v35/context'
import { portfolioApi, balanceApi, type TokenResponseDto } from '@/services/api'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { addresses } from '@/contracts/addresses'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import {
  CheckCircle2, Lock, ShieldCheck, EyeOff, TrendingUp, ChevronDown, ArrowRight,
  Loader2, Copy, Check, RefreshCw, ExternalLink, AlertTriangle,
} from 'lucide-vue-next'

// BuyPage — Wave 3.5 atomic purchase against MuHavenSubscription.purchase.
// The investor picks a token, provides a cleartext share amount, and the
// contract pulls PUSDC + mints shares atomically. All amounts are encrypted
// client-side; the cleartext `maxSharesHint` is the upper bound the investor
// commits to for compliance + cap accounting (ADR-004).

const route = useRoute()
const router = useRouter()
const marketplace = useMarketplaceStore()
const { address, connected } = useWallet()
const { encryptUint128, getEphemeralEOA } = useFhe()

const isXl = useMediaQuery('(min-width: 1280px)')

// ── Form state ─────────────────────────────────────────────────────────

const selectedToken = ref<string>('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const errMsg = ref<string | null>(null)

const steps = [
  { label: 'Enter Amount', description: 'Pick shares + max hint' },
  { label: 'Encrypt', description: 'FHE inputs client-side' },
  { label: 'Purchase', description: 'Subscription.purchase() atomic buy' },
]

const railHeight = computed(() => Math.min(100, ((currentStep.value + 1) / steps.length) * 100))
const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

const selectedTokenData = computed<TokenResponseDto | undefined>(() =>
  selectedToken.value ? marketplace.getByAddress(selectedToken.value) : undefined,
)

// `maxSharesHint` defaults to 10% above the requested amount per FLOWS.md
// suggestion. Silent-fail protects against over-purchase anyway — the hint
// is about cap accounting, not the actual cap.
const HINT_HEADROOM = 1.1

// Shares * NAV_$ = position_$. NAV from oracle is in PUSDC base units (6
// decimals), so divide by 1e6 to get $/share. Fall back to the marketplace
// API's latest_nav if oracle isn't configured.
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
    // Oracle may be unconfigured on staging — log quietly, UI falls back
    // to the API-reported NAV from the marketplace store.
    console.warn('[BuyPage] oracle read failed:', e)
  } finally {
    navLoading.value = false
  }
}

watch(selectedToken, () => { refreshNav() })

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
    console.warn('[BuyPage] KYC read failed:', e)
  }
}

watch(connected, (val) => { if (val) refreshKyc() })

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

  const queryToken = route.query.token as string | undefined
  if (queryToken && marketplace.getByAddress(queryToken)) {
    selectedToken.value = queryToken
  } else if (marketplace.filtered.length > 0 && !selectedToken.value) {
    selectedToken.value = marketplace.filtered[0].address
  }
})

// ── Purchase handler ────────────────────────────────────────────────────

function goWrap() {
  router.push('/wrap')
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
    // `FHE.mul(shares, nav)` produces PUSDC base units (6-decimal). Scaling
    // by 1e18 would overflow the ADR-031 `CostOverflowsPUSDCWidth` cleartext
    // guard (`hint * nav <= uint64.max`). See MuHavenSubscription.sol L48-56
    // + test fixtures ("5 shares @ NAV 1_000_000 → 5 PUSDC").
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
          // Progress events propagate to the status rail; `purchase` emits
          // `encrypt` then `purchase`. Map to step indices.
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

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
}
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
          class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none
                 bg-gold/8 dark:bg-signal/8"
        />

        <div class="p-8 md:p-10 relative">
          <!-- Success state -->
          <div
            v-if="showSuccess"
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

          <!-- Error state -->
          <div
            v-else-if="errMsg"
            data-testid="buy-error-card"
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
              data-testid="buy-kyc-blocked"
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
              <label for="buy-token-select" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Select Asset
              </label>
              <div class="relative">
                <select
                  id="buy-token-select"
                  v-model="selectedToken"
                  :disabled="isProcessing"
                  data-testid="buy-token-select"
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
                data-testid="buy-nav-readout"
              >
                <span class="inline-flex items-center gap-1.5">
                  <span
                    :class="[
                      'w-1.5 h-1.5 rounded-full',
                      isFresh ? 'bg-positive' : 'bg-negative',
                    ]"
                  />
                  {{ isFresh ? 'NAV fresh' : 'NAV stale — purchase will revert' }}
                </span>
                <span>
                  NAV: <span class="text-midnight dark:text-white">${{ (Number(nav) / 1e6).toFixed(4) }}</span>
                  <span v-if="navUpdatedAt" class="ml-2">
                    ({{ Math.max(0, Math.floor((Date.now() / 1000 - Number(navUpdatedAt)) / 60)) }}m ago)
                  </span>
                </span>
              </div>
            </div>

            <!-- Amount input -->
            <div class="flex flex-col gap-3">
              <label for="buy-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Shares (18 decimals)
              </label>
              <div
                class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2
                       transition-colors focus-within:border-gold dark:focus-within:border-signal"
              >
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">#</span>
                <input
                  id="buy-amount-input"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Share amount"
                  :disabled="isProcessing"
                  data-testid="buy-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div class="flex gap-2">
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
                <span
                  v-if="numericAmount > 0"
                  class="flex items-center gap-1.5 font-sans text-xs text-compute dark:text-signal tabular-nums"
                >
                  <TrendingUp :size="13" :stroke-width="1.8" />
                  <span class="text-cool">Est. position:</span>
                  <span class="font-medium">${{ positionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}</span>
                  <span class="text-cool">· mo. yield ${{ estimatedYield }}</span>
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
              @click="handlePurchase"
              :disabled="isProcessing || !amount.trim() || numericAmount <= 0 || (isVerified === false && devModeActive !== true)"
              data-testid="buy-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <ShieldCheck v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">
                {{ isProcessing ? 'Encrypting & purchasing…' : 'Encrypt & Purchase' }}
              </span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>

            <!-- Wrap link -->
            <button
              type="button"
              @click="goWrap"
              data-testid="buy-wrap-link"
              class="font-sans text-[11px] uppercase tracking-[0.22em] font-medium
                     text-cool hover:text-compute dark:hover:text-signal transition-colors
                     inline-flex items-center justify-center gap-1.5 self-center cursor-pointer"
            >
              Or wrap an external ERC-20 token
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
            Fund Your Account
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
                v-if="usdcBalance !== null && usdcBalance === 0n"
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
              Shares are encrypted client-side via Fhenix FHE. An ephemeral EOA is granted permit-decrypt
              rights so only this browser session can read the new balance.
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
