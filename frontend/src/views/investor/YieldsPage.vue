<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import { useYieldsStore } from '@/stores/yields'
import { useWallet } from '@/composables/useWallet'
import * as EscrowService from '@/services/contracts/EscrowService'
import { WalletNotConnectedError } from '@/services/contracts/errors'
import { formatUSD } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'
import MBadge from '@/components/ui/MBadge.vue'
import MSummaryCard from '@/components/ui/MSummaryCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import YieldLineChart from '@/components/charts/YieldLineChart.vue'
import { DollarSign, Clock, CalendarDays, TrendingUp, Inbox } from 'lucide-vue-next'

const app = useAppStore()
const yields = useYieldsStore()
const { connected } = useWallet()
const activeRange = ref<'1m' | '3m' | '6m' | '1y'>('6m')
const ranges = [
  { label: '1M', value: '1m' as const },
  { label: '3M', value: '3m' as const },
  { label: '6M', value: '6m' as const },
  { label: '1Y', value: '1y' as const },
]

const claimingIds = ref<Set<string>>(new Set())

// Backend poller runs every 15s (BLOCK_POLLER_INTERVAL_MS). Account for bundler
// latency + block inclusion + one poll cycle before the yield record flips
// claimable → claimed. 22s hits the sweet spot for a single refetch.
const CLAIM_REFETCH_DELAY_MS = 22_000

const ARBISCAN_TX_BASE = 'https://sepolia.arbiscan.io/tx/'

onMounted(async () => {
  app.startLoading()
  await yields.load()
  app.stopLoading()
})

async function claimYield(recordId: string, escrowId: string | null) {
  if (claimingIds.value.has(recordId)) return

  if (!escrowId) {
    toast.error('Claim unavailable', {
      description: 'On-chain escrow not yet indexed — try again shortly',
    })
    return
  }

  // Note: `connected.value` can be true while the wallet provider is still
  // dormant (address restored from localStorage, provider not yet materialized).
  // The try/catch below handles that lazy-reconnect case via WalletNotConnectedError.
  if (!connected.value) {
    toast.error('Wallet not connected', {
      description: 'Sign in with your passkey to claim yield',
    })
    return
  }

  claimingIds.value.add(recordId)
  try {
    const hash = await EscrowService.redeem(BigInt(escrowId))
    toast.success('Claim submitted', {
      description: `tx ${hash.slice(0, 10)}… — status will update once confirmed`,
      action: {
        label: 'View',
        onClick: () => window.open(`${ARBISCAN_TX_BASE}${hash}`, '_blank', 'noopener'),
      },
    })
    // Keep the button spinning through the refetch window so the user can't
    // double-submit against an already-redeemed escrow while the poller catches up.
    await new Promise(r => setTimeout(r, CLAIM_REFETCH_DELAY_MS))
    await yields.load()
  } catch (e) {
    const description = e instanceof WalletNotConnectedError
      ? 'Sign in with your passkey and try again'
      : e instanceof Error ? e.message : 'Unknown error'
    toast.error('Claim failed', { description })
  } finally {
    claimingIds.value.delete(recordId)
  }
}

function statusBadgeVariant(status: string): 'positive' | 'gold' | 'teal' | 'default' {
  switch (status) {
    case 'claimed': return 'positive'
    case 'claimable': return 'teal'
    case 'pending': return 'gold'
    default: return 'default'
  }
}
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="app.isLoading" class="flex flex-col gap-8">
    <MSkeleton variant="title" width="120px" />
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MSkeleton variant="card" class="md:col-span-2" height="120px" />
      <MSkeleton variant="card" height="100px" />
      <MSkeleton variant="card" height="100px" />
    </div>
    <MSkeleton variant="chart" height="220px" />
    <MSkeleton variant="card" height="180px" />
  </div>

  <!-- Error state -->
  <div v-else-if="yields.error" class="flex flex-col items-center justify-center py-20 gap-4">
    <p class="text-base text-cool">{{ yields.error }}</p>
    <MButton variant="outline" @click="yields.load()">Retry</MButton>
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

    <!-- Summary cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MSummaryCard
        class="md:col-span-2"
        label="Total Earned"
        :value="formatUSD(yields.totalEarned)"
        accent
        size="lg"
        :icon="DollarSign"
      />
      <MSummaryCard
        label="Pending"
        :value="formatUSD(yields.totalPending)"
        accent
        :icon="Clock"
      />
      <MSummaryCard
        label="Total Records"
        :value="String(yields.total)"
        :icon="CalendarDays"
      />
    </div>

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
            :key="r.value"
            @click="activeRange = r.value"
            :class="[
              'px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 cursor-pointer',
              activeRange === r.value
                ? 'bg-white dark:bg-midnight-mid shadow-sm text-compute'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            ]"
          >
            {{ r.label }}
          </button>
        </div>
      </div>
      <YieldLineChart :range="activeRange" />
    </MCard>

    <!-- Claimable yields -->
    <MCard
      v-if="yields.claimable.length > 0"
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 200 } }"
    >
      <div class="flex items-center justify-between mb-5">
        <p class="text-base font-sans font-medium text-midnight dark:text-white">Claimable Yields</p>
        <MBadge variant="teal" :pulse="true">{{ yields.claimable.length }} Claimable</MBadge>
      </div>
      <div
        v-for="(c, i) in yields.claimable"
        :key="c.id"
        :class="['flex items-center justify-between py-4', i > 0 && 'border-t border-haze/50 dark:border-white/8']"
      >
        <div>
          <p class="text-base font-sans font-medium text-midnight dark:text-white">Distribution #{{ c.distribution_id }}</p>
          <p v-if="c.amount" class="text-xl font-accent italic text-midnight dark:text-white mt-1">
            {{ formatUSD(parseFloat(c.amount)) }}
          </p>
          <p v-else class="text-sm text-cool mt-1">Amount encrypted</p>
        </div>
        <MButton
          size="sm"
          :loading="claimingIds.has(c.id)"
          :disabled="!c.escrow_id"
          @click="claimYield(c.id, c.escrow_id)"
        >
          Claim
        </MButton>
      </div>
    </MCard>

    <!-- All yield records -->
    <MCard
      v-motion
      :initial="{ opacity: 0, y: 16 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 400, delay: 250 } }"
    >
      <p class="text-base font-sans font-medium text-midnight dark:text-white mb-5">History</p>

      <div v-if="yields.items.length === 0" class="flex flex-col items-center py-8 gap-3">
        <Inbox :size="32" class="text-cool/30" />
        <p class="text-sm text-cool">No yield records yet</p>
      </div>

      <div v-else>
        <div
          v-for="(item, i) in yields.items"
          :key="item.id"
          :class="['flex items-center gap-3.5 py-4', i > 0 && 'border-t border-haze/50 dark:border-white/8']"
        >
          <div class="w-9 h-9 rounded-lg bg-gold/10 flex items-center justify-center">
            <TrendingUp :size="14" class="text-gold" />
          </div>
          <span class="text-xs text-cool w-20 shrink-0">{{ new Date(item.created_at).toLocaleDateString() }}</span>
          <span class="flex-1 text-base text-midnight dark:text-white">Dist #{{ item.distribution_id }}</span>
          <span v-if="item.amount" class="font-mono text-sm font-medium text-midnight dark:text-white">
            {{ formatUSD(parseFloat(item.amount)) }}
          </span>
          <span v-else class="font-mono text-sm text-cool">Encrypted</span>
          <MBadge :variant="statusBadgeVariant(item.status)">{{ item.status }}</MBadge>
        </div>
      </div>
    </MCard>
  </div>
  </div>
</template>
