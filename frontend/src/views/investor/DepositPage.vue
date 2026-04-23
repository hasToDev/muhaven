<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import * as TokenService from '@/services/contracts/TokenService'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { addresses } from '@/contracts/addresses'
import { portfolioApi, balanceApi, type TokenResponseDto } from '@/services/api'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPrivacyProofPanel, { type ProofIntent } from '@/components/ui/MPrivacyProofPanel.vue'
import {
  CheckCircle2, Lock, Shield, EyeOff, TrendingUp, ChevronDown, ArrowRight, KeyRound,
  Loader2, Sparkles, Copy, Check, RefreshCw, ExternalLink,
} from 'lucide-vue-next'

const route = useRoute()
const marketplace = useMarketplaceStore()
const { address, connected } = useWallet()
const { encryptUint128 } = useFhe()

// Teleport the aside to <body> on xl+ so `position: fixed` is viewport-relative.
// Without teleport, the page transition's `transform` on the wrapper makes
// `xl:fixed` resolve against the wrapper instead of the viewport, causing
// the aside to "jump" from in-flow to fixed-right when the transform clears.
const isXl = useMediaQuery('(min-width: 1280px)')

// ── Form state ─────────────────────────────────────────────────────────

type DepositPath = 'encrypted-mint' | 'vault-wrap'
const depositPath = ref<DepositPath>('encrypted-mint')
const selectedToken = ref<string>('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const txIntent = ref<ProofIntent | null>(null)
const error = ref<string | null>(null)

const stepsEncrypted = [
  { label: 'Enter Amount', description: 'Define your deposit value' },
  { label: 'Encrypt', description: 'Secure FHE client-side encryption' },
  { label: 'Submit', description: 'Finalize transaction to vault' },
]

const stepsVaultWrap = [
  { label: 'Enter Amount', description: 'Define wrap amount' },
  { label: 'Approve', description: 'Approve ERC-20 to vault' },
  { label: 'Wrap', description: 'Wrap into fhERC-20' },
]

const steps = computed(() => depositPath.value === 'encrypted-mint' ? stepsEncrypted : stepsVaultWrap)

const railHeight = computed(() => {
  const len = steps.value.length
  return Math.min(100, ((currentStep.value + 1) / len) * 100)
})

const quickAmounts = ['100', '1000', '5000']

const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

const selectedTokenData = computed<TokenResponseDto | undefined>(() =>
  selectedToken.value ? marketplace.getByAddress(selectedToken.value) : undefined,
)

const estimatedYield = computed(() => {
  const apy = selectedTokenData.value?.apy ? parseFloat(selectedTokenData.value.apy) : 4.8
  return (numericAmount.value * apy / 100 / 12).toFixed(2)
})

// ── Wallet aside (vault address + balances) ────────────────────────────

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

watch(connected, (val) => {
  if (val) loadBalances()
})

onMounted(async () => {
  if (connected.value) loadBalances()
  if (!marketplace.loaded) {
    await marketplace.load()
  }
  const queryToken = route.query.token as string | undefined
  if (queryToken && marketplace.getByAddress(queryToken)) {
    selectedToken.value = queryToken
  } else if (marketplace.filtered.length > 0 && !selectedToken.value) {
    selectedToken.value = marketplace.filtered[0].address
  }
})

// ── Deposit handlers ───────────────────────────────────────────────────

async function handleEncryptedMint() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  error.value = null

  try {
    currentStep.value = 1
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))
    const encrypted = await encryptUint128(amountWei)

    currentStep.value = 2
    const hash = await TokenService.mint(
      address.value as `0x${string}`,
      encrypted as any,
    )

    txHash.value = hash
    txIntent.value = {
      contract: 'MuHavenToken',
      functionName: 'mint',
      args: [address.value, encrypted],
    }
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Deposit confirmed', {
      description: `Encrypted mint submitted — amount never appeared in cleartext`,
    })

    if (selectedTokenData.value) {
      portfolioApi.addPosition(selectedTokenData.value.address, selectedTokenData.value.symbol).catch(() => {})
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Deposit failed'
    toast.error('Deposit failed', { description: error.value })
  } finally {
    isProcessing.value = false
  }
}

async function handleVaultWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  error.value = null

  try {
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))

    currentStep.value = 1
    const underlying = await VaultService.underlyingToken()
    await Erc20Service.approve(underlying, addresses.muHavenVault, amountWei)

    currentStep.value = 2
    const hash = await VaultService.wrap(amountWei)

    txHash.value = hash
    txIntent.value = {
      contract: 'MuHavenVault',
      functionName: 'wrap',
      args: [amountWei],
    }
    currentStep.value = 3
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: `ERC-20 wrapped into fhERC-20 — balance now encrypted on-chain`,
    })

    if (selectedTokenData.value) {
      portfolioApi.addPosition(selectedTokenData.value.address, selectedTokenData.value.symbol).catch(() => {})
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: error.value })
  } finally {
    isProcessing.value = false
  }
}

function handleDeposit() {
  if (depositPath.value === 'encrypted-mint') {
    handleEncryptedMint()
  } else {
    handleVaultWrap()
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  txIntent.value = null
  error.value = null
}
</script>

<template>
  <div>
    <!-- ── LEFT: Form (centered between sidebar + fixed aside on xl+) ── -->
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
        <!-- Top accent gradient line -->
        <div
          aria-hidden="true"
          class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent"
        />
        <!-- Ambient amber bloom -->
        <div
          aria-hidden="true"
          class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none
                 bg-gold/8 dark:bg-signal/8"
        />

        <div class="p-8 md:p-10 relative">
          <!-- Success state -->
          <div
            v-if="showSuccess"
            data-testid="deposit-success-card"
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
                {{ depositPath === 'encrypted-mint' ? 'Encrypted deposit confirmed' : 'Vault wrap confirmed' }}
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                {{ depositPath === 'encrypted-mint'
                  ? 'Amount was encrypted client-side — it never appeared in cleartext on-chain.'
                  : 'ERC-20 wrapped into fhERC-20 — your balance is now encrypted on-chain.' }}
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
            <MPrivacyProofPanel
              v-if="txHash"
              :tx-hash="txHash"
              :intent="txIntent ?? undefined"
              :default-open="true"
              class="w-full mt-2"
            />
            <MButton variant="outline" @click="resetForm">Make another deposit</MButton>
          </div>

          <!-- Error state -->
          <div
            v-else-if="error"
            data-testid="deposit-error-card"
            class="flex flex-col items-center gap-5 py-8"
          >
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">
              Something went wrong
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ error }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <!-- Form -->
          <div v-else class="flex flex-col gap-8">
            <!-- Method selector -->
            <div class="flex flex-col gap-3">
              <label class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Select Method
              </label>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  @click="depositPath = 'encrypted-mint'"
                  data-testid="deposit-path-encrypted"
                  :class="[
                    'group relative text-left rounded-xl p-4 border transition-all duration-300 cursor-pointer overflow-hidden',
                    depositPath === 'encrypted-mint'
                      ? 'border-gold/60 dark:border-signal/40 bg-gold/5 dark:bg-signal/5 shadow-[inset_0_0_20px_rgba(255,186,32,0.08)]'
                      : 'border-haze dark:border-white/5 bg-mist/40 dark:bg-[#171717] hover:border-gold/30 dark:hover:border-signal/25',
                  ]"
                >
                  <div class="flex items-start justify-between mb-3">
                    <div
                      :class="[
                        'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                        depositPath === 'encrypted-mint'
                          ? 'bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal'
                          : 'bg-haze/50 dark:bg-white/5 text-cool group-hover:text-compute dark:group-hover:text-signal',
                      ]"
                    >
                      <Lock :size="18" :stroke-width="1.8" />
                    </div>
                    <span
                      class="font-sans text-[9px] uppercase tracking-[0.2em] font-medium px-2 py-0.5 rounded border
                             text-compute dark:text-signal border-compute/25 dark:border-signal/25
                             bg-compute/8 dark:bg-signal/10"
                    >
                      Best privacy
                    </span>
                  </div>
                  <p class="font-accent italic text-lg text-midnight dark:text-white leading-tight">
                    Encrypted Mint
                  </p>
                  <p class="font-sans text-[11px] text-cool mt-1 leading-relaxed">
                    Client-side FHE — amount never in cleartext on-chain.
                  </p>
                </button>

                <button
                  type="button"
                  @click="depositPath = 'vault-wrap'"
                  data-testid="deposit-path-wrap"
                  :class="[
                    'group relative text-left rounded-xl p-4 border transition-all duration-300 cursor-pointer overflow-hidden',
                    depositPath === 'vault-wrap'
                      ? 'border-gold/60 dark:border-signal/40 bg-gold/5 dark:bg-signal/5 shadow-[inset_0_0_20px_rgba(255,186,32,0.08)]'
                      : 'border-haze dark:border-white/5 bg-mist/40 dark:bg-[#171717] hover:border-gold/30 dark:hover:border-signal/25',
                  ]"
                >
                  <div class="flex items-start justify-between mb-3">
                    <div
                      :class="[
                        'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                        depositPath === 'vault-wrap'
                          ? 'bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal'
                          : 'bg-haze/50 dark:bg-white/5 text-cool group-hover:text-compute dark:group-hover:text-signal',
                      ]"
                    >
                      <Shield :size="18" :stroke-width="1.8" />
                    </div>
                    <span
                      class="font-sans text-[9px] uppercase tracking-[0.2em] font-medium px-2 py-0.5 rounded border
                             text-slate dark:text-body-dark/70 border-haze dark:border-white/10
                             bg-haze/40 dark:bg-white/5"
                    >
                      For ERC-20
                    </span>
                  </div>
                  <p class="font-accent italic text-lg text-midnight dark:text-white leading-tight">
                    Vault Wrap
                  </p>
                  <p class="font-sans text-[11px] text-cool mt-1 leading-relaxed">
                    Wrap an existing RWA ERC-20 into a confidential fhERC-20.
                  </p>
                </button>
              </div>
            </div>

            <!-- Token selector (underline-style) -->
            <div v-if="marketplace.filtered.length > 0" class="flex flex-col gap-3">
              <label for="deposit-token-select" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Select Asset
              </label>
              <div class="relative">
                <select
                  id="deposit-token-select"
                  v-model="selectedToken"
                  :disabled="isProcessing"
                  data-testid="deposit-token-select"
                  class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                         text-midnight dark:text-white font-sans text-sm md:text-base py-3 pl-1 pr-10
                         focus:outline-none focus:border-gold dark:focus:border-signal
                         transition-colors appearance-none cursor-pointer
                         disabled:opacity-50"
                >
                  <option v-for="t in marketplace.filtered" :key="t.address" :value="t.address">
                    {{ t.name }} ({{ t.symbol }}) — {{ t.apy ? `${t.apy}% APY` : 'N/A' }}
                  </option>
                </select>
                <ChevronDown
                  :size="16"
                  :stroke-width="1.6"
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-cool pointer-events-none"
                />
              </div>
            </div>

            <!-- Amount input (large underline + quick chips + est. yield) -->
            <div class="flex flex-col gap-3">
              <label for="deposit-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Amount
              </label>
              <div
                class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2
                       transition-colors focus-within:border-gold dark:focus-within:border-signal"
              >
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">$</span>
                <input
                  id="deposit-amount-input"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Deposit amount in USD"
                  :disabled="isProcessing"
                  data-testid="deposit-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none
                         disabled:opacity-50"
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
                    :data-testid="`deposit-quick-${qa}`"
                    class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                           bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                           text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                           border border-haze dark:border-white/10
                           px-3 py-1.5 rounded transition-all duration-200 cursor-pointer
                           disabled:opacity-50"
                  >
                    ${{ Number(qa).toLocaleString() }}
                  </button>
                </div>
                <span
                  v-if="numericAmount > 0"
                  class="flex items-center gap-1.5 font-sans text-xs text-compute dark:text-signal tabular-nums"
                >
                  <TrendingUp :size="13" :stroke-width="1.8" />
                  <span class="text-cool">Est. monthly:</span>
                  <span class="font-medium">${{ estimatedYield }}</span>
                  <span class="text-cool">@ {{ selectedTokenData?.apy || '4.8' }}% APY</span>
                </span>
              </div>
            </div>

            <!-- CTA -->
            <button
              type="button"
              @click="handleDeposit"
              :disabled="isProcessing || !amount.trim() || numericAmount <= 0"
              data-testid="deposit-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5
                     mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <KeyRound v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">
                {{ isProcessing
                  ? (depositPath === 'encrypted-mint' ? 'Encrypting…' : 'Wrapping…')
                  : (depositPath === 'encrypted-mint' ? 'Encrypt & Deposit' : 'Approve & Wrap') }}
              </span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- ── RIGHT: Aside (stacked on <xl, fixed-right on xl+).
         Teleported to <body> on xl+ to escape the page-transition transform
         (which would otherwise break `position: fixed`). ─── -->
    <Teleport to="body" :disabled="!isXl">
    <aside
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
      class="mt-10 xl:mt-0 flex flex-col gap-8 w-full
             xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
             xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
    >
      <!-- Fund Your Account -->
      <div>
        <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">
          Fund Your Account
        </h2>
        <div class="flex flex-col gap-5">
          <!-- Vault address -->
          <div class="flex flex-col gap-2">
            <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Your Vault Address</span>
            <div
              class="rounded-lg p-4 border border-haze dark:border-white/8
                     bg-mist/40 dark:bg-[#1c1b1b]/60
                     flex items-center justify-between gap-3"
            >
              <span class="font-mono text-xs text-compute dark:text-signal truncate">
                {{ address ?? '—' }}
              </span>
              <button
                type="button"
                @click="copyAddress"
                :disabled="!address"
                aria-label="Copy vault address"
                class="text-cool hover:text-compute dark:hover:text-signal transition-colors flex-shrink-0
                       cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check v-if="copied" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>
          </div>

          <!-- USDC + Platform balance -->
          <div class="flex flex-col gap-3">
            <div
              class="rounded-lg p-4 border border-haze dark:border-white/8
                     bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1"
            >
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">USDC Balance</span>
              <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums">
                {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}
              </span>
            </div>
            <div
              class="rounded-lg p-4 border border-haze dark:border-white/8
                     bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1"
            >
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Platform Balance</span>
              <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums">
                {{ formattedBackendBalance ?? '$0.00' }}
              </span>
            </div>
          </div>

          <!-- Refresh + faucet -->
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
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium
                     text-gold hover:text-gold/80 transition-colors"
            >
              Circle faucet
              <ExternalLink :size="11" />
            </a>
          </div>
        </div>
      </div>

      <!-- Current Step (vertical stepper) -->
      <div class="pt-8 border-t border-haze dark:border-white/8">
        <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-6">
          Current Step
        </h3>
        <div class="relative flex flex-col gap-8">
          <!-- vertical rail (1px wide, perfectly centered on dot center at x=10) -->
          <div
            aria-hidden="true"
            class="absolute top-2.5 bottom-2.5 left-[10px] -translate-x-1/2 w-px bg-haze dark:bg-white/10"
          />
          <!-- progress overlay -->
          <div
            aria-hidden="true"
            class="absolute top-2.5 left-[10px] -translate-x-1/2 w-px bg-gold dark:bg-signal
                   shadow-[0_0_10px_rgba(255,186,32,0.5)] dark:shadow-[0_0_10px_rgba(255,220,161,0.5)]
                   transition-all duration-500"
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
              <div
                v-if="i <= currentStep"
                class="w-2 h-2 rounded-full bg-white dark:bg-midnight"
              />
            </div>
            <div class="flex flex-col">
              <span
                :class="[
                  'font-sans text-xs uppercase tracking-[0.22em] font-bold',
                  i <= currentStep ? 'text-compute dark:text-signal' : 'text-midnight dark:text-white',
                ]"
              >
                {{ s.label }}
              </span>
              <span class="font-accent italic text-[11px] text-cool mt-0.5">{{ s.description }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Security Notice + Demo shortcut -->
      <div class="pt-8 border-t border-haze dark:border-white/8">
        <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">
          Security Notice
        </h3>
        <div
          :class="[
            'rounded-lg p-4 border flex items-start gap-3 transition-colors',
            depositPath === 'encrypted-mint'
              ? 'border-compute/20 dark:border-signal/20 bg-compute/5 dark:bg-signal/5'
              : 'border-gold/25 bg-gold/5',
          ]"
        >
          <EyeOff
            :size="16"
            :stroke-width="1.8"
            :class="depositPath === 'encrypted-mint'
              ? 'text-compute dark:text-signal mt-0.5 flex-shrink-0'
              : 'text-gold mt-0.5 flex-shrink-0'"
          />
          <p class="font-sans text-[11px] text-cool leading-relaxed">
            {{ depositPath === 'encrypted-mint'
              ? 'Amount will be encrypted client-side via Fhenix FHE. Only you can decrypt your balance.'
              : 'ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.' }}
          </p>
        </div>

        <!-- Demo shortcut (encrypted-mint only) -->
        <div
          v-if="depositPath === 'encrypted-mint'"
          data-testid="demo-mint-shortcut-note"
          class="rounded-lg p-4 border border-gold/25 bg-gold/5 mt-3 flex items-start gap-3"
        >
          <Sparkles :size="16" :stroke-width="1.8" class="text-gold mt-0.5 flex-shrink-0" />
          <div class="flex-1">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-gold">
              Demo shortcut
            </p>
            <p class="font-sans text-[11px] text-cool leading-relaxed mt-1">
              Your kernel was granted <span class="font-mono">MINTER_ROLE</span> at demo signup, so this button mints directly.
            </p>
          </div>
        </div>
      </div>
    </aside>
    </Teleport>
  </div>
</template>
