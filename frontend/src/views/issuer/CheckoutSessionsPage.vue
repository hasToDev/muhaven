<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, Settings2, Link as LinkIcon, ExternalLink } from 'lucide-vue-next'
import { useCheckoutStore } from '@/stores/checkout'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import type { CheckoutSessionStatus, CheckoutStatsRange } from '@/services/api'
import { formatAddress } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import CheckoutStatusPill from '@/components/checkout/CheckoutStatusPill.vue'
import CheckoutStatsCard from '@/components/checkout/CheckoutStatsCard.vue'
import CheckoutLinkModal from '@/components/checkout/CheckoutLinkModal.vue'

const router = useRouter()
const store = useCheckoutStore()
const tokensStore = useIssuerTokensStore()

const showModal = ref(false)

const STATUS_FILTERS: Array<{ key: CheckoutSessionStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'funded', label: 'Funded' },
  { key: 'wrapped', label: 'Wrapped' },
  { key: 'purchased', label: 'Purchased' },
  { key: 'settled', label: 'Settled' },
  { key: 'expired', label: 'Expired' },
  { key: 'failed', label: 'Failed' },
]

const filterKey = computed<CheckoutSessionStatus | 'all'>(() => store.sessionsFilter ?? 'all')

function setFilter(key: CheckoutSessionStatus | 'all') {
  store.setStatusFilter(key === 'all' ? null : key)
  store.loadSessions({ reset: true })
}

function openSessionDetail(sessionId: string) {
  router.push(`/checkout/${sessionId}`)
}

function fmtAmountFromMemo(): string {
  return 'Encrypted'
}

onMounted(async () => {
  // Tokens store is needed for the create-link modal's token picker.
  if (!tokensStore.loaded) tokensStore.load().catch(() => {})
  // Sessions + stats parallel.
  await Promise.allSettled([
    store.loadSessions({ reset: true }),
    store.loadStats('7d'),
  ])
})

watch(showModal, (v) => {
  // Refresh tokens when opening so a freshly-deployed token appears in the
  // modal's picker without a page reload.
  if (v && !tokensStore.loaded) tokensStore.load().catch(() => {})
})

const showFirstLoader = computed(() =>
  store.sessionsLoading && store.sessions.length === 0 && !store.sessionsError,
)

function onCreated() {
  // Refresh sessions list + stats after a successful mint so the new row
  // appears at the top of the list and totals update.
  store.loadSessions({ reset: true }).catch(() => {})
  store.loadStats().catch(() => {})
}

function setRange(range: CheckoutStatsRange) {
  store.loadStats(range).catch(() => {})
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="font-sans font-bold text-2xl text-midnight dark:text-white tracking-tight">
          Checkout
        </h1>
        <p class="font-sans text-sm text-cool mt-1">
          Mint buyer-facing links for token purchases — amounts encrypted, paid in mhUSDC.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <RouterLink
          to="/checkout/webhooks"
          data-testid="checkout-webhooks-link"
          class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-sans font-medium text-cool hover:text-midnight dark:hover:text-white rounded-md hover:bg-mist/60 dark:hover:bg-white/5 transition-colors cursor-pointer"
        >
          <Settings2 :size="14" />
          Webhooks
        </RouterLink>
        <MButton
          variant="primary"
          size="sm"
          data-testid="checkout-new-link-cta"
          @click="showModal = true"
        >
          <Plus :size="14" />
          <span class="ml-1.5">New checkout link</span>
        </MButton>
      </div>
    </div>

    <!-- Stats card -->
    <CheckoutStatsCard
      :stats="store.stats"
      :loading="store.statsLoading"
      :range="store.statsRange"
      @range-change="setRange"
    />

    <!-- Filter chips -->
    <div class="flex flex-wrap gap-2">
      <button
        v-for="f in STATUS_FILTERS"
        :key="f.key"
        type="button"
        :data-testid="`checkout-filter-${f.key}`"
        :class="[
          'px-3 py-1 text-[11px] font-sans font-medium rounded-full border transition-colors',
          filterKey === f.key
            ? 'bg-gold/10 ring-1 ring-gold/40 border-gold/40 text-compute dark:text-signal'
            : 'bg-white dark:bg-midnight-mid border-haze dark:border-white/10 text-cool hover:text-midnight dark:hover:text-white cursor-pointer',
        ]"
        @click="setFilter(f.key)"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- Body -->
    <div class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 overflow-hidden">
      <MPageLoader v-if="showFirstLoader" label="Loading sessions" caption="Reading issuer-scoped checkout history" />

      <div v-else-if="store.sessionsError" class="p-8 text-center">
        <p class="font-sans text-sm text-negative">{{ store.sessionsError }}</p>
        <MButton variant="outline" size="sm" class="mt-3" @click="store.loadSessions({ reset: true })">Retry</MButton>
      </div>

      <div v-else-if="store.sessions.length === 0" class="p-10 text-center space-y-3">
        <div class="inline-flex w-12 h-12 rounded-2xl bg-gold/10 ring-1 ring-gold/30 items-center justify-center">
          <LinkIcon :size="22" :stroke-width="1.7" class="text-compute dark:text-signal" />
        </div>
        <p class="font-accent italic text-lg text-midnight dark:text-white">No checkout sessions yet.</p>
        <p class="font-sans text-sm text-cool max-w-md mx-auto">
          Mint your first link to share with a buyer. They'll pay in mhUSDC; the amount stays encrypted at rest.
        </p>
        <MButton variant="primary" size="sm" class="mt-2" @click="showModal = true" data-testid="checkout-empty-cta">
          <Plus :size="14" />
          <span class="ml-1.5">Create your first link</span>
        </MButton>
      </div>

      <table v-else class="w-full">
        <thead>
          <tr class="text-left">
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Session</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Status</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Token</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Amount</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Buyer</th>
            <th class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold px-5 py-3">Created</th>
            <th class="px-5 py-3 w-8"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-haze/60 dark:divide-white/8">
          <tr
            v-for="s in store.sessions"
            :key="s.sessionId"
            class="hover:bg-mist/30 dark:hover:bg-white/3 transition-colors cursor-pointer"
            :data-testid="`checkout-row-${s.sessionId}`"
            @click="openSessionDetail(s.sessionId)"
          >
            <td class="px-5 py-3 font-mono text-[12px] text-midnight dark:text-white">
              {{ s.sessionId.slice(0, 10) }}…{{ s.sessionId.slice(-6) }}
            </td>
            <td class="px-5 py-3">
              <CheckoutStatusPill :status="s.status" size="sm" />
            </td>
            <td class="px-5 py-3 text-sm font-sans text-midnight dark:text-white">
              {{ s.metadata.tokenSymbol }}
            </td>
            <td class="px-5 py-3 text-xs font-mono text-cool/80 italic">
              {{ fmtAmountFromMemo() }}
            </td>
            <td class="px-5 py-3 text-xs font-mono text-cool">
              <span v-if="s.buyerAddress">{{ formatAddress(s.buyerAddress) }}</span>
              <span v-else class="text-cool/60">—</span>
            </td>
            <td class="px-5 py-3 text-xs text-cool tabular-nums">
              {{ new Date(s.createdAt).toLocaleString() }}
            </td>
            <td class="px-5 py-3 text-cool group-hover:text-compute dark:group-hover:text-signal">
              <ExternalLink :size="13" />
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="store.sessions.length > 0 && store.hasMore" class="flex justify-center py-4 border-t border-haze/60 dark:border-white/8">
        <MButton
          variant="ghost"
          size="sm"
          :loading="store.sessionsLoading"
          data-testid="checkout-load-more"
          @click="store.loadSessions()"
        >
          Load more
        </MButton>
      </div>
    </div>

    <!-- Modal -->
    <CheckoutLinkModal :open="showModal" @close="showModal = false" @created="onCreated" />
  </div>
</template>
