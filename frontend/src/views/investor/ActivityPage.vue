<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useActivityStore } from '@/stores/activity'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import MPrivacyProofPanel from '@/components/ui/MPrivacyProofPanel.vue'
import {
  TrendingUp, ArrowDown, Activity, BarChart3, Lock, Inbox, ChevronDown,
  Loader2,
} from 'lucide-vue-next'

const activity = useActivityStore()

type FilterType = 'all' | 'yield' | 'escrow'
const activeFilter = ref<FilterType>('all')
const expandedId = ref<string | null>(null)

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

const filtered = computed(() => {
  if (activeFilter.value === 'all') return activity.items
  return activity.items.filter(i => i.type === activeFilter.value)
})

const filterCounts = computed(() => ({
  all: activity.items.length,
  yield: activity.items.filter(i => i.type === 'yield').length,
  escrow: activity.items.filter(i => i.type === 'escrow').length,
}))

const yieldsThisWeek = computed(() => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return activity.items.filter(
    i => i.type === 'yield' && new Date(i.timestamp).getTime() >= sevenDaysAgo,
  ).length
})

const activityMeta: Record<string, {
  icon: typeof TrendingUp
  iconClass: string
  iconBg: string
  iconBorder: string
  amountClass: string
}> = {
  yield: {
    icon: TrendingUp,
    iconClass: 'text-positive',
    iconBg: 'bg-positive/10',
    iconBorder: 'border-positive/30',
    amountClass: 'text-positive',
  },
  escrow: {
    icon: ArrowDown,
    iconClass: 'text-cool',
    iconBg: 'bg-haze/40 dark:bg-white/5',
    iconBorder: 'border-haze dark:border-white/10',
    amountClass: 'text-midnight dark:text-white',
  },
}

onMounted(async () => {
  if (activity.loaded) return
  await activity.load()
})

const showLoader = computed(() =>
  !activity.loaded && !activity.error && activity.loading,
)

function statusAccent(status: string): { text: string; ring: string; bg: string } {
  switch (status) {
    case 'claimed':
      return { text: 'text-positive', ring: 'border-positive/30', bg: 'bg-positive/10' }
    case 'pending':
      return { text: 'text-gold', ring: 'border-gold/30', bg: 'bg-gold/10' }
    case 'claimable':
      return { text: 'text-compute dark:text-signal', ring: 'border-compute/30 dark:border-signal/30', bg: 'bg-compute/10 dark:bg-signal/10' }
    default:
      return { text: 'text-cool', ring: 'border-haze dark:border-white/10', bg: 'bg-haze/30 dark:bg-white/5' }
  }
}

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
    <!-- First-fetch loader -->
    <MPageLoader
      v-if="showLoader"
      label="Loading activity"
      caption="Indexing yield + escrow events"
    />

    <!-- Error -->
    <div v-else-if="activity.error" class="flex flex-col items-center justify-center py-20 gap-4">
      <p class="text-base text-cool">{{ activity.error }}</p>
      <MButton variant="outline" @click="activity.load()">Retry</MButton>
    </div>

    <!-- Content -->
    <div v-else class="flex flex-col gap-6">
      <!-- Main grid: timeline (8) + analytics (4) -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <!-- Timeline column -->
        <div class="lg:col-span-8 w-full flex flex-col gap-5">
          <!-- Filter pills -->
          <div class="flex items-center gap-2.5 overflow-x-auto pb-1 no-scrollbar">
            <button
              v-for="f in (['all', 'yield', 'escrow'] as FilterType[])"
              :key="f"
              type="button"
              @click="activeFilter = f"
              :data-testid="`activity-filter-${f}`"
              :class="[
                'font-sans text-xs font-medium px-5 py-2 rounded-full whitespace-nowrap transition-all duration-200 cursor-pointer border',
                activeFilter === f
                  ? 'bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal border-gold/40 dark:border-signal/35 shadow-[0_0_12px_-2px_rgba(255,186,32,0.25)]'
                  : 'bg-mist/50 dark:bg-[#171717] text-cool hover:text-midnight dark:hover:text-white border-transparent hover:border-haze dark:hover:border-white/10',
              ]"
            >
              {{ f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) }}
              <span class="ml-1.5 opacity-70 tabular-nums">{{ filterCounts[f] }}</span>
            </button>
          </div>

          <!-- Timeline card -->
          <section
            v-motion
            :initial="{ opacity: 0, y: 20 }"
            :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
            class="rounded-2xl border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717] overflow-hidden
                   shadow-[0_14px_40px_-12px_rgba(63,46,12,0.06)]
                   dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.55)]"
          >
            <!-- Empty -->
            <div
              v-if="filtered.length === 0"
              class="flex flex-col items-center py-16 gap-3"
            >
              <Inbox :size="36" :stroke-width="1.4" class="text-cool/35" />
              <p class="font-sans text-sm text-cool">No matching activity</p>
            </div>

            <!-- Rows -->
            <div v-else class="flex flex-col">
              <div
                v-for="item in filtered"
                :key="item.id"
                class="border-b border-haze/60 dark:border-white/5 last:border-b-0
                       hover:bg-mist/40 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div class="p-5 md:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div class="flex items-start sm:items-center gap-4 min-w-0">
                    <div
                      :class="[
                        'w-10 h-10 rounded-xl flex items-center justify-center border flex-shrink-0',
                        activityMeta[item.type]?.iconBg,
                        activityMeta[item.type]?.iconBorder,
                      ]"
                    >
                      <component
                        :is="activityMeta[item.type]?.icon ?? Activity"
                        :size="15"
                        :stroke-width="1.8"
                        :class="activityMeta[item.type]?.iconClass ?? 'text-cool'"
                      />
                    </div>
                    <div class="flex flex-col gap-1.5 min-w-0">
                      <div class="flex items-center gap-2.5 flex-wrap">
                        <span class="font-sans text-sm font-semibold text-midnight dark:text-white">
                          {{ item.type === 'yield' ? 'Yield Distribution' : 'Escrow Event' }}
                        </span>
                        <span
                          v-if="item.amount"
                          :class="['font-mono text-sm font-medium tabular-nums tracking-tight', activityMeta[item.type]?.amountClass]"
                        >
                          {{ formatUSD(parseFloat(item.amount)) }}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span
                          :class="[
                            'font-sans text-[9px] uppercase tracking-[0.22em] font-semibold px-2 py-0.5 rounded border',
                            statusAccent(item.status).text,
                            statusAccent(item.status).ring,
                            statusAccent(item.status).bg,
                          ]"
                        >
                          {{ item.status }}
                        </span>
                        <div
                          class="flex items-center gap-1 px-2 py-0.5 rounded border border-haze dark:border-white/10 bg-mist/50 dark:bg-[#0d0e10]"
                        >
                          <Lock :size="10" :stroke-width="1.8" class="text-cool" />
                          <span class="font-mono text-[9px] text-cool uppercase tracking-[0.18em]">FHE encrypted</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="flex items-center gap-4 sm:flex-shrink-0 pl-14 sm:pl-0">
                    <span class="font-sans text-[11px] text-cool whitespace-nowrap tabular-nums">
                      {{ formatTime(item.timestamp) }}
                    </span>
                    <button
                      v-if="item.tx_hash"
                      type="button"
                      @click="toggleExpand(item.id)"
                      :data-testid="`activity-row-toggle-${item.id}`"
                      :aria-expanded="expandedId === item.id"
                      :aria-controls="`activity-proof-${item.id}`"
                      class="flex items-center gap-1 font-sans text-[10px] uppercase tracking-[0.2em] font-semibold
                             text-compute dark:text-signal hover:text-compute/80 dark:hover:text-signal/80
                             transition-colors cursor-pointer"
                    >
                      <span>Proof</span>
                      <ChevronDown
                        :size="13"
                        :stroke-width="2"
                        aria-hidden="true"
                        :class="['transition-transform duration-200', expandedId === item.id && 'rotate-180']"
                      />
                    </button>
                  </div>
                </div>

                <!-- Expanded privacy proof -->
                <transition
                  enter-active-class="transition-opacity duration-300 ease-out"
                  leave-active-class="transition-opacity duration-200 ease-in"
                  enter-from-class="opacity-0"
                  leave-to-class="opacity-0"
                >
                  <div
                    v-if="expandedId === item.id && item.tx_hash"
                    :id="`activity-proof-${item.id}`"
                    role="region"
                    :aria-label="`Privacy proof for ${item.type} event`"
                    class="px-5 md:px-6 pb-5 md:pb-6 sm:pl-20"
                  >
                    <MPrivacyProofPanel :tx-hash="item.tx_hash" :default-open="true" />
                  </div>
                </transition>
              </div>
            </div>

            <!-- Load more footer -->
            <div
              v-if="activity.hasMore"
              class="bg-mist/50 dark:bg-[#0d0e10] p-4 flex justify-center border-t border-haze dark:border-white/5"
            >
              <button
                type="button"
                :disabled="activity.loadingMore"
                @click="activity.loadMore()"
                data-testid="activity-load-more"
                class="flex items-center gap-2 px-6 py-2.5 rounded-lg
                       border border-haze dark:border-white/10
                       font-sans text-xs uppercase tracking-[0.2em] font-semibold
                       text-cool hover:text-compute dark:hover:text-signal
                       hover:border-gold/40 dark:hover:border-signal/40
                       transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                <Loader2
                  v-if="activity.loadingMore"
                  :size="13"
                  class="animate-spin text-compute dark:text-signal"
                />
                <span v-else class="w-2 h-2 rounded-full bg-compute/60 dark:bg-signal/60 animate-pulse" />
                <span>{{ activity.loadingMore ? 'Loading…' : 'Load more' }}</span>
              </button>
            </div>
          </section>
        </div>

        <!-- Analytics column -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 200 } }"
          class="lg:col-span-4 w-full flex flex-col gap-4 lg:sticky lg:top-24"
        >
          <h3 class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold px-1">
            System Overview
          </h3>

          <!-- Total events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold">
                Total Events
              </span>
              <div class="w-11 h-11 rounded-xl bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25 flex items-center justify-center">
                <BarChart3 :size="18" :stroke-width="1.8" class="text-compute dark:text-signal" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ activity.items.length }}
            </div>
            <div class="w-full bg-haze/50 dark:bg-white/8 h-1.5 rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-gold to-signal dark:from-signal dark:to-gold rounded-full transition-all duration-700"
                :style="{ width: `${Math.min(activity.items.length * 6, 100)}%` }"
              />
            </div>
          </div>

          <!-- Yield events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-positive font-semibold">
                Yield Events
              </span>
              <div class="w-11 h-11 rounded-xl bg-positive/10 border border-positive/30 flex items-center justify-center">
                <TrendingUp :size="18" :stroke-width="1.8" class="text-positive" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ filterCounts.yield }}
            </div>
            <div class="flex items-center gap-1.5">
              <TrendingUp :size="14" :stroke-width="1.8" class="text-positive" />
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold text-positive tabular-nums">
                {{ yieldsThisWeek }} this week
              </span>
            </div>
          </div>

          <!-- Escrow events -->
          <div
            class="relative overflow-hidden rounded-2xl p-6
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   flex flex-col gap-4"
          >
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.24em] text-cool font-semibold">
                Escrow Events
              </span>
              <div class="w-11 h-11 rounded-xl bg-compute/10 dark:bg-signal/10 border border-compute/25 dark:border-signal/25 flex items-center justify-center">
                <ArrowDown :size="18" :stroke-width="1.8" class="text-compute dark:text-signal" />
              </div>
            </div>
            <div class="font-accent italic text-5xl md:text-6xl tracking-tighter text-midnight dark:text-white tabular-nums leading-none">
              {{ filterCounts.escrow }}
            </div>
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] font-bold text-cool italic">
              Awaiting on-chain settlement
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
