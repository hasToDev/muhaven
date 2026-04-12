<script setup lang="ts">
import { onMounted } from 'vue'
import { useIssuerComplianceStore } from '@/stores/issuer-compliance'
import { useIssuerInvestorsStore } from '@/stores/issuer-investors'
import { useAppStore } from '@/stores/app'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import InvestorBarChart from '@/components/charts/InvestorBarChart.vue'
import { Shield, CheckCircle, AlertTriangle, Clock, Ban } from 'lucide-vue-next'

const app = useAppStore()
const store = useIssuerComplianceStore()
const investorStore = useIssuerInvestorsStore()

function statusVariant(status: string) {
  if (status === 'active') return 'positive' as const
  if (status === 'review') return 'gold' as const
  if (status === 'blocked') return 'negative' as const
  return 'default' as const
}

onMounted(async () => {
  const loads: Promise<void>[] = []
  if (!store.loaded) loads.push(store.load())
  if (!investorStore.loaded) loads.push(investorStore.load())

  if (loads.length > 0) {
    app.startLoading()
    await Promise.all(loads)
    app.stopLoading()
  }
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.loading || investorStore.loading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="180px" />
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" v-for="i in 4" :key="i" height="100px" />
    </div>
    <MSkeleton variant="card" height="180px" />
    <MSkeleton variant="card" height="180px" />
    <MSkeleton variant="card" height="180px" />
  </div>

  <!-- Error -->
  <div v-else-if="store.error" class="flex flex-col items-center gap-4 py-16">
    <p class="text-negative text-sm">{{ store.error }}</p>
    <MButton variant="ghost" size="sm" @click="store.load()">Retry</MButton>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      class="flex items-center gap-3"
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <div>
        <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white">Compliance</h1>
        <MGoldRule />
      </div>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSummaryCard
        label="Total eligible"
        :value="String(store.stats.totalVerified)"
        accent
        size="lg"
        :icon="CheckCircle"
        class="col-span-2 md:col-span-1"
      />
      <MSummaryCard label="Ineligible" :value="String(store.stats.pendingReview)" :icon="Clock" />
      <MSummaryCard label="Expiring soon" :value="String(store.stats.expiringSoon)" :icon="AlertTriangle" />
      <MSummaryCard label="Blocked" :value="String(store.stats.blocked)" :icon="Ban" />
    </div>
    <p v-if="store.stats.isPartial" class="text-xs text-cool -mt-6">
      Stats based on loaded investors. Load all on Investors page for full counts.
    </p>

    <!-- KYC Gate Config -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 100 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-2">
          <Shield :size="16" class="text-compute" />
          <p class="text-base font-sans font-medium text-midnight dark:text-white">KYC Gate Configuration</p>
        </div>
        <MButton variant="ghost" size="sm" disabled>Edit</MButton>
      </div>
      <div class="grid grid-cols-2 gap-4 text-base">
        <div class="bg-mist/50 dark:bg-midnight/50 rounded-lg p-3">
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Provider</p>
          <p class="text-midnight dark:text-white font-medium">{{ store.kycGateConfig.provider }}</p>
        </div>
        <div class="bg-mist/50 dark:bg-midnight/50 rounded-lg p-3">
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Required Level</p>
          <p class="text-midnight dark:text-white font-medium">{{ store.kycGateConfig.requiredLevel }}</p>
        </div>
        <div class="bg-mist/50 dark:bg-midnight/50 rounded-lg p-3">
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Auto-Reject</p>
          <p class="text-midnight dark:text-white font-medium">{{ store.kycGateConfig.autoReject ? 'Enabled' : 'Disabled' }}</p>
        </div>
        <div class="bg-mist/50 dark:bg-midnight/50 rounded-lg p-3">
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Grace Period</p>
          <p class="text-midnight dark:text-white font-medium">{{ store.kycGateConfig.gracePeriodDays }} days</p>
        </div>
      </div>
    </MCard>

    <!-- Jurisdictions -->
    <MCard
      v-motion
      :initial="{ opacity: 0, x: -16 }"
      :visible-once="{ opacity: 1, x: 0, transition: { duration: 400, delay: 200 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Jurisdiction Overview</p>
        <MBadge variant="teal">Preview Data</MBadge>
      </div>
      <div
        v-for="(j, i) in store.jurisdictions"
        :key="j.code"
        :class="[
          'flex items-center gap-4 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <span class="text-lg w-8">{{ j.flag }}</span>
        <span class="flex-1 text-base text-midnight dark:text-white font-medium">{{ j.name }}</span>
        <MBadge :variant="statusVariant(j.status)" :pulse="j.status === 'review'">
          {{ j.status }}
        </MBadge>
        <span class="text-sm text-cool w-24 text-right">{{ j.investors }} investors</span>
      </div>
    </MCard>

    <!-- Investors by Jurisdiction Chart -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 250 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Investors by Jurisdiction</p>
        <MBadge variant="teal">Preview Data</MBadge>
      </div>
      <InvestorBarChart />
    </MCard>

    <!-- Trusted Issuers -->
    <MCard
      v-motion
      :initial="{ opacity: 0, x: 16 }"
      :visible-once="{ opacity: 1, x: 0, transition: { duration: 400, delay: 300 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Trusted Issuers</p>
        <div class="flex items-center gap-2">
          <MBadge variant="teal">Preview Data</MBadge>
          <MButton variant="ghost" size="sm" disabled>+ Add Issuer</MButton>
        </div>
      </div>
      <div
        v-for="(issuer, i) in store.trustedIssuers"
        :key="issuer.address"
        :class="[
          'flex items-center gap-4 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <CheckCircle :size="16" class="text-positive flex-shrink-0" />
        <div class="flex-1">
          <p class="text-base text-midnight dark:text-white font-medium">{{ issuer.name }}</p>
          <p class="font-mono text-xs text-cool mt-0.5">{{ issuer.address }}</p>
        </div>
        <span class="text-xs text-cool">{{ issuer.claims }} claims</span>
        <MBadge variant="positive">{{ issuer.status }}</MBadge>
      </div>
    </MCard>

    <MPrivacyBanner text="Compliance data is aggregate only. Individual investor KYC details are secured via ERC-3643 ONCHAINID." />
  </div>
  </div>
</template>
