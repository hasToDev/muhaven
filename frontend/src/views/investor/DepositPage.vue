<script setup lang="ts">
import { ref, computed } from 'vue'
import { toast } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MStepProgress from '@/components/ui/MStepProgress.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { CheckCircle } from 'lucide-vue-next'

const store = useAppStore()
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)

const steps = [
  { label: 'Enter Amount', description: 'Choose how much USDC to deposit' },
  { label: 'Confirm', description: 'Review and approve the transaction' },
  { label: 'Processing', description: 'Encrypting via Fhenix FHE' },
]

const quickAmounts = ['100', '1,000', '5,000']

const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)
const estimatedYield = computed(() => (numericAmount.value * 0.048 / 12).toFixed(2))

function handleDeposit() {
  if (!amount.value || isProcessing.value) return
  isProcessing.value = true
  currentStep.value = 1

  setTimeout(() => {
    currentStep.value = 2
    setTimeout(() => {
      currentStep.value = 3
      isProcessing.value = false
      showSuccess.value = true
      toast.success('Deposit confirmed', {
        description: `$${amount.value} USDC deposited via ReineiraOS`,
      })
      setTimeout(() => {
        currentStep.value = 0
        amount.value = ''
        showSuccess.value = false
      }, 3000)
    }, 1500)
  }, 1200)
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="max-w-2xl mx-auto flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="200px" />
    </div>
    <MSkeleton variant="card" height="360px" />
  </div>

  <!-- Content -->
  <div v-else class="max-w-2xl mx-auto flex flex-col gap-8">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">Deposit USDC</h1>
      <MGoldRule />
    </div>

    <div class="px-4 pb-2">
      <MStepProgress :steps="steps" :current-step="currentStep" />
    </div>

    <MCard
      padding="lg"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 150 } }"
    >
      <!-- Success state -->
      <div v-if="showSuccess" class="flex flex-col items-center gap-4 py-8">
        <div
          v-motion
          :initial="{ opacity: 0, scale: 0.5 }"
          :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
          class="w-16 h-16 rounded-full bg-compute/12 flex items-center justify-center"
        >
          <CheckCircle :size="32" class="text-compute" />
        </div>
        <p class="text-lg font-sans font-semibold text-midnight dark:text-white">Deposit Confirmed</p>
        <p class="text-sm text-cool">Your balance has been encrypted on-chain</p>
      </div>

      <!-- Form -->
      <template v-else>
        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">From</label>
        <div class="mt-2 mb-6 bg-mist dark:bg-midnight rounded-xl p-4">
          <p class="text-base font-sans font-medium text-midnight dark:text-white">Arbitrum Sepolia</p>
          <p class="text-sm font-mono text-slate dark:text-cool mt-1">0x7a3f...b29e &middot; Balance: 12,500.00 USDC</p>
        </div>

        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Amount</label>

        <!-- Quick amount buttons -->
        <div class="flex gap-2 mt-2 mb-3">
          <button
            v-for="qa in quickAmounts"
            :key="qa"
            @click="amount = qa"
            :disabled="isProcessing"
            class="px-3 py-1.5 text-xs font-medium border border-haze dark:border-white/10 rounded-lg text-cool hover:text-compute hover:border-compute/30 transition-all duration-200 cursor-pointer disabled:opacity-50"
          >
            ${{ qa }}
          </button>
          <button
            @click="amount = '12,500.00'"
            :disabled="isProcessing"
            class="px-3 py-1.5 text-xs font-medium border border-haze dark:border-white/10 rounded-lg text-cool hover:text-compute hover:border-compute/30 transition-all duration-200 cursor-pointer disabled:opacity-50"
          >
            MAX
          </button>
        </div>

        <div class="flex gap-2.5 mb-4">
          <div class="flex-1 relative">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-lg text-cool">$</span>
            <input
              v-model="amount"
              placeholder="0.00"
              :disabled="isProcessing"
              class="w-full py-3.5 pl-8 pr-4 text-lg font-mono border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors disabled:opacity-50"
            />
          </div>
        </div>

        <!-- Estimated yield -->
        <div v-if="numericAmount > 0" class="mb-6 bg-compute/5 border border-compute/15 rounded-lg px-4 py-3 flex items-center justify-between">
          <span class="text-xs text-slate dark:text-cool">Est. monthly yield at 4.8% APY</span>
          <span class="text-sm font-mono font-medium text-compute">${{ estimatedYield }}</span>
        </div>
        <div v-else class="mb-6" />

        <MButton
          variant="primary"
          full-width
          size="lg"
          :loading="isProcessing"
          :disabled="!amount.trim()"
          @click="handleDeposit"
        >
          Deposit via ReineiraOS
        </MButton>

        <div class="mt-5">
          <MPrivacyBanner text="Amount will be encrypted on-chain via Fhenix FHE. Nobody can see how much you deposited." />
        </div>
      </template>
    </MCard>
  </div>
  </div>
</template>
