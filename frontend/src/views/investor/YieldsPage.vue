<script setup lang="ts">
import { ref } from 'vue'
import { YIELDS_DATA, PORTFOLIO, YIELD_BREAKDOWN } from '@/data/constants'
import { toast } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MProgressBar from '@/components/ui/MProgressBar.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import YieldLineChart from '@/components/charts/YieldLineChart.vue'
import { DollarSign, Clock, CalendarDays, TrendingUp } from 'lucide-vue-next'

const store = useAppStore()
const activeRange = ref('6M')
const ranges = ['1M', '3M', '6M', 'All'] as const

function claimYield(token: string, amount: number) {
  toast.success('Yield claimed', {
    description: `$${amount.toFixed(2)} from ${token}`,
  })
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="120px" />
    </div>
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" class="md:col-span-2" height="120px" />
      <MSkeleton variant="card" height="100px" />
      <MSkeleton variant="card" height="100px" />
    </div>
    <MSkeleton variant="card" height="200px" />
    <MSkeleton variant="chart" height="220px" />
    <MSkeleton variant="card" height="180px" />
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">Yields</h1>
      <MGoldRule />
    </div>

    <!-- Summary cards — hero + secondary -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MSummaryCard
        class="md:col-span-2"
        label="Total Earned"
        :value="formatUSD(YIELDS_DATA.totalEarned)"
        accent
        size="lg"
        :icon="DollarSign"
        :trend="{ value: 4.2, direction: 'up' }"
      />
      <MSummaryCard
        label="Pending"
        :value="formatUSD(YIELDS_DATA.pending)"
        accent
        :icon="Clock"
      />
      <MSummaryCard
        label="Next Payout"
        :value="YIELDS_DATA.nextPayout"
        :icon="CalendarDays"
      />
    </div>

    <!-- Yield breakdown per token -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 100 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">Yield Breakdown</p>
      <div class="space-y-5">
        <div v-for="h in PORTFOLIO.holdings" :key="h.symbol" class="flex items-center gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-base font-medium text-midnight dark:text-white">{{ h.name }}</span>
                <span class="font-mono text-xs text-cool">{{ h.symbol }}</span>
              </div>
              <span class="text-sm font-mono font-medium text-midnight dark:text-white">
                {{ formatUSD(YIELD_BREAKDOWN[h.symbol] || 0) }}
              </span>
            </div>
            <div class="flex items-center gap-3">
              <MProgressBar :value="h.pct" color="bg-compute" class="flex-1" />
              <span class="text-xs text-gold font-medium w-16 text-right">{{ h.apy }}% APY</span>
            </div>
          </div>
        </div>
      </div>
    </MCard>

    <!-- Yield trend chart with time range -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 150 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Yield Trend</p>
        <div class="flex gap-1 bg-mist dark:bg-midnight rounded-lg p-0.5">
          <button
            v-for="r in ranges"
            :key="r"
            @click="activeRange = r"
            :class="[
              'px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 cursor-pointer',
              activeRange === r
                ? 'bg-white dark:bg-midnight-mid shadow-sm text-compute'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ r }}
          </button>
        </div>
      </div>
      <YieldLineChart />
    </MCard>

    <!-- Pending claims -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 200 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Pending Claims</p>
        <MBadge variant="teal" :pulse="true">{{ YIELDS_DATA.pendingClaims.length }} Claimable</MBadge>
      </div>
      <div
        v-for="(c, i) in YIELDS_DATA.pendingClaims"
        :key="i"
        :class="[
          'flex items-center justify-between py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <div>
          <p class="text-base font-sans font-medium text-midnight dark:text-white">{{ c.token }}</p>
          <p class="text-xl font-accent italic text-midnight dark:text-white mt-1">
            {{ formatUSD(c.amount) }}
          </p>
        </div>
        <MButton size="sm" @click="claimYield(c.token, c.amount)">
          Claim
        </MButton>
      </div>
    </MCard>

    <!-- History -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 250 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">History</p>
      <div
        v-for="(h, i) in YIELDS_DATA.history"
        :key="i"
        :class="[
          'flex items-center gap-3.5 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <div class="w-9 h-9 rounded-lg bg-gold/10 flex items-center justify-center">
          <TrendingUp :size="14" class="text-gold" />
        </div>
        <span class="text-xs text-cool w-14 shrink-0">{{ h.date }}</span>
        <span class="flex-1 text-base text-midnight dark:text-white">{{ h.token }}</span>
        <span class="font-mono text-sm font-medium text-midnight dark:text-white">{{ h.amount }}</span>
        <MBadge variant="positive">Claimed &#10003;</MBadge>
      </div>
    </MCard>
  </div>
  </div>
</template>
