<script setup lang="ts">
import { PORTFOLIO, YIELDS_DATA, YIELD_BREAKDOWN } from '@/data/constants'
import { useAppStore } from '@/stores/app'
import { useCountUp } from '@/composables/useCountUp'
import MCard from '@/components/ui/MCard.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MPrivacyBanner from '@/components/ui/MPrivacyBanner.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import InsightChip from '@/components/agent/InsightChip.vue'
import PortfolioDonut from '@/components/charts/PortfolioDonut.vue'
import { TrendingUp, ArrowDown, Activity, Shield, DollarSign, Percent } from 'lucide-vue-next'
import { formatUSD } from '@/lib/utils'

const store = useAppStore()
const { target: heroRef, displayValue: heroValue } = useCountUp(PORTFOLIO.totalValue, 1500, 2)

const weightedAPY = PORTFOLIO.holdings.reduce((acc, h) => acc + h.apy * h.pct / 100, 0)

const activityMeta: Record<string, { icon: typeof TrendingUp; classes: string; bg: string }> = {
  yield: { icon: TrendingUp, classes: 'text-gold', bg: 'bg-gold/10 dark:bg-gold/8' },
  deposit: { icon: ArrowDown, classes: 'text-compute', bg: 'bg-compute/12 dark:bg-compute/8' },
  rebalance: { icon: Activity, classes: 'text-cool', bg: 'bg-mist dark:bg-midnight' },
}

// Only show first 4 in recent activity
const recentActivity = PORTFOLIO.activity.slice(0, 4)
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="text" :lines="1" width="160px" />
      <MSkeleton variant="title" width="320px" height="48px" class="mt-3" />
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="100px" />
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="150px" />
    </div>
    <MSkeleton variant="chart" height="220px" />
    <MSkeleton variant="card" height="200px" />
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <!-- Hero value -->
    <div
      v-motion
      :initial="{ opacity: 0, y: 30, scale: 0.98 }"
      :visible-once="{ opacity: 1, y: 0, scale: 1, transition: { duration: 600 } }"
    >
      <p class="text-xs uppercase tracking-wider text-cool font-sans font-medium mb-1">
        Total Portfolio Value
      </p>
      <MGoldRule />
      <div class="flex items-baseline gap-4 mt-3">
        <span ref="heroRef" class="text-5xl md:text-6xl font-accent italic text-midnight dark:text-white tracking-tight">
          ${{ heroValue }}
        </span>
        <MBadge variant="positive" pulse>
          &uarr; {{ PORTFOLIO.change }}% this month
        </MBadge>
      </div>
    </div>

    <!-- Secondary stats row -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MSummaryCard
        label="Total Earned"
        :value="formatUSD(YIELDS_DATA.totalEarned)"
        accent
        :icon="DollarSign"
        :trend="{ value: 4.2, direction: 'up' }"
      />
      <MSummaryCard
        label="Weighted APY"
        :value="`${weightedAPY.toFixed(2)}%`"
        :icon="Percent"
      />
      <MSummaryCard
        label="FHE Status"
        value="Active"
        sub="Balances encrypted (euint128)"
        :icon="Shield"
      />
    </div>

    <!-- Holdings cards — featured layout -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
      <MCard
        v-for="(h, i) in PORTFOLIO.holdings"
        :key="h.symbol"
        hover
        glow
        :class="i === 0 ? 'md:col-span-2' : ''"
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: i * 120 } }"
      >
        <div class="flex justify-between items-center mb-4">
          <span :class="['font-sans font-medium text-midnight dark:text-white', i === 0 ? 'text-base' : 'text-base']">{{ h.name }}</span>
          <span class="font-mono text-xs text-cool">{{ h.symbol }}</span>
        </div>
        <p :class="['font-accent italic text-midnight dark:text-white mb-3', i === 0 ? 'text-3xl' : 'text-2xl']">
          {{ formatUSD(h.value) }}
        </p>
        <div class="flex gap-3 items-center text-base">
          <span class="text-slate">{{ h.pct }}% allocation</span>
          <span class="text-gold font-medium">&uarr; {{ h.apy }}% APY</span>
        </div>
        <div v-if="i === 0" class="mt-3">
          <MBadge variant="privacy">FHE Encrypted</MBadge>
        </div>
      </MCard>
    </div>

    <!-- Allocation with donut chart -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 200 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Allocation</p>
        <span class="text-xs text-cool">Combined APY: <span class="text-compute font-medium">{{ weightedAPY.toFixed(2) }}%</span></span>
      </div>
      <div class="flex flex-col md:flex-row gap-6 items-center">
        <div class="w-40 md:w-52 flex-shrink-0">
          <PortfolioDonut />
        </div>
        <div class="flex-1 w-full">
          <div class="flex h-3 rounded-full overflow-hidden gap-0.5 mb-4">
            <div
              v-for="h in PORTFOLIO.holdings"
              :key="h.symbol"
              :class="[h.colorClass, 'rounded-full transition-all duration-1000 ease-out']"
              :style="{ width: `${h.pct}%` }"
            />
          </div>
          <div class="flex flex-wrap gap-5 mb-4">
            <div v-for="h in PORTFOLIO.holdings" :key="h.symbol" class="flex items-center gap-2">
              <div :class="['w-2.5 h-2.5 rounded-sm', h.colorClass]" />
              <span class="text-xs text-slate">{{ h.name }} &middot; {{ h.pct }}%</span>
            </div>
          </div>
          <!-- Yield breakdown per token -->
          <div class="border-t border-haze/50 dark:border-white/8 pt-4 space-y-2">
            <div v-for="h in PORTFOLIO.holdings" :key="h.symbol" class="flex items-center justify-between text-xs">
              <span class="text-cool">{{ h.symbol }} earned</span>
              <span class="font-mono text-midnight dark:text-white">{{ formatUSD(YIELD_BREAKDOWN[h.symbol] || 0) }}</span>
            </div>
          </div>
          <div class="mt-4">
            <InsightChip
              text="Allocation optimal"
              detail="Your treasury allocation at 70% is within the recommended range for your risk profile. Money market at 20% provides yield diversification."
              agent-prompt="Is my current portfolio allocation optimal?"
            />
          </div>
        </div>
      </div>
    </MCard>

    <!-- Recent activity -->
    <MCard
      v-motion
      :initial="{ opacity: 0, x: -16 }"
      :visible-once="{ opacity: 1, x: 0, transition: { duration: 400, delay: 300 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">Recent Activity</p>
      <div
        v-for="(a, i) in recentActivity"
        :key="i"
        :class="[
          'flex items-center gap-4 py-4',
          i > 0 && 'border-t border-haze/50 dark:border-white/8',
        ]"
      >
        <div class="relative">
          <!-- Timeline connector -->
          <div v-if="i < recentActivity.length - 1" class="absolute top-10 left-1/2 -translate-x-1/2 w-px h-8 bg-haze/50 dark:bg-white/8" />
          <div :class="['w-10 h-10 rounded-lg flex items-center justify-center', activityMeta[a.type]?.bg || 'bg-mist']">
            <component
              :is="activityMeta[a.type]?.icon || Activity"
              :size="16"
              :class="activityMeta[a.type]?.classes || 'text-cool'"
            />
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-base font-sans font-medium text-midnight dark:text-white">
            {{ a.desc }} &middot;
            <span class="font-mono text-xs">{{ a.amount }}</span>
          </p>
          <p class="text-sm text-cool mt-1">{{ a.token }}</p>
        </div>
        <span class="text-xs text-cool whitespace-nowrap">{{ a.time }}</span>
      </div>
    </MCard>

    <MPrivacyBanner text="All balances are encrypted on-chain via Fhenix FHE. Only you can see this data." />
  </div>
  </div>
</template>
