<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { toast } from 'vue-sonner'
import { createPublicClient, http } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { MuHavenClient, type ProgressEvent } from '@muhaven/sdk'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useAppStore } from '@/stores/app'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { createZeroDevSender } from '@/services/contracts/zeroDevSender'
import * as YieldService from '@/services/contracts/YieldService'
import * as RegistryService from '@/services/contracts/RegistryService'
import * as EscrowService from '@/services/contracts/EscrowService'
import * as PusdcService from '@/services/contracts/PusdcService'
import { addresses } from '@/contracts/addresses'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MStepProgress from '@/components/ui/MStepProgress.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { CheckCircle, AlertTriangle } from 'lucide-vue-next'

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'
const ARB_SEPOLIA_CHAIN_ID = 421614
const DISTRIBUTE_BATCH_SIZE = 50
// Operator approval expiry — 1 year from now as absolute unix timestamp
// (PUSDC's setOperator takes a uint48 expiry, not a duration).
const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60

const app = useAppStore()
const tokenStore = useIssuerTokensStore()
const { address: walletAddress, connected } = useWallet()
const fhe = useFhe()

const selectedToken = ref('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showReceipt = ref(false)
const distributionError = ref<string | null>(null)
const batchProgress = ref({ processed: 0, total: 0 })
const stageLabel = ref<string | null>(null)
const receiptData = ref({
  token: '',
  amount: '',
  investors: 0,
  escrows: 0,
  distributionId: '',
})

// Stepper mapped 1:1 to the SDK's distributeYield pipeline. The SDK emits
// `startDistribution` → `encrypt` + `batchCreate` (per batch) →
// `setEscrowIds` → `processBatch` (per batch) via onProgress; we advance
// currentStep in handleDistribute's onProgress handler.
const steps = [
  { label: 'Encrypt' },
  { label: 'Start Distribution' },
  { label: 'Create Escrows' },
  { label: 'Fund Escrows' },
  { label: 'Complete' },
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

/** Parse "12.34" → 12_340_000n (PUSDC's 6-decimal units, string-safe). */
function toPusdcUnits(human: string): bigint {
  const [whole = '0', frac = ''] = human.split('.')
  const fracPadded = (frac + '000000').slice(0, 6)
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded || '0')
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

    // ── Pre-flight: verify on-chain configuration before touching FHE ────
    // Each check is a cheap view call. Fail fast with an actionable message
    // so the user doesn't waste a passkey signature on a doomed tx.
    stageLabel.value = 'Pre-flight checks'

    const [
      investorCount,
      ydAuthorized,
      escrowAuthorized,
      pusdcBalance,
      operatorSet,
    ] = await Promise.all([
      RegistryService.investorCount(),
      YieldService.isAuthorizedCaller(issuerAddr),
      EscrowService.isAuthorizedCaller(issuerAddr),
      PusdcService.balanceOf(issuerAddr),
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
    if (pusdcBalance < totalYieldUnits) {
      const have = (Number(pusdcBalance) / 1_000_000).toFixed(6)
      const need = (Number(totalYieldUnits) / 1_000_000).toFixed(6)
      throw new Error(
        `Insufficient PUSDC (have ${have}, need ${need}). Ask an admin to wrap more USDC → PUSDC to this account.`,
      )
    }

    // ── Auto-setOperator on first distribute ────────────────────────────
    // The operator mapping is keyed by msg.sender, so it must be granted
    // from the smart account itself — can't be done by the deployer script.
    // Sent as its own UserOp (one passkey prompt) before the distribute pipeline.
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

    // Ensure FHE client is ready (loads tfhe WASM, connects, creates self-permit).
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
            // Fires for both the totalYield encryption (pre-start) and each
            // investor-address batch (during createYieldEscrows). We leave
            // currentStep where batchCreate / startDistribution last put it
            // and only surface the message via stageLabel.
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

onMounted(async () => {
  if (!tokenStore.loaded) {
    app.startLoading()
    await tokenStore.load()
    app.stopLoading()
  }
  tokenStore.loadDistributionHistory()
  // Pre-select first active token
  if (activeTokens.value.length > 0 && !selectedToken.value) {
    selectedToken.value = activeTokens.value[0].address
  }
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="tokenStore.loading" class="max-w-2xl mx-auto flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="220px" />
    </div>
    <MSkeleton width="100%" height="40px" />
    <MSkeleton variant="card" height="400px" />
  </div>

  <!-- Content -->
  <div v-else class="max-w-3xl mx-auto flex flex-col gap-10">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white">Distribute Yield</h1>
      <MGoldRule />
    </div>

    <!-- Step progress -->
    <div class="px-4 pb-2">
      <MStepProgress :steps="steps" :current-step="currentStep" />
    </div>

    <MCard
      padding="lg"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 150 } }"
    >
      <!-- Receipt state -->
      <div v-if="showReceipt" class="space-y-6">
        <div class="flex flex-col items-center gap-3 py-4">
          <div
            v-motion
            :initial="{ opacity: 0, scale: 0.5 }"
            :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
            class="w-14 h-14 rounded-full bg-compute/12 flex items-center justify-center"
          >
            <CheckCircle :size="28" class="text-compute" />
          </div>
          <p class="text-lg font-semibold text-midnight dark:text-white">Distribution Complete</p>
        </div>
        <div class="bg-mist dark:bg-midnight rounded-xl p-5 space-y-3 text-sm">
          <div class="flex justify-between"><span class="text-cool">Distribution ID</span><span class="font-mono text-midnight dark:text-white">#{{ receiptData.distributionId }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Token</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.token }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Total Amount</span><span class="font-mono text-midnight dark:text-white">${{ receiptData.amount }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Investors</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.investors }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Escrows Created</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.escrows }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Settlement</span><span class="font-medium text-compute">MuHaven Escrow (PUSDC)</span></div>
        </div>
        <MBadge variant="privacy" class="mx-auto">Amounts encrypted via FHE</MBadge>
        <MButton full-width variant="ghost" @click="resetForm">New Distribution</MButton>
      </div>

      <!-- Error state -->
      <div v-else-if="distributionError" class="space-y-4">
        <div class="flex flex-col items-center gap-3 py-4">
          <div class="w-14 h-14 rounded-full bg-negative/12 flex items-center justify-center">
            <AlertTriangle :size="28" class="text-negative" />
          </div>
          <p class="text-lg font-semibold text-midnight dark:text-white">Distribution Failed</p>
          <p class="text-sm text-cool text-center">{{ distributionError }}</p>
        </div>
        <MButton full-width variant="ghost" @click="resetForm">Try Again</MButton>
      </div>

      <!-- Form -->
      <template v-else>
        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Select token</label>
        <select
          v-model="selectedToken"
          :disabled="isProcessing"
          class="mt-2 mb-6 w-full bg-mist dark:bg-midnight rounded-xl p-4 text-sm font-sans font-medium text-midnight dark:text-white border border-haze dark:border-white/10 focus:outline-none focus:border-compute cursor-pointer disabled:opacity-50"
        >
          <option value="" disabled>Choose a token...</option>
          <option v-for="t in activeTokens" :key="t.address" :value="t.address">
            {{ t.name }} ({{ t.symbol }})
          </option>
        </select>

        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Total yield to distribute</label>
        <div class="relative mt-2 mb-6">
          <span class="absolute left-4 top-1/2 -translate-y-1/2 text-lg text-cool">$</span>
          <input
            v-model="amount"
            placeholder="50,000.00"
            type="number"
            step="0.01"
            min="0"
            :disabled="isProcessing"
            class="w-full py-3.5 pl-8 pr-4 text-lg font-mono border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors disabled:opacity-50"
          />
        </div>

        <!-- SDK pipeline stage indicator (or fallback to FHE encryption step) -->
        <div v-if="isProcessing && (stageLabel || fhe.currentStep.value)" class="mb-4">
          <div class="flex items-center gap-2 text-sm text-compute">
            <div class="w-4 h-4 border-2 border-compute border-t-transparent rounded-full animate-spin" />
            <span class="font-mono text-xs">{{ stageLabel || fhe.currentStep.value }}</span>
          </div>
        </div>

        <!-- Batch progress -->
        <div v-if="isProcessing && batchProgress.total > 0" class="mb-6">
          <div class="flex justify-between text-xs text-cool mb-2">
            <span>Processing investors</span>
            <span>{{ batchProgress.processed }} / {{ batchProgress.total }}</span>
          </div>
          <div class="h-2 bg-mist dark:bg-midnight rounded-full overflow-hidden">
            <div
              class="h-full bg-compute rounded-full transition-all duration-300"
              :style="{ width: `${batchProgress.total > 0 ? (batchProgress.processed / batchProgress.total) * 100 : 0}%` }"
            />
          </div>
        </div>

        <div class="bg-mist dark:bg-midnight rounded-xl p-5 mb-6">
          <div class="flex items-center justify-between mb-3">
            <p class="text-base font-sans font-medium text-midnight dark:text-white">Distribution preview</p>
            <MBadge variant="fhe">ReineiraOS</MBadge>
          </div>
          <div class="flex flex-col gap-2 text-sm">
            <div class="flex justify-between">
              <span class="text-cool">Eligible investors</span>
              <span class="font-medium text-midnight dark:text-white">{{ tokenStore.aggregateStats.totalInvestors }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Method</span>
              <span class="font-medium text-midnight dark:text-white">Proportional (FHE.div)</span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Per investor (avg)</span>
              <span class="font-medium text-midnight dark:text-white">
                {{ amount && tokenStore.aggregateStats.totalInvestors > 0
                  ? `~${formatUSD(parseFloat(amount) / tokenStore.aggregateStats.totalInvestors)}`
                  : '--' }}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Platform fee (0.1%)</span>
              <span class="font-medium text-midnight dark:text-white">
                {{ amount ? formatUSD(parseFloat(amount) * 0.001) : '--' }}
              </span>
            </div>
          </div>
        </div>

        <MButton
          full-width
          size="lg"
          :loading="isProcessing"
          :disabled="!canDistribute"
          @click="handleDistribute"
        >
          Distribute Yield
        </MButton>

        <div class="mt-5">
          <MPrivacyBanner text="Individual distribution amounts are encrypted via Fhenix FHE. You see totals only." />
        </div>
      </template>
    </MCard>

    <!-- Distribution history -->
    <MCard
      v-if="tokenStore.distributions.length > 0"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 250 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">Distribution History</p>
      <div
        v-for="(d, i) in tokenStore.distributions"
        :key="d.distributionId"
        :class="[
          'flex items-center gap-4 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <div class="w-9 h-9 rounded-lg bg-compute/12 flex items-center justify-center">
          <CheckCircle :size="14" class="text-compute" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-base font-medium text-midnight dark:text-white">
            Distribution #{{ d.distributionId }} &middot; {{ d.investors }} investors
          </p>
          <p class="text-xs text-cool mt-0.5">{{ d.escrowsCreated }} escrows created</p>
        </div>
        <MBadge :variant="d.status === 'complete' ? 'positive' : d.status === 'processing' ? 'gold' : 'default'">
          {{ d.status }}
        </MBadge>
      </div>
    </MCard>
  </div>
  </div>
</template>
