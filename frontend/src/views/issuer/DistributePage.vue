<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import { DISTRIBUTION_HISTORY } from '@/data/constants'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MStepProgress from '@/components/ui/MStepProgress.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { CheckCircle, Clock } from 'lucide-vue-next'

const store = useAppStore()
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showReceipt = ref(false)

const steps = [
  { label: 'Select Token' },
  { label: 'Set Amount' },
  { label: 'Preview' },
  { label: 'Distribute' },
]

function handleDistribute() {
  if (isProcessing.value) return
  isProcessing.value = true
  currentStep.value = 2

  setTimeout(() => {
    currentStep.value = 3
    setTimeout(() => {
      currentStep.value = 4
      isProcessing.value = false
      showReceipt.value = true
      toast.success('Distribution initiated', {
        description: 'Yield distributed to 47 investors via ReineiraOS escrow',
      })
      setTimeout(() => {
        currentStep.value = 0
        amount.value = ''
        showReceipt.value = false
      }, 4000)
    }, 1500)
  }, 1200)
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="max-w-2xl mx-auto flex flex-col gap-8">
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
          <div class="flex justify-between"><span class="text-cool">Token</span><span class="font-medium text-midnight dark:text-white">MHTB</span></div>
          <div class="flex justify-between"><span class="text-cool">Total Amount</span><span class="font-mono text-midnight dark:text-white">${{ amount || '50,000.00' }}</span></div>
          <div class="flex justify-between"><span class="text-cool">Investors</span><span class="font-medium text-midnight dark:text-white">47</span></div>
          <div class="flex justify-between"><span class="text-cool">Settlement</span><span class="font-medium text-compute">ReineiraOS Escrow</span></div>
        </div>
        <MBadge variant="privacy" class="mx-auto">Amounts encrypted via FHE</MBadge>
      </div>

      <!-- Form -->
      <template v-else>
        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Select token</label>
        <div class="mt-2 mb-6 bg-mist dark:bg-midnight rounded-xl p-4 text-sm font-sans font-medium text-midnight dark:text-white cursor-pointer">
          MuHaven Treasury Bond Fund (MHTB) &#9662;
        </div>

        <label class="text-xs uppercase tracking-wider text-cool font-sans font-medium">Total yield to distribute</label>
        <div class="relative mt-2 mb-6">
          <span class="absolute left-4 top-1/2 -translate-y-1/2 text-lg text-cool">$</span>
          <input
            v-model="amount"
            placeholder="50,000.00"
            :disabled="isProcessing"
            class="w-full py-3.5 pl-8 pr-4 text-lg font-mono border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors disabled:opacity-50"
          />
        </div>

        <div class="bg-mist dark:bg-midnight rounded-xl p-5 mb-6">
          <div class="flex items-center justify-between mb-3">
            <p class="text-base font-sans font-medium text-midnight dark:text-white">Distribution preview</p>
            <MBadge variant="fhe">ReineiraOS</MBadge>
          </div>
          <div class="flex flex-col gap-2 text-sm">
            <div class="flex justify-between">
              <span class="text-cool">Eligible investors</span>
              <span class="font-medium text-midnight dark:text-white">47</span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Method</span>
              <span class="font-medium text-midnight dark:text-white">Proportional (FHE.div)</span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Per investor (avg)</span>
              <span class="font-medium text-midnight dark:text-white">~$1,063.83</span>
            </div>
            <div class="flex justify-between">
              <span class="text-cool">Platform fee (0.1%)</span>
              <span class="font-medium text-midnight dark:text-white">$50.00</span>
            </div>
          </div>
        </div>

        <MButton
          full-width
          size="lg"
          :loading="isProcessing"
          @click="handleDistribute"
        >
          Deposit &amp; Distribute
        </MButton>

        <div class="mt-5">
          <MPrivacyBanner text="Individual distribution amounts are encrypted via Fhenix FHE. You see totals only." />
        </div>
      </template>
    </MCard>

    <!-- Distribution history -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 250 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">Distribution History</p>
      <div
        v-for="(d, i) in DISTRIBUTION_HISTORY"
        :key="i"
        :class="[
          'flex items-center gap-4 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <div class="w-9 h-9 rounded-lg bg-compute/12 flex items-center justify-center">
          <CheckCircle :size="14" class="text-compute" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-base font-medium text-midnight dark:text-white">{{ d.token }} &middot; {{ formatUSD(d.totalAmount, 0) }}</p>
          <p class="text-xs text-cool mt-0.5">{{ d.date }} &middot; {{ d.investors }} investors</p>
        </div>
        <MBadge variant="positive">{{ d.status }}</MBadge>
      </div>
    </MCard>
  </div>
  </div>
</template>
