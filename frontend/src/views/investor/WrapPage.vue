<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { StableClient } from '@muhaven/sdk'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { buildWriteContext } from '@/services/v35/context'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as LegacyPusdcService from '@/services/contracts/LegacyPusdcService'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { balanceApi } from '@/services/api'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import {
  CheckCircle2, Lock, Shield, EyeOff, ArrowRight, Loader2, Copy, Check,
  RefreshCw, ExternalLink, Coins, Layers,
} from 'lucide-vue-next'

// WrapPage — Phase 7.5 two-mode wizard.
//
//   • "Cash" mode (default, when MuHavenStable is configured):
//       legacy PUSDC → mhUSDC via `MuHavenStable.wrap`. Investors land
//       here from the TradePage "wrap PUSDC first" CTA when their mhUSDC
//       balance is short of their intended buy.
//
//   • "Asset" mode (existing Wave 3 RWA wrap):
//       underlying ERC-20 RWA → fhERC-20 RWA via `MuHavenVault.wrap`.
//       Unchanged path for issuers/admins onboarding tokenised assets.
//
// The mode toggle defaults to Cash when the wrapper is wired; otherwise
// Asset is the only supported mode and the toggle is hidden.

type Mode = 'cash' | 'asset'

const { address, connected } = useWallet()
const { initialize: initFhe, getEphemeralEOA } = useFhe()

const isXl = useMediaQuery('(min-width: 1280px)')

const wrapperAvailable = computed(() => MuHavenStableService.isAvailable())

const mode = ref<Mode>(wrapperAvailable.value ? 'cash' : 'asset')

const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const errMsg = ref<string | null>(null)

// Cash-mode operator state — once granted, future wraps skip the approval.
const operatorSet = ref<boolean | null>(null)

const cashSteps = [
  { label: 'Enter Amount', description: 'How much USDC to convert' },
  { label: 'Approve USDC', description: 'ERC-20 allowance for the PUSDC layer' },
  { label: 'Mint mhUSDC', description: 'USDC → encrypted mhUSDC, ready to spend' },
]
const assetSteps = [
  { label: 'Enter Amount', description: 'Define wrap amount' },
  { label: 'Approve', description: 'Approve ERC-20 to vault' },
  { label: 'Wrap', description: 'Wrap into fhERC-20' },
]
const steps = computed(() => mode.value === 'cash' ? cashSteps : assetSteps)
const railHeight = computed(() => Math.min(100, ((currentStep.value + 1) / steps.value.length) * 100))

const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

// ── Wallet aside readouts ──────────────────────────────────────────────

const copied = ref(false)
const balancesLoading = ref(false)
const usdcBalance = ref<bigint | null>(null)
const pusdcPublicBalance = ref<bigint | null>(null)
const formattedBackendBalance = ref<string | null>(null)

async function loadBalances() {
  if (!address.value) return
  balancesLoading.value = true
  try {
    const [usdc, pusdc, backend] = await Promise.allSettled([
      Erc20Service.balanceOf(addresses.usdc, address.value as `0x${string}`),
      LegacyPusdcService.balanceOf(address.value as `0x${string}`),
      balanceApi.get(),
    ])
    usdcBalance.value = usdc.status === 'fulfilled' ? usdc.value : null
    pusdcPublicBalance.value = pusdc.status === 'fulfilled' ? pusdc.value : null
    formattedBackendBalance.value = backend.status === 'fulfilled' ? backend.value.formatted_balance : null
  } finally {
    balancesLoading.value = false
  }
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
    console.warn('[WrapPage] operator status read failed', e)
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
  }
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

    // ── Step 2 (display) → Approve USDC for the PUSDC contract ───────
    // Approve only when allowance < amount. Approve `amountUnits` exactly
    // (not max) so the surface area stays tight; investors who repeat
    // wraps will pay a fresh approve each time but it's a 1-tx ERC-20
    // call — minor cost vs. perpetual unlimited approval risk.
    currentStep.value = 1
    const allowance = await Erc20Service.allowance(
      addresses.usdc, kernel, addresses.pusdc,
    )
    if (allowance < amountUnits) {
      await Erc20Service.approve(addresses.usdc, addresses.pusdc, amountUnits)
      toast.info('USDC approved', {
        description: 'PUSDC contract can now pull your USDC',
      })
    }

    // ── Step 3 (display) → USDC → PUSDC → mhUSDC ─────────────────────
    currentStep.value = 2

    // (a) USDC → PUSDC. Mints PUSDC to the kernel.
    await LegacyPusdcService.wrap(kernel, amountUnits)

    // (b) PUSDC operator approval on MuHavenStable, if missing. Wraps
    //     2 and onward skip this step — operator is granted with a
    //     long expiry.
    if (operatorSet.value !== true) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
      await LegacyPusdcService.setOperator(v35Addresses.muHavenStable, expiry)
      operatorSet.value = true
    }

    // (c) PUSDC → mhUSDC via the SDK (encrypts client-side, grants ACL
    //     on the new mhUSDC handle to the active session EOA).
    await initFhe()
    const ctx = await buildWriteContext()
    const stable = new StableClient(ctx, v35Addresses.muHavenStable)
    const eph = getEphemeralEOA() as `0x${string}`

    const hash = await stable.wrap(amountUnits, eph)
    txHash.value = hash
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: 'USDC converted 1:1 into mhUSDC — ready for atomic buys.',
    })
    loadBalances()
  } catch (e) {
    // Print the full error CHAIN — TxFailedError wraps the underlying
    // viem/sender error in `cause`, but `toast.error` only shows the
    // top-level message. Walking `cause` here reveals the actual revert
    // reason / RPC error / encoding issue underneath. Without this, a
    // bare "Transaction failed for MuHavenStable.wrap (not submitted)"
    // hides whatever viem actually saw.
    console.error('[WrapPage] cash wrap failed — full chain:')
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      const isErr = cur instanceof Error
      console.error(`  [${depth}] ${isErr ? cur.constructor.name : typeof cur}:`, cur)
      if (isErr && 'cause' in cur && cur.cause) {
        cur = cur.cause
        depth += 1
      } else {
        break
      }
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

    currentStep.value = 1
    const underlying = await VaultService.underlyingToken()
    await Erc20Service.approve(underlying, addresses.muHavenVault, amountWei)

    currentStep.value = 2
    const hash = await VaultService.wrap(amountWei)

    txHash.value = hash
    currentStep.value = 3
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
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
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
          <!-- Mode toggle — only when both flows are available -->
          <div
            v-if="!showSuccess && !errMsg && wrapperAvailable"
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
            <MButton variant="outline" @click="resetForm">Make another wrap</MButton>
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
                1:1 backed: every wrapped PUSDC stays held by the wrapper as collateral. Unwrap any time.
              </p>
            </div>

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
        <div>
          <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">Fund Your Account</h2>
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
              <div
                class="rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1"
                title="ERC-7984 cleartext shadow only. Your full PUSDC holding lives in `confidentialBalanceOf` — encrypted, not shown here. The Convert flow operates on the encrypted balance via `confidentialTransferFrom`."
              >
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Legacy PUSDC (cleartext shadow)</span>
                <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums" data-testid="wrap-pusdc-public-balance">
                  {{ pusdcPublicBalance !== null ? formatUSD(Number(pusdcPublicBalance) / 1e6, 4) : '—' }}
                </span>
                <span class="font-sans text-[9px] text-cool/70 leading-tight">
                  Tiny dust slice. Bulk holding is encrypted in
                  <code class="font-mono">confidentialBalanceOf</code>.
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
                class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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

        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">Current Step</h3>
          <div class="relative flex flex-col gap-8">
            <div aria-hidden="true" class="absolute top-2.5 bottom-2.5 left-[10px] -translate-x-1/2 w-px bg-haze dark:bg-white/10" />
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
                  i < currentStep ? 'bg-gold dark:bg-signal'
                    : i === currentStep ? 'bg-gold dark:bg-signal ring-4 ring-gold/10 dark:ring-signal/15 shadow-[0_0_15px_rgba(255,186,32,0.4)] dark:shadow-[0_0_15px_rgba(255,220,161,0.4)]'
                      : 'bg-mist/60 dark:bg-[#1c1b1b] border border-haze dark:border-white/15',
                ]"
              >
                <div v-if="i <= currentStep" class="w-2 h-2 rounded-full bg-white dark:bg-midnight" />
              </div>
              <div class="flex flex-col">
                <span :class="[
                  'font-sans text-xs uppercase tracking-[0.22em] font-bold',
                  i <= currentStep ? 'text-compute dark:text-signal' : 'text-midnight dark:text-white',
                ]">{{ s.label }}</span>
                <span class="font-accent italic text-[11px] text-cool mt-0.5">{{ s.description }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">Security Notice</h3>
          <div class="rounded-lg p-4 border border-gold/25 bg-gold/5 flex items-start gap-3">
            <EyeOff :size="16" :stroke-width="1.8" class="text-gold mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              {{ mode === 'cash'
                ? 'PUSDC pull amount is encrypted via Fhenix FHE. mhUSDC balance grants decrypt rights to this session only.'
                : 'ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.' }}
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
