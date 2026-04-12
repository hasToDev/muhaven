<script setup lang="ts">
import { onMounted } from 'vue'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useAppStore } from '@/stores/app'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import TokenGrowthChart from '@/components/charts/TokenGrowthChart.vue'
import { DollarSign, Users, Percent, Coins } from 'lucide-vue-next'
import type { TokenStatus } from '@/services/api'

const app = useAppStore()
const store = useIssuerTokensStore()

function statusVariant(status: TokenStatus) {
  if (status === 'active') return 'positive' as const
  if (status === 'paused') return 'gold' as const
  if (status === 'winding_down') return 'negative' as const
  return 'default' as const
}

function statusLabel(status: TokenStatus) {
  if (status === 'winding_down') return 'Winding Down'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

onMounted(async () => {
  if (!store.loaded) {
    app.startLoading()
    await store.load()
    app.stopLoading()
  }
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.loading" class="flex flex-col gap-8">
    <div class="flex justify-between items-center">
      <MSkeleton variant="title" width="180px" />
      <MSkeleton width="110px" height="36px" />
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" v-for="i in 4" :key="i" height="100px" />
    </div>
    <MSkeleton variant="card" v-for="i in 2" :key="i" height="220px" />
  </div>

  <!-- Error -->
  <div v-else-if="store.error" class="flex flex-col items-center gap-4 py-16">
    <p class="text-negative text-sm">{{ store.error }}</p>
    <MButton variant="ghost" size="sm" @click="store.load()">Retry</MButton>
  </div>

  <!-- Empty -->
  <div v-else-if="store.loaded && store.tokens.length === 0" class="flex flex-col items-center gap-4 py-16">
    <Coins :size="40" class="text-cool opacity-40" />
    <p class="text-cool text-sm">No tokens issued yet</p>
    <MButton>+ New Token</MButton>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      class="flex justify-between items-center"
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <div>
        <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white">Your Tokens</h1>
        <MGoldRule />
      </div>
      <MButton>+ New Token</MButton>
    </div>

    <!-- Aggregate overview -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MSummaryCard
        label="Total AUM"
        :value="store.aggregateStats.totalAUM ? formatUSD(parseFloat(store.aggregateStats.totalAUM), 0) : '--'"
        accent
        :icon="DollarSign"
      />
      <MSummaryCard
        label="Total Investors"
        :value="String(store.aggregateStats.totalInvestors)"
        :icon="Users"
      />
      <MSummaryCard
        label="Weighted APY"
        :value="store.aggregateStats.weightedAPY ? `${store.aggregateStats.weightedAPY}%` : '--'"
        :icon="Percent"
      />
      <MSummaryCard
        label="Active Tokens"
        :value="String(store.aggregateStats.activeTokens)"
        :icon="Coins"
      />
    </div>

    <!-- Token cards -->
    <MCard
      v-for="(t, i) in store.tokens"
      :key="t.address"
      hover
      glow
      v-motion
      :initial="{ opacity: 0, y: 20, scale: 0.98 }"
      :visible-once="{ opacity: 1, y: 0, scale: 1, transition: { duration: 400, delay: i * 120 } }"
    >
      <div class="flex justify-between items-start mb-4">
        <div>
          <p class="text-lg font-sans font-semibold text-midnight dark:text-white">{{ t.name }}</p>
          <p class="font-mono text-xs text-cool mt-1">{{ t.symbol }}</p>
        </div>
        <div class="flex items-center gap-2">
          <MBadge :variant="statusVariant(t.status)" :pulse="t.status === 'paused'">
            {{ statusLabel(t.status) }}
          </MBadge>
          <MBadge variant="privacy">FHE Encrypted</MBadge>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div>
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Supply</p>
          <p class="text-base font-medium text-midnight dark:text-white">{{ t.supply }}</p>
        </div>
        <div>
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Investors</p>
          <p class="text-base font-medium text-midnight dark:text-white">{{ t.investors ?? '--' }}</p>
        </div>
        <div>
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Yield APY</p>
          <p class="text-base font-medium text-gold">{{ t.apy ? `${t.apy}%` : '--' }}</p>
        </div>
        <div>
          <p class="text-xs text-cool uppercase tracking-wider mb-1">Schedule</p>
          <p class="text-base font-medium text-midnight dark:text-white">{{ t.schedule ?? '--' }}</p>
        </div>
      </div>

      <div class="border-t border-haze/30 dark:border-white/8 pt-4">
        <p class="text-xs text-cool mb-3">Investor Growth</p>
        <div class="h-[120px]">
          <TokenGrowthChart :symbol="t.symbol" />
        </div>
      </div>
    </MCard>

    <MPrivacyBanner text="Aggregate data only. Individual investor balances are encrypted via Fhenix FHE and not visible to issuers." />
  </div>
  </div>
</template>
