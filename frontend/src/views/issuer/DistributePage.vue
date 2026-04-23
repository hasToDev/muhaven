<script setup lang="ts">
import { ref, onMounted, computed, useTemplateRef } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { createPublicClient, http } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { MuHavenClient, type ProgressEvent } from '@muhaven/sdk'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useWallet } from '@/composables/useWallet'
import { useWalletStore } from '@/stores/wallet'
import { useFhe } from '@/composables/useFhe'
import { createZeroDevSender } from '@/services/contracts/zeroDevSender'
import * as YieldService from '@/services/contracts/YieldService'
import * as RegistryService from '@/services/contracts/RegistryService'
import * as EscrowService from '@/services/contracts/EscrowService'
import * as PusdcService from '@/services/contracts/PusdcService'
import { addresses } from '@/contracts/addresses'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  CheckCircle2, AlertTriangle, Eye, Loader2, RefreshCw, ChevronDown, Check,
  Users, Sigma, Calculator, Coins, Lock, ArrowRight, Receipt, Landmark, Info,
} from 'lucide-vue-next'

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
const ARB_SEPOLIA_CHAIN_ID = 421614
const DISTRIBUTE_BATCH_SIZE = 50
const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60

const tokenStore = useIssuerTokensStore()
const { address: walletAddress, connected } = useWallet()
const walletStore = useWalletStore()
const fhe = useFhe()

const selectedToken = ref('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showReceipt = ref(false)
const distributionError = ref<string | null>(null)
const batchProgress = ref({ processed: 0, total: 0 })
const stageLabel = ref<string | null>(null)

const pusdcPublicBalance = ref<bigint | null>(null)
const pusdcConfidentialBalance = ref<bigint | null>(null)
const pusdcDecrypting = ref(false)
const pusdcLoading = ref(false)
const receiptData = ref({
  token: '',
  amount: '',
  investors: 0,
  escrows: 0,
  distributionId: '',
})

// Custom asset dropdown (button-style per Q5 A — replaces the native <select>).
const tokenDropdownOpen = ref(false)
const tokenDropdownRef = useTemplateRef<HTMLDivElement>('tokenDropdownRef')
onClickOutside(tokenDropdownRef, () => { tokenDropdownOpen.value = false })

const steps = [
  { label: 'Encrypt', description: 'Amount → ciphertext' },
  { label: 'Start', description: 'Lock distribution' },
  { label: 'Escrows', description: 'Batch create' },
  { label: 'Fund', description: 'PUSDC → escrow' },
  { label: 'Done', description: 'Investors can claim' },
]

const activeTokens = computed(() =>
  tokenStore.tokens.filter(t => t.status === 'active'),
)

const selectedTokenInfo = computed(() =>
  tokenStore.tokens.find(t => t.address === selectedToken.value),
)

const canDistribute = computed(() =>
  selectedToken.value && amount.value && parseFloat(amount.value) > 0 && !isProcessing.value,
)

function toPusdcUnits(human: string | number): bigint {
  const str = typeof human === 'string' ? human : String(human)
  const [whole = '0', frac = ''] = str.split('.')
  const fracPadded = (frac + '000000').slice(0, 6)
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded || '0')
}

function pickToken(address: string) {
  selectedToken.value = address
  tokenDropdownOpen.value = false
}

async function handleDistribute() {
  if (!canDistribute.value) return

  if (!connected.value) {
    toast.error('Wallet not connected', {
      description: 'Sign in with your passkey to distribute yield',
    })
    return
  }

  isProcessing.value = true
  distributionError.value = null
  stageLabel.value = null
  batchProgress.value = { processed: 0, total: 0 }
  currentStep.value = 0

  try {
    const totalYieldUnits = toPusdcUnits(amount.value)
    const issuerAddr = walletAddress.value as `0x${string}`

    stageLabel.value = 'Pre-flight checks'

    const [
      investorCount,
      ydAuthorized,
      escrowAuthorized,
      pusdcCtHash,
      operatorSet,
    ] = await Promise.all([
      RegistryService.investorCount(),
      YieldService.isAuthorizedCaller(issuerAddr),
      EscrowService.isAuthorizedCaller(issuerAddr),
      PusdcService.confidentialBalanceOf(issuerAddr),
      PusdcService.isOperator(issuerAddr, addresses.yieldDistributor),
    ])

    if (investorCount === 0n) {
      throw new Error(
        'No registered investors — mint MuHavenToken to at least one KYC-approved address first',
      )
    }
    if (!ydAuthorized) {
      throw new Error(
        `This account is not authorized on YieldDistributor. Run: pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia -- ${issuerAddr}`,
      )
    }
    if (!escrowAuthorized) {
      throw new Error(
        `This account is not authorized on MuHavenEscrow. Run: pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia -- ${issuerAddr}`,
      )
    }

    await fhe.initialize()
    const pusdcBalance = await fhe.decryptUint64ForView(pusdcCtHash)
    if (pusdcBalance < totalYieldUnits) {
      const have = (Number(pusdcBalance) / 1_000_000).toFixed(6)
      const need = (Number(totalYieldUnits) / 1_000_000).toFixed(6)
      throw new Error(
        `Insufficient PUSDC (have ${have}, need ${need}). Ask an admin to wrap more USDC → PUSDC to this account.`,
      )
    }

    if (!operatorSet) {
      stageLabel.value = 'Granting YieldDistributor operator approval (one-time)'
      const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
      await PusdcService.setOperator(addresses.yieldDistributor, expiry)
      toast.info('Operator approval granted', {
        description: 'One-time setup — subsequent distributes skip this step',
      })
    }

    currentStep.value = 1
    stageLabel.value = null

    await fhe.initialize()
    const cofheClient = await fhe.getRawClient()

    const publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(RPC_URL),
    })

    const sdk = new MuHavenClient({
      publicClient,
      sender: createZeroDevSender(),
      cofheClient: cofheClient as any,
      addresses: {
        muhavenEscrow: addresses.muhavenEscrow,
        yieldDistributor: addresses.yieldDistributor,
        investorRegistry: addresses.investorRegistry,
        yieldGate: addresses.yieldGate,
      },
      expectedChainId: ARB_SEPOLIA_CHAIN_ID,
    })
    await sdk.validateNetwork()

    const result = await sdk.distributeYield(totalYieldUnits, {
      batchSize: DISTRIBUTE_BATCH_SIZE,
      onProgress: (e: ProgressEvent) => {
        stageLabel.value = e.message ?? e.stage
        switch (e.stage) {
          case 'encrypt':
            break
          case 'startDistribution':
            currentStep.value = 2
            break
          case 'batchCreate':
            currentStep.value = 3
            break
          case 'setEscrowIds':
            currentStep.value = 4
            break
          case 'processBatch':
            currentStep.value = 4
            batchProgress.value = { processed: e.current, total: e.total }
            break
        }
      },
    })

    currentStep.value = 5
    receiptData.value = {
      token: selectedTokenInfo.value?.symbol ?? '',
      amount: amount.value,
      investors: result.escrowIds.length,
      escrows: result.escrowIds.length,
      distributionId: result.distributionId.toString(),
    }
    showReceipt.value = true
    toast.success('Distribution complete', {
      description: `Distribution #${result.distributionId} — ${result.escrowIds.length} encrypted escrows funded`,
    })
    loadPusdcBalance()
    pusdcConfidentialBalance.value = null
  } catch (e) {
    distributionError.value = e instanceof Error ? e.message : 'Distribution failed'
    toast.error('Distribution failed', {
      description: distributionError.value,
    })
  } finally {
    isProcessing.value = false
    stageLabel.value = null
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showReceipt.value = false
  distributionError.value = null
  batchProgress.value = { processed: 0, total: 0 }
  stageLabel.value = null
}

async function loadPusdcBalance() {
  if (!walletAddress.value) return
  pusdcLoading.value = true
  try {
    pusdcPublicBalance.value = await PusdcService.balanceOf(walletAddress.value as `0x${string}`)
  } catch (e) {
    console.warn('[DistributePage] PUSDC balance fetch failed', e)
  } finally {
    pusdcLoading.value = false
  }
}

async function decryptPusdcBalance() {
  if (!walletAddress.value || pusdcDecrypting.value) return
  pusdcDecrypting.value = true
  try {
    const ctHash = await PusdcService.confidentialBalanceOf(walletAddress.value as `0x${string}`)
    await fhe.initialize()
    pusdcConfidentialBalance.value = await fhe.decryptUint64ForView(ctHash)
  } catch (e) {
    toast.error('PUSDC decrypt failed', {
      description: e instanceof Error ? e.message : 'Unknown error',
    })
  } finally {
    pusdcDecrypting.value = false
  }
}

const showLoader = computed(() =>
  !tokenStore.loaded && !tokenStore.error && tokenStore.loading,
)

onMounted(async () => {
  if (!tokenStore.loaded) {
    await tokenStore.load()
  }
  tokenStore.loadDistributionHistory()
  if (activeTokens.value.length > 0 && !selectedToken.value) {
    selectedToken.value = activeTokens.value[0].address
  }
  loadPusdcBalance()
})
</script>

<template>
  <div>
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading issuer data"
      caption="Reading tokens + operator state"
    />

    <!-- Content -->
    <div v-else class="flex flex-col gap-6">
      <!-- PUSDC balance card (MuHaven-specific affordance, kept above per Q7 A).
           Always rendered so its slot is reserved on first paint — avoids the
           layout-shift that happens if the card only mounts after the async
           balance load resolves. Shows a loading placeholder until the balance
           arrives. -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460 } }"
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
                Available PUSDC · public
              </p>
              <p class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight leading-none min-h-[2.5rem] flex items-center">
                <template v-if="pusdcPublicBalance !== null">
                  {{ formatUSD(Number(pusdcPublicBalance) / 1e6) }}
                </template>
                <span
                  v-else
                  class="inline-flex items-center gap-2 text-cool/60"
                >
                  <Loader2 :size="18" class="animate-spin" />
                  <span class="font-sans not-italic text-sm">Loading…</span>
                </span>
              </p>
            </div>
            <div
              v-if="pusdcConfidentialBalance !== null"
              class="border-l border-haze dark:border-white/8 pl-6"
            >
              <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-compute dark:text-signal font-semibold mb-1.5">
                Confidential portion
              </p>
              <p class="font-accent italic text-3xl md:text-4xl text-compute dark:text-signal tabular-nums tracking-tight leading-none">
                {{ formatUSD(Number(pusdcConfidentialBalance) / 1e6) }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="pusdcConfidentialBalance === null"
              type="button"
              @click="decryptPusdcBalance"
              :disabled="pusdcDecrypting || pusdcPublicBalance === null"
              data-testid="distribute-reveal-confidential"
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                     text-compute dark:text-signal
                     border border-compute/30 dark:border-signal/30
                     hover:text-white dark:hover:text-[#412d00]
                     hover:bg-compute dark:hover:bg-signal
                     px-4 py-2 rounded transition-all duration-200 cursor-pointer
                     disabled:opacity-60 disabled:cursor-wait disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:hover:text-compute dark:disabled:hover:text-signal"
              title="Client-side FHE decrypt — no on-chain tx, no gas."
            >
              <Loader2 v-if="pusdcDecrypting" :size="11" class="animate-spin" />
              <Eye v-else :size="11" :stroke-width="2" />
              {{ pusdcDecrypting ? 'Decrypting…' : 'Reveal confidential' }}
            </button>
            <button
              type="button"
              @click="() => { pusdcConfidentialBalance = null; loadPusdcBalance() }"
              :disabled="pusdcLoading"
              data-testid="distribute-refresh-pusdc"
              class="p-2 rounded border border-haze dark:border-white/10 text-cool
                     hover:text-compute dark:hover:text-signal
                     hover:border-gold/40 dark:hover:border-signal/40
                     transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              title="Refresh public balance (hides any decrypted confidential view)"
            >
              <Loader2 v-if="pusdcLoading" :size="13" class="animate-spin" />
              <RefreshCw v-else :size="13" :stroke-width="1.8" />
            </button>
          </div>
        </div>
      </section>

      <!-- Top stats strip (Eligible / Logic / Avg output / Platform fee) per Q2 A -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 80 } }"
        class="grid grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <div class="rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] backdrop-blur-md flex flex-col gap-1.5">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold flex items-center gap-1.5">
            <Users :size="12" :stroke-width="1.8" />
            Eligible
          </span>
          <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums tracking-tight">
            {{ tokenStore.aggregateStats.totalInvestors }} Investors
          </span>
        </div>
        <div class="rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] backdrop-blur-md flex flex-col gap-1.5">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold flex items-center gap-1.5">
            <Sigma :size="12" :stroke-width="1.8" />
            Logic
          </span>
          <span class="font-accent italic text-xl text-midnight dark:text-white tracking-tight">
            Proportional <span class="font-mono text-xs text-cool">(FHE.div)</span>
          </span>
        </div>
        <div class="rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] backdrop-blur-md flex flex-col gap-1.5">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold flex items-center gap-1.5">
            <Calculator :size="12" :stroke-width="1.8" />
            Avg output
          </span>
          <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums tracking-tight">
            {{ amount && tokenStore.aggregateStats.totalInvestors > 0
              ? `~${formatUSD(parseFloat(amount) / tokenStore.aggregateStats.totalInvestors)}`
              : '—' }}
          </span>
        </div>
        <div class="rounded-xl p-4 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] backdrop-blur-md flex flex-col gap-1.5">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold flex items-center gap-1.5">
            <Coins :size="12" :stroke-width="1.8" />
            Platform fee
          </span>
          <span class="font-accent italic text-xl text-midnight dark:text-white tabular-nums tracking-tight">
            {{ amount ? formatUSD(parseFloat(amount) * 0.001) : '—' }}
            <span class="font-mono text-xs text-cool">(0.1%)</span>
          </span>
        </div>
      </section>

      <!-- 5-step stepper — standalone strip per Q3 A -->
      <section
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 480, delay: 140 } }"
        class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#1c1b1b]/30 backdrop-blur-md py-4 px-6"
      >
        <div class="flex items-center justify-between max-w-3xl mx-auto">
          <template v-for="(s, i) in steps" :key="s.label">
            <div class="flex flex-col items-center gap-1.5">
              <div
                :class="[
                  'h-7 w-7 rounded-full flex items-center justify-center transition-all duration-300',
                  i < currentStep
                    ? 'bg-gold/15 dark:bg-signal/15 border border-gold/40 dark:border-signal/40 text-compute dark:text-signal'
                    : i === currentStep
                      ? 'bg-gold dark:bg-signal text-midnight shadow-[0_0_14px_rgba(255,186,32,0.45)] dark:shadow-[0_0_14px_rgba(255,220,161,0.4)]'
                      : 'bg-white dark:bg-[#171717] border border-haze dark:border-white/15 text-cool',
                  i === currentStep && isProcessing && 'animate-pulse',
                ]"
              >
                <Check v-if="i < currentStep" :size="13" :stroke-width="2.5" />
                <span v-else class="font-sans text-[10px] font-bold tabular-nums">{{ i + 1 }}</span>
              </div>
              <span
                :class="[
                  'font-sans text-[9px] uppercase tracking-[0.22em] text-center font-semibold transition-colors',
                  i < currentStep
                    ? 'text-compute dark:text-signal'
                    : i === currentStep
                      ? 'text-gold dark:text-signal font-bold'
                      : 'text-cool/60',
                ]"
              >
                {{ s.label }}
              </span>
            </div>
            <div
              v-if="i < steps.length - 1"
              aria-hidden="true"
              :class="[
                'flex-1 h-px mx-2 transition-colors',
                i < currentStep
                  ? 'bg-gold/40 dark:bg-signal/40'
                  : 'bg-haze dark:bg-white/10',
              ]"
            />
          </template>
        </div>
      </section>

      <!-- Side-by-side main area (form + history) per Q4 A -->
      <div class="flex flex-col lg:flex-row gap-6">
        <!-- LEFT: Form card with 3-section chrome (Q6 A) -->
        <section
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 200 } }"
          class="flex-1 flex flex-col rounded-2xl overflow-hidden
                 border border-haze dark:border-white/5
                 bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-xl
                 shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
                 dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]
                 min-h-[500px]"
        >
          <!-- Receipt state -->
          <div v-if="showReceipt" data-testid="distribute-receipt" class="flex flex-col items-center gap-6 p-8 md:p-10 flex-1">
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
                Distribution complete
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                {{ receiptData.investors }} encrypted escrows funded via
                <span class="font-medium text-compute dark:text-signal">MuHavenEscrow</span>.
              </p>
            </div>
            <div class="w-full rounded-xl border border-haze dark:border-white/5 bg-mist/50 dark:bg-[#0d0e10] p-6 space-y-3.5">
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Distribution ID</span>
                <span data-testid="distribute-receipt-id" class="font-mono text-sm text-midnight dark:text-white">
                  #{{ receiptData.distributionId }}
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
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Investors</span>
                <span class="font-sans text-sm font-medium text-midnight dark:text-white">{{ receiptData.investors }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Escrows</span>
                <span class="font-sans text-sm font-medium text-midnight dark:text-white">{{ receiptData.escrows }}</span>
              </div>
              <div class="flex justify-between items-center border-t border-haze/60 dark:border-white/5 pt-3.5">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Settlement</span>
                <span class="font-sans text-sm font-medium text-compute dark:text-signal">MuHavenEscrow · PUSDC</span>
              </div>
            </div>
            <span
              class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border
                     border-compute/25 dark:border-signal/25
                     bg-compute/8 dark:bg-signal/10
                     text-compute dark:text-signal
                     font-sans text-[10px] uppercase tracking-[0.22em] font-semibold"
            >
              <Lock :size="11" :stroke-width="1.8" />
              Amounts encrypted via FHE
            </span>
            <MButton variant="outline" @click="resetForm">New distribution</MButton>
          </div>

          <!-- Error state -->
          <div v-else-if="distributionError" data-testid="distribute-error" class="flex flex-col items-center gap-5 p-8 md:p-10 flex-1">
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <AlertTriangle :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">
              Distribution failed
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-lg">{{ distributionError }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <!-- Form (3-section chrome: header / body / footer) -->
          <template v-else>
            <!-- Header bar -->
            <div class="px-6 py-4 border-b border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex items-center justify-between gap-3">
              <div class="flex flex-col">
                <h3 class="font-sans font-bold text-base text-midnight dark:text-white tracking-tight">
                  Distribution Parameters
                </h3>
                <p class="font-sans text-[10px] text-cool mt-0.5">
                  Configure FHE batch transfer.
                </p>
              </div>
              <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-haze dark:border-white/10 bg-white dark:bg-[#0e0e0e]">
                <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full bg-positive animate-pulse" />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-positive font-semibold">FHE Active</span>
              </div>
            </div>

            <!-- Body -->
            <div class="p-6 flex flex-col gap-6 flex-1">
              <!-- Asset (button-style dropdown per Q5 A) -->
              <div class="flex flex-col gap-2">
                <label class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Asset
                </label>
                <div ref="tokenDropdownRef" class="relative">
                  <button
                    type="button"
                    @click="tokenDropdownOpen = !tokenDropdownOpen"
                    :disabled="isProcessing"
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
                  <!-- Dropdown menu -->
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

              <!-- Encrypted total amount input -->
              <div class="flex flex-col gap-2">
                <label for="distribute-amount-input" class="font-sans text-[10px] uppercase tracking-[0.22em] text-compute dark:text-signal font-semibold flex items-center gap-1.5">
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
                    aria-label="Total yield to distribute, in USD"
                    :disabled="isProcessing"
                    data-testid="distribute-amount-input"
                    class="w-full bg-transparent border-0 pl-8 text-right
                           font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tabular-nums tracking-tight
                           placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none
                           disabled:opacity-50
                           [&::-webkit-outer-spin-button]:appearance-none
                           [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>

              <!-- Stage indicator + batch progress (processing state) -->
              <div
                v-if="isProcessing"
                class="rounded-lg p-4 border border-haze/70 dark:border-white/5 bg-mist/40 dark:bg-[#0d0e10] flex flex-col gap-3 mt-auto"
              >
                <div class="flex items-end justify-between gap-3">
                  <div class="flex items-center gap-2">
                    <Loader2 :size="14" class="animate-spin text-compute dark:text-signal" />
                    <span class="font-mono text-xs text-compute dark:text-signal">
                      {{ stageLabel || fhe.currentStep.value || 'Working…' }}
                    </span>
                  </div>
                  <span
                    v-if="batchProgress.total > 0"
                    class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold tabular-nums"
                  >
                    {{ batchProgress.processed }} / {{ batchProgress.total }} investors
                  </span>
                </div>
                <div v-if="batchProgress.total > 0" class="h-1.5 bg-white dark:bg-white/8 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-gradient-to-r from-gold to-signal dark:from-signal dark:to-gold rounded-full transition-all duration-300"
                    :style="{ width: `${(batchProgress.processed / batchProgress.total) * 100}%` }"
                  />
                </div>
              </div>
            </div>

            <!-- Footer bar -->
            <div class="px-6 py-4 border-t border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex flex-col gap-3">
              <p class="font-sans text-[11px] text-cool flex items-center gap-1.5">
                <Info :size="12" :stroke-width="1.8" />
                Amounts remain encrypted during processing.
              </p>
              <p
                v-if="!walletStore.sessionKeyActive"
                class="font-sans text-[10px] text-cool italic"
              >
                First Distribute installs a scoped session key — subsequent signatures happen silently.
              </p>
              <div class="flex justify-end">
                <button
                  type="button"
                  @click="handleDistribute"
                  :disabled="!canDistribute"
                  data-testid="distribute-cta"
                  class="btn-gold-sweep px-6 py-2.5 rounded-lg font-sans font-bold text-[12px] tracking-[0.18em] uppercase
                         flex items-center gap-2 cursor-pointer
                         transition-all duration-300 hover:-translate-y-0.5 active:scale-[0.99]"
                >
                  <Loader2 v-if="isProcessing" :size="14" class="animate-spin" />
                  <Lock v-else :size="13" :stroke-width="2" />
                  <span>{{ isProcessing ? 'Distributing…' : 'Deposit & Distribute' }}</span>
                  <ArrowRight v-if="!isProcessing" :size="13" :stroke-width="2" />
                </button>
              </div>
            </div>
          </template>
        </section>

        <!-- RIGHT: Distribution history -->
        <section
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 260 } }"
          class="flex-1 flex flex-col rounded-2xl overflow-hidden
                 border border-haze dark:border-white/5
                 bg-white/50 dark:bg-[#1c1b1b]/40 backdrop-blur-xl
                 min-h-[500px]"
        >
          <!-- Header bar (matches form's header chrome for symmetry) -->
          <div class="px-6 py-4 border-b border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#201f1f]/70 flex items-center justify-between">
            <h4 class="font-sans font-bold text-base text-midnight dark:text-white tracking-tight">
              Recent Distributions
            </h4>
            <span
              v-if="tokenStore.distributions.length > 0"
              class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool"
            >
              Last {{ tokenStore.distributions.length }}
            </span>
          </div>

          <!-- Body — scrolls if many entries -->
          <div class="p-4 flex flex-col gap-3 flex-1 overflow-y-auto">
            <div
              v-if="tokenStore.distributions.length === 0"
              class="flex flex-col items-center justify-center gap-2.5 py-12 text-center"
            >
              <div class="w-12 h-12 rounded-full bg-mist/60 dark:bg-white/5 border border-haze dark:border-white/5 flex items-center justify-center">
                <Receipt :size="18" :stroke-width="1.5" class="text-cool/70" />
              </div>
              <p class="font-sans text-xs text-cool">No distributions yet</p>
            </div>

            <div
              v-for="d in tokenStore.distributions"
              :key="d.distributionId"
              class="group flex items-center justify-between gap-3 rounded-lg p-3.5
                     bg-white/70 dark:bg-[#0d0e10]/70
                     border border-haze/70 dark:border-white/5
                     hover:border-gold/30 dark:hover:border-signal/25
                     transition-colors"
            >
              <div class="flex items-center gap-3 min-w-0">
                <div
                  :class="[
                    'h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 border',
                    d.status === 'processing'
                      ? 'bg-gold/10 border-gold/30 text-gold'
                      : 'bg-mist/60 dark:bg-white/5 border-haze dark:border-white/10 text-cool',
                  ]"
                >
                  <Loader2 v-if="d.status === 'processing'" :size="15" class="animate-spin" />
                  <Receipt v-else :size="15" :stroke-width="1.8" />
                </div>
                <div class="flex flex-col min-w-0">
                  <span class="font-sans text-xs font-bold text-midnight dark:text-white tabular-nums truncate">
                    #{{ d.distributionId }} · {{ d.investors }} investors
                  </span>
                  <span class="font-sans text-[10px] text-cool mt-0.5 truncate">
                    {{ d.escrowsCreated }} escrows
                  </span>
                </div>
              </div>
              <span
                :class="[
                  'inline-flex items-center gap-1.5 font-sans text-[9px] uppercase tracking-[0.22em] font-bold px-2 py-0.5 rounded-full border flex-shrink-0',
                  d.status === 'complete'
                    ? 'text-positive border-positive/30 bg-positive/10'
                    : d.status === 'processing'
                      ? 'text-gold border-gold/30 bg-gold/10'
                      : 'text-cool border-haze dark:border-white/10 bg-haze/30 dark:bg-white/5',
                ]"
              >
                <span
                  :class="[
                    'w-1 h-1 rounded-full',
                    d.status === 'complete'
                      ? 'bg-positive'
                      : d.status === 'processing'
                        ? 'bg-gold'
                        : 'bg-cool',
                  ]"
                />
                {{ d.status }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
