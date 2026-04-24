<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { useWallet } from '@/composables/useWallet'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { addresses } from '@/contracts/addresses'
import { balanceApi } from '@/services/api'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import {
  CheckCircle2, Lock, Shield, EyeOff, ArrowRight, Loader2, Copy, Check, RefreshCw, ExternalLink,
} from 'lucide-vue-next'

// WrapPage — MuHavenVault.wrap path, unchanged from Wave 3 behaviour. Wraps
// an external ERC-20 RWA into the confidential fhERC-20. Kept as its own
// route (split out of the Wave 3 DepositPage per Phase 6 plan) so BuyPage
// can focus on the primary Subscription.purchase flow without a mode toggle.

const { address, connected } = useWallet()

const isXl = useMediaQuery('(min-width: 1280px)')

const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const errMsg = ref<string | null>(null)

const steps = [
  { label: 'Enter Amount', description: 'Define wrap amount' },
  { label: 'Approve', description: 'Approve ERC-20 to vault' },
  { label: 'Wrap', description: 'Wrap into fhERC-20' },
]

const railHeight = computed(() => Math.min(100, ((currentStep.value + 1) / steps.length) * 100))
const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

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
onMounted(() => { if (connected.value) loadBalances() })

// ── Handler ─────────────────────────────────────────────────────────────

async function handleWrap() {
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
             class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none bg-gold/8 dark:bg-signal/8" />

        <div class="p-8 md:p-10 relative">
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
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">Wrap confirmed</p>
              <p class="font-sans text-sm text-cool max-w-md">
                ERC-20 wrapped into fhERC-20 — your balance is now encrypted on-chain.
              </p>
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
                <p class="font-accent italic text-xl text-midnight dark:text-white leading-tight">Vault Wrap</p>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">Wrap an existing RWA ERC-20 into a confidential fhERC-20.</p>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <label for="wrap-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Amount (18 decimals)
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
            </div>

            <button
              type="button"
              @click="handleWrap"
              :disabled="isProcessing || !amount.trim() || numericAmount <= 0"
              data-testid="wrap-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <Shield v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">
                {{ isProcessing ? 'Wrapping…' : 'Approve & Wrap' }}
              </span>
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
              ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
