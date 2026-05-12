<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Copy, Check, ExternalLink, Clock, User, Hash } from 'lucide-vue-next'
import { useCheckoutStore } from '@/stores/checkout'
import { formatAddress } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import CheckoutStatusPill from '@/components/checkout/CheckoutStatusPill.vue'

const route = useRoute()
const router = useRouter()
const store = useCheckoutStore()

const copyState = ref<'idle' | 'copied'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | null = null

const sessionId = computed(() => String(route.params.sessionId ?? ''))

onMounted(() => {
  store.loadSessionDetail(sessionId.value).catch(() => {})
})

watch(sessionId, (next) => {
  if (next) store.loadSessionDetail(next).catch(() => {})
})

const session = computed(() => store.sessionDetail)

async function copySessionId() {
  if (!session.value) return
  try {
    await navigator.clipboard.writeText(session.value.sessionId)
    copyState.value = 'copied'
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyState.value = 'idle'
    }, 1800)
  } catch {
    // ignore
  }
}

function arbiscanTx(hash: string): string {
  return `https://sepolia.arbiscan.io/tx/${hash}`
}
</script>

<template>
  <div class="space-y-6">
    <!-- Back link -->
    <button
      type="button"
      class="inline-flex items-center gap-1.5 text-xs font-sans font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer"
      data-testid="checkout-detail-back"
      @click="router.push('/checkout')"
    >
      <ArrowLeft :size="14" />
      Back to sessions
    </button>

    <!-- Loading -->
    <MPageLoader
      v-if="store.sessionDetailLoading && !session"
      label="Loading session"
      caption="Reading checkout session metadata"
    />

    <!-- Error -->
    <div v-else-if="store.sessionDetailError" class="flex flex-col items-center gap-3 py-12">
      <p class="font-sans text-sm text-negative">{{ store.sessionDetailError }}</p>
      <MButton
        variant="outline"
        size="sm"
        @click="store.loadSessionDetail(sessionId)"
      >Retry</MButton>
    </div>

    <!-- Detail -->
    <template v-else-if="session">
      <!-- Header -->
      <div class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-2">
              <CheckoutStatusPill :status="session.status" />
              <span class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold">
                {{ session.metadata.tokenSymbol }}
              </span>
            </div>
            <h1 class="font-sans font-bold text-xl text-midnight dark:text-white tracking-tight">
              {{ session.metadata.description || 'Checkout session' }}
            </h1>
            <div class="mt-2 flex items-center gap-2 text-cool">
              <Hash :size="13" />
              <code class="font-mono text-[12px] text-cool/90 break-all">{{ session.sessionId }}</code>
              <button
                type="button"
                class="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-mist/60 dark:hover:bg-white/5 transition-colors cursor-pointer"
                data-testid="checkout-detail-copy-id"
                @click="copySessionId"
              >
                <Check v-if="copyState === 'copied'" :size="12" class="text-positive" />
                <Copy v-else :size="12" class="text-cool" />
              </button>
            </div>
          </div>
        </div>

        <!-- Fragment-key reminder -->
        <div class="mt-5 rounded-lg bg-gold/8 ring-1 ring-gold/30 px-4 py-3 text-xs text-cool font-sans leading-relaxed">
          The buyer URL is only valid with the fragment key that was shown when this session was minted. We do not store the key. If you've lost the URL, mint a new link.
        </div>
      </div>

      <!-- Metadata grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6">
          <h2 class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold mb-3">
            Session metadata
          </h2>
          <dl class="space-y-2.5 text-sm font-sans">
            <div class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Token</dt>
              <dd class="text-midnight dark:text-white font-mono text-[12px] break-all">
                {{ session.metadata.tokenSymbol }} · {{ formatAddress(session.metadata.tokenAddress) }}
              </dd>
            </div>
            <div class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Issuer</dt>
              <dd class="text-midnight dark:text-white font-mono text-[12px]">
                {{ formatAddress(session.metadata.issuerAddress) }}
              </dd>
            </div>
            <div v-if="session.metadata.issuerLabel" class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Issuer label</dt>
              <dd class="text-midnight dark:text-white">{{ session.metadata.issuerLabel }}</dd>
            </div>
            <div class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Amount</dt>
              <dd class="text-cool/80 italic font-mono text-[12px]">Encrypted at rest</dd>
            </div>
            <div v-if="session.metadata.successUrl" class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Success URL</dt>
              <dd class="text-midnight dark:text-white text-xs break-all">{{ session.metadata.successUrl }}</dd>
            </div>
            <div v-if="session.metadata.cancelUrl" class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Cancel URL</dt>
              <dd class="text-midnight dark:text-white text-xs break-all">{{ session.metadata.cancelUrl }}</dd>
            </div>
          </dl>
        </section>

        <section class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6">
          <h2 class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold mb-3">
            Buyer state
          </h2>
          <dl class="space-y-2.5 text-sm font-sans">
            <div class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Buyer kernel</dt>
              <dd v-if="session.buyerAddress" class="text-midnight dark:text-white font-mono text-[12px]">
                {{ formatAddress(session.buyerAddress) }}
              </dd>
              <dd v-else class="text-cool/60">Not yet linked</dd>
            </div>
            <div class="flex items-baseline gap-3">
              <dt class="text-cool min-w-[120px]">Purchase tx</dt>
              <dd v-if="session.purchaseTxHash">
                <a
                  :href="arbiscanTx(session.purchaseTxHash)"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="checkout-detail-tx"
                  class="inline-flex items-center gap-1 text-compute dark:text-signal hover:underline font-mono text-[12px]"
                >
                  {{ session.purchaseTxHash.slice(0, 10) }}…{{ session.purchaseTxHash.slice(-6) }}
                  <ExternalLink :size="11" />
                </a>
              </dd>
              <dd v-else class="text-cool/60">—</dd>
            </div>
          </dl>
        </section>
      </div>

      <!-- Timestamps -->
      <section class="bg-white dark:bg-midnight-mid rounded-xl ring-1 ring-haze/40 dark:ring-white/8 shadow-lg shadow-compute/5 p-6">
        <h2 class="font-label text-[10px] tracking-[0.14em] uppercase text-cool font-semibold mb-3 inline-flex items-center gap-1.5">
          <Clock :size="13" />
          Timestamps
        </h2>
        <dl class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm font-sans">
          <div>
            <dt class="text-cool text-[11px] uppercase tracking-wider">Created</dt>
            <dd class="text-midnight dark:text-white font-mono text-[12px] mt-1">
              {{ new Date(session.createdAt).toLocaleString() }}
            </dd>
          </div>
          <div>
            <dt class="text-cool text-[11px] uppercase tracking-wider">Last update</dt>
            <dd class="text-midnight dark:text-white font-mono text-[12px] mt-1">
              {{ new Date(session.updatedAt).toLocaleString() }}
            </dd>
          </div>
          <div>
            <dt class="text-cool text-[11px] uppercase tracking-wider">Expires</dt>
            <dd class="text-midnight dark:text-white font-mono text-[12px] mt-1">
              {{ new Date(session.expiresAt).toLocaleString() }}
            </dd>
          </div>
        </dl>
      </section>
    </template>
  </div>
</template>
