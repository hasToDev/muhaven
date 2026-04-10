<script setup lang="ts">
import { ref, computed } from 'vue'
import { PORTFOLIO } from '@/data/constants'
import { useAppStore } from '@/stores/app'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import {
  TrendingUp, ArrowDown, Activity, Search,
  Hash, BarChart3, CalendarDays, Lock,
} from 'lucide-vue-next'

const store = useAppStore()
const allActivity = PORTFOLIO.activity
const activeFilter = ref('all')
const expandedIndex = ref<number | null>(null)

const filters = ['all', 'yield', 'deposit', 'rebalance'] as const

const filteredActivity = computed(() => {
  if (activeFilter.value === 'all') return allActivity
  return allActivity.filter(a => a.type === activeFilter.value)
})

const filterCounts = computed(() => ({
  all: allActivity.length,
  yield: allActivity.filter(a => a.type === 'yield').length,
  deposit: allActivity.filter(a => a.type === 'deposit').length,
  rebalance: allActivity.filter(a => a.type === 'rebalance').length,
}))

// Group by time period
function getTimeGroup(time: string): string {
  if (time.includes('h ') || time === '2h ago' || time === '4h ago' || time === '5h ago' || time === '6h ago' || time === '12h ago') return 'Today'
  if (time.includes('d ago')) return 'This Week'
  return 'Earlier'
}

const activityMeta: Record<string, { icon: typeof TrendingUp; classes: string; bg: string; border: string }> = {
  yield: { icon: TrendingUp, classes: 'text-gold', bg: 'bg-gold/10 dark:bg-gold/8', border: 'border-l-gold' },
  deposit: { icon: ArrowDown, classes: 'text-compute', bg: 'bg-compute/12 dark:bg-compute/8', border: 'border-l-compute' },
  rebalance: { icon: Activity, classes: 'text-cool', bg: 'bg-mist dark:bg-midnight', border: 'border-l-cool' },
}

// Compute summary stats
const totalVolume = allActivity
  .filter(a => a.type === 'deposit')
  .reduce((sum, a) => sum + parseFloat(a.amount.replace(/[$,]/g, '')), 0)
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="flex flex-col gap-8">
    <div>
      <MSkeleton variant="title" width="140px" />
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="80px" />
    </div>
    <div class="flex gap-2">
      <MSkeleton v-for="i in 4" :key="i" width="80px" height="32px" />
    </div>
    <MSkeleton variant="card" height="350px" />
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col gap-10">
    <div
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">Activity</h1>
      <MGoldRule />
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MSummaryCard
        label="Total Transactions"
        :value="String(allActivity.length)"
        :icon="BarChart3"
      />
      <MSummaryCard
        label="This Month"
        :value="String(allActivity.filter(a => getTimeGroup(a.time) !== 'Earlier').length)"
        :icon="CalendarDays"
      />
      <MSummaryCard
        label="Total Deposits"
        :value="formatUSD(totalVolume)"
        :icon="ArrowDown"
      />
    </div>

    <!-- Filters with counts -->
    <div class="flex gap-2 flex-wrap">
      <MButton
        v-for="f in filters"
        :key="f"
        :variant="activeFilter === f ? 'primary' : 'ghost'"
        size="sm"
        @click="activeFilter = f"
      >
        {{ f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) + 's' }}
        <span class="ml-1 opacity-60">({{ filterCounts[f] }})</span>
      </MButton>
    </div>

    <!-- Activity timeline -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
    >
      <div
        v-if="filteredActivity.length === 0"
        class="flex flex-col items-center gap-3 py-12 text-cool"
      >
        <Search :size="32" class="opacity-40" />
        <p class="text-sm">No matching activity</p>
      </div>

      <template v-else>
        <template v-for="(a, i) in filteredActivity" :key="i">
          <!-- Time group header -->
          <div
            v-if="i === 0 || getTimeGroup(a.time) !== getTimeGroup(filteredActivity[i - 1].time)"
            :class="['text-xs uppercase tracking-wider text-cool font-medium', i > 0 ? 'mt-6 mb-3' : 'mb-3']"
          >
            {{ getTimeGroup(a.time) }}
          </div>

          <div
            v-motion
            :initial="{ opacity: 0, y: 8 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 300, delay: i * 60 } }"
            :class="[
              'flex items-start gap-4 py-4 border-l-2 pl-4 cursor-pointer transition-colors duration-200 hover:bg-mist/30 dark:hover:bg-midnight/30 -ml-1 rounded-r-lg',
              activityMeta[a.type]?.border || 'border-l-cool',
              i > 0 && getTimeGroup(a.time) === getTimeGroup(filteredActivity[i - 1].time) && 'border-t border-t-haze/30 dark:border-t-white/5',
            ]"
            @click="expandedIndex = expandedIndex === i ? null : i"
          >
            <div class="relative">
              <div :class="['w-9 h-9 rounded-lg flex items-center justify-center shrink-0', activityMeta[a.type]?.bg || 'bg-mist']">
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
              <p class="text-sm text-cool mt-0.5">{{ a.token }}</p>
              <!-- Expanded detail -->
              <div
                v-if="expandedIndex === i"
                class="mt-3 pt-3 border-t border-haze/30 dark:border-white/5 space-y-2"
              >
                <div class="flex items-center gap-2 text-xs text-cool">
                  <Hash :size="12" />
                  <span class="font-mono">0x4f2e...a8c1</span>
                </div>
                <MBadge variant="privacy">
                  <Lock :size="10" />
                  FHE Encrypted (euint128)
                </MBadge>
              </div>
            </div>
            <span class="text-xs text-cool whitespace-nowrap">{{ a.time }}</span>
          </div>
        </template>
      </template>
    </MCard>
  </div>
  </div>
</template>
