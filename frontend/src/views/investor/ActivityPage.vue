<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { useActivityStore } from '@/stores/activity'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import { TrendingUp, ArrowDown, Activity, BarChart3, Lock, Inbox } from 'lucide-vue-next'

const app = useAppStore()
const activity = useActivityStore()

type FilterType = 'all' | 'yield' | 'escrow'
const activeFilter = ref<FilterType>('all')

const filtered = computed(() => {
  if (activeFilter.value === 'all') return activity.items
  return activity.items.filter(i => i.type === activeFilter.value)
})

const filterCounts = computed(() => ({
  all: activity.items.length,
  yield: activity.items.filter(i => i.type === 'yield').length,
  escrow: activity.items.filter(i => i.type === 'escrow').length,
}))

const activityMeta: Record<string, { icon: typeof TrendingUp; classes: string; bg: string }> = {
  yield: { icon: TrendingUp, classes: 'text-gold', bg: 'bg-gold/10 dark:bg-gold/8' },
  escrow: { icon: ArrowDown, classes: 'text-compute', bg: 'bg-compute/12 dark:bg-compute/8' },
}

onMounted(async () => {
  app.startLoading()
  await activity.load()
  app.stopLoading()
})

function formatTime(timestamp: string): string {
  const d = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffH = Math.floor(diffMs / (1000 * 60 * 60))
  const diffD = Math.floor(diffH / 24)

  if (diffH < 1) return 'Just now'
  if (diffH < 24) return `${diffH}h ago`
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString()
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="app.isLoading" class="flex flex-col gap-8">
    <MSkeleton variant="title" width="120px" />
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <MSkeleton variant="card" v-for="i in 3" :key="i" height="100px" />
    </div>
    <MSkeleton variant="card" height="300px" />
  </div>

  <!-- Error state -->
  <div v-else-if="activity.error" class="flex flex-col items-center justify-center py-20 gap-4">
    <p class="text-base text-cool">{{ activity.error }}</p>
    <MButton variant="outline" @click="activity.load()">Retry</MButton>
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

    <!-- Summary cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MSummaryCard label="Total Events" :value="String(activity.items.length)" :icon="BarChart3" />
      <MSummaryCard label="Yield Events" :value="String(filterCounts.yield)" :icon="TrendingUp" />
      <MSummaryCard label="Escrow Events" :value="String(filterCounts.escrow)" :icon="ArrowDown" />
    </div>

    <!-- Filter buttons -->
    <div class="flex gap-2">
      <MButton
        v-for="f in (['all', 'yield', 'escrow'] as FilterType[])"
        :key="f"
        :variant="activeFilter === f ? 'primary' : 'outline'"
        size="sm"
        @click="activeFilter = f"
      >
        {{ f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) }}
        <span class="ml-1.5 opacity-60">{{ filterCounts[f] }}</span>
      </MButton>
    </div>

    <!-- Activity timeline -->
    <MCard>
      <div v-if="filtered.length === 0" class="flex flex-col items-center py-12 gap-3">
        <Inbox :size="32" class="text-cool/30" />
        <p class="text-sm text-cool">No matching activity</p>
      </div>

      <div v-else>
        <div
          v-for="(item, i) in filtered"
          :key="item.id"
          :class="['flex items-center gap-4 py-4', i > 0 && 'border-t border-haze/50 dark:border-white/8']"
        >
          <div :class="['w-10 h-10 rounded-lg flex items-center justify-center', activityMeta[item.type]?.bg || 'bg-mist']">
            <component
              :is="activityMeta[item.type]?.icon || Activity"
              :size="16"
              :class="activityMeta[item.type]?.classes || 'text-cool'"
            />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-sans font-medium text-midnight dark:text-white">
              {{ item.type === 'yield' ? 'Yield Distribution' : 'Escrow Event' }}
              <span v-if="item.amount" class="font-mono text-xs ml-2">{{ formatUSD(parseFloat(item.amount)) }}</span>
            </p>
            <div class="flex items-center gap-2 mt-1">
              <MBadge :variant="item.status === 'claimed' ? 'positive' : item.status === 'pending' ? 'gold' : 'teal'">
                {{ item.status }}
              </MBadge>
              <span class="text-xs text-cool flex items-center gap-1">
                <Lock :size="10" />
                FHE encrypted
              </span>
            </div>
          </div>
          <span class="text-xs text-cool whitespace-nowrap">{{ formatTime(item.timestamp) }}</span>
        </div>
      </div>

      <!-- Load more -->
      <div v-if="activity.hasMore" class="mt-4 text-center">
        <MButton variant="outline" size="sm" :loading="activity.loadingMore" @click="activity.loadMore()">
          Load More
        </MButton>
      </div>
    </MCard>
  </div>
  </div>
</template>
