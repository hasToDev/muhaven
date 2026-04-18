<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { toast } from 'vue-sonner'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useAppStore } from '@/stores/app'
import { useFhe } from '@/composables/useFhe'
import * as YieldService from '@/services/contracts/YieldService'
import * as RegistryService from '@/services/contracts/RegistryService'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MStepProgress from '@/components/ui/MStepProgress.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { CheckCircle, AlertTriangle } from 'lucide-vue-next'
import { DistributionStatus } from '@/services/contracts/types'

const app = useAppStore()
const tokenStore = useIssuerTokensStore()
const fhe = useFhe()

const selectedToken = ref('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showReceipt = ref(false)
const distributionError = ref<string | null>(null)
const batchProgress = ref({ processed: 0, total: 0 })
const receiptData = ref({
  token: '',
  amount: '',
  investors: 0,
  escrows: 0,
})

const steps = [
  { label: 'Select Token' },
  { label: 'Encrypt Amount' },
  { label: 'Start Distribution' },
  { label: 'Process Batches' },
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

async function handleDistribute() {
  if (!canDistribute.value) return

  isProcessing.value = true
  distributionError.value = null
  currentStep.value = 1

  try {
    // Step 1: Initialize FHE + encrypt amount
    await fhe.initialize()
    // Parse as string to avoid floating-point precision loss (USDC 6 decimals)
    const [whole = '0', dec = ''] = String(amount.value).split('.')
    const paddedDec = (dec + '000000').slice(0, 6)
    const amountRaw = BigInt(whole + paddedDec)
    const encrypted = await fhe.encryptUint128(amountRaw)
    currentStep.value = 2

    // Step 2: Start distribution on-chain
    await YieldService.startDistribution(encrypted)
    const distCount = await YieldService.distributionCount()
    const distributionId = distCount - 1n
    currentStep.value = 3

    // Step 3: Process batches
    const investorCount = await RegistryService.investorCount()
    batchProgress.value = { processed: 0, total: Number(investorCount) }
    const batchSize = 10n

    let complete = false
    while (!complete) {
      await YieldService.processBatch(distributionId, batchSize)
      const dist = await YieldService.getDistribution(distributionId)
      batchProgress.value.processed = Number(dist.processedCount)

      if (dist.status === DistributionStatus.COMPLETED) {
        complete = true
        receiptData.value = {
          token: selectedTokenInfo.value?.symbol ?? '',
          amount: amount.value,
          investors: Number(dist.investorCount),
          escrows: Number(dist.escrowsCreated),
        }
      }
    }

    currentStep.value = 4
    showReceipt.value = true
    toast.success('Distribution complete', {
      description: `Yield distributed to ${receiptData.value.investors} investors via ReineiraOS escrow`,
    })
  } catch (e) {
    distributionError.value = e instanceof Error ? e.message : 'Distribution failed'
    toast.error('Distribution failed', {
      description: distributionError.value,
    })
  } finally {
    isProcessing.value = false
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showReceipt.value = false
  distributionError.value = null
  batchProgress.value = { processed: 0, total: 0 }
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

    <!-- Phase 19D notice: the full distribute pipeline (startDistribution →
         escrow batchCreate → setEscrowIds → processBatch) is driven by the CLI
         (`pnpm run test:e2e:sdk`) for the hackathon demo. The UI button below
         still triggers startDistribution but does NOT create + fund escrows —
         use the CLI to complete the pipeline end-to-end. -->
    <div class="bg-gold/10 border border-gold/40 rounded-xl p-4 text-sm text-midnight dark:text-white">
      <p class="font-semibold mb-1">Pipeline status: CLI-driven (hackathon demo)</p>
      <p class="text-cool text-xs leading-relaxed">
        Full yield distribution (encrypt → start → batch-create escrows → attach
        → process) runs via <code class="font-mono text-compute">pnpm run test:e2e:sdk</code>.
        Frontend orchestration via ZeroDev-routed UserOps is wave-4 work.
      </p>
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
          <div class="flex justify-between"><span class="text-cool">Token</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.token }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Total Amount</span><span class="font-mono text-midnight dark:text-white">${{ receiptData.amount }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Investors</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.investors }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Escrows Created</span><span class="font-medium text-midnight dark:text-white">{{ receiptData.escrows }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Settlement</span><span class="font-medium text-compute">ReineiraOS Escrow</span></div>
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

        <!-- FHE encryption step indicator -->
        <div v-if="isProcessing && fhe.currentStep.value" class="mb-4">
          <div class="flex items-center gap-2 text-sm text-compute">
            <div class="w-4 h-4 border-2 border-compute border-t-transparent rounded-full animate-spin" />
            <span class="font-mono text-xs">{{ fhe.currentStep.value }}</span>
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
          :disabled="true"
          @click="handleDistribute"
        >
          Use CLI: pnpm run test:e2e:sdk
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
