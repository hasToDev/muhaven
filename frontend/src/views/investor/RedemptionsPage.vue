<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { RedemptionQueueClient, redemptionQueueAbi, type QueueRequest } from '@muhaven/sdk'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { useMarketplaceStore } from '@/stores/marketplace'
import { v35Addresses } from '@/contracts/addresses'
import { buildReadContext, buildWriteContext, getPublicClient } from '@/services/v35/context'
import { arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import {
  Inbox, Clock, CheckCircle2, Lock, Ban, Loader2, Coins, RefreshCw, ExternalLink,
  ShieldCheck, AlertTriangle,
} from 'lucide-vue-next'

// RedemptionsPage — list the investor's queued redemption requests across all
// tokens with a configured RedemptionQueue address. Claim settled requests
// with a single button. Per-request decrypt of the encrypted proceeds handle
// reveals the PUSDC payout amount (post-processEpoch).

interface EnrichedRequest {
  queueAddress: Address
  tokenAddress: Address
  tokenSymbol: string
  tokenName: string
  requestId: bigint
  state: QueueRequest
  decryptedProceeds: bigint | null
  decryptingProceeds: boolean
}

const { address, connected } = useWallet()
const { decryptUint128ForView } = useFhe()
const marketplace = useMarketplaceStore()

const items = ref<EnrichedRequest[]>([])
const loading = ref(false)
const loaded = ref(false)
const errMsg = ref<string | null>(null)
const claimingIds = ref<Set<string>>(new Set())

async function loadAll() {
  if (!connected.value || !address.value) return
  loading.value = true
  errMsg.value = null
  try {
    if (!marketplace.loaded) await marketplace.load()

    const user = address.value as Address
    const queueEntries = Object.entries(v35Addresses.queues)
    if (queueEntries.length === 0) {
      items.value = []
      loaded.value = true
      return
    }

    const publicClient = getPublicClient()
    const readCtx = buildReadContext()
    const collected: EnrichedRequest[] = []

    for (const [tokenAddrLower, queueAddr] of queueEntries) {
      const tokenMeta = marketplace.getByAddress(tokenAddrLower)
      const tokenSymbol = tokenMeta?.symbol ?? tokenAddrLower.slice(0, 8)
      const tokenName = tokenMeta?.name ?? 'Unknown token'

      // Enumerate investor's requests via QueueSubmitted logs. `investor` is
      // indexed so the filter is cheap. Accept `fromBlock=0` on testnet —
      // production would page via checkpoint.
      const logs = await publicClient.getLogs({
        address: queueAddr,
        event: redemptionQueueAbi.find(
          (x: any) => x.type === 'event' && x.name === 'QueueSubmitted',
        ) as any,
        args: { investor: user },
        fromBlock: 0n,
        toBlock: 'latest',
      })

      const queue = new RedemptionQueueClient(readCtx, queueAddr)
      for (const log of logs) {
        // parseAbiItem on an event with indexed topics makes `args.requestId`
        // a bigint at runtime; the viem getLogs generic erases the event shape,
        // so we narrow through `unknown`.
        const requestId = (log as unknown as { args: { requestId: bigint } }).args.requestId
        const state = await queue.getRequest(requestId)
        collected.push({
          queueAddress: queueAddr,
          tokenAddress: tokenAddrLower as Address,
          tokenSymbol,
          tokenName,
          requestId,
          state,
          decryptedProceeds: null,
          decryptingProceeds: false,
        })
      }
    }
    // Newest first.
    collected.sort((a, b) => (b.requestId > a.requestId ? 1 : -1))
    items.value = collected
    loaded.value = true
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Failed to load redemptions'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (connected.value) loadAll()
})

// ── Status derivation ───────────────────────────────────────────────────

type RequestStatus = 'queued' | 'settled' | 'claimed' | 'cancelled'

function statusOf(r: EnrichedRequest): RequestStatus {
  if (r.state.cancelled) return 'cancelled'
  if (r.state.claimed) return 'claimed'
  if (r.state.settled) return 'settled'
  return 'queued'
}

const pendingCount = computed(() =>
  items.value.filter(r => statusOf(r) === 'queued' || statusOf(r) === 'settled').length,
)

// ── Decrypt proceeds ────────────────────────────────────────────────────

async function decryptProceeds(req: EnrichedRequest) {
  if (req.decryptingProceeds) return
  if (!req.state.settled) return
  req.decryptingProceeds = true
  try {
    // The proceeds handle's ACL is granted to `request.ephemeralEOA` at
    // settlement. That address is recorded on submit, so only the original
    // session's in-memory EOA can decrypt. After logout / tab close, the key
    // is gone and decrypt 403s — see PERMIT_DECRYPT_LIFECYCLE.md §8 Q4
    // (refreshDecryptGrant is deferred). Surface the friendly error.
    const val = await decryptUint128ForView(req.state.encProceeds as unknown as string)
    req.decryptedProceeds = val
  } catch (e) {
    toast.error('Decrypt failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    req.decryptingProceeds = false
  }
}

// ── Claim ───────────────────────────────────────────────────────────────

async function claim(req: EnrichedRequest) {
  const key = `${req.queueAddress}:${req.requestId}`
  if (claimingIds.value.has(key)) return
  if (!req.state.settled || req.state.claimed || req.state.cancelled) return

  claimingIds.value.add(key)
  try {
    const ctx = await buildWriteContext()
    const queue = new RedemptionQueueClient(ctx, req.queueAddress)
    const hash = await queue.claim(req.requestId)
    toast.success('Claim submitted', {
      description: `tx ${hash.slice(0, 10)}…`,
      action: {
        label: 'View',
        onClick: () => window.open(arbiscanTx(hash), '_blank', 'noopener'),
      },
    })
    // Re-read state.
    await loadAll()
  } catch (e) {
    toast.error('Claim failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    claimingIds.value.delete(key)
  }
}

function statusLabel(s: RequestStatus): string {
  switch (s) {
    case 'queued': return 'Queued'
    case 'settled': return 'Ready to claim'
    case 'claimed': return 'Claimed'
    case 'cancelled': return 'Cancelled'
  }
}

function statusTone(s: RequestStatus) {
  switch (s) {
    case 'queued': return { text: 'text-gold', ring: 'border-gold/30', bg: 'bg-gold/10' }
    case 'settled': return { text: 'text-positive', ring: 'border-positive/30', bg: 'bg-positive/10' }
    case 'claimed': return { text: 'text-cool', ring: 'border-haze dark:border-white/10', bg: 'bg-haze/30 dark:bg-white/5' }
    case 'cancelled': return { text: 'text-negative', ring: 'border-negative/30', bg: 'bg-negative/10' }
  }
}
</script>

<template>
  <div>
    <header class="mb-8 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="font-accent italic text-3xl md:text-4xl text-midnight dark:text-white tracking-tight">
          Redemptions
        </h1>
        <p class="font-sans text-sm text-cool mt-2 max-w-xl leading-relaxed">
          Queued redemptions awaiting settlement. Once the issuer runs
          <span class="font-mono text-[11px]">processEpoch</span>, you can decrypt the payout and
          claim your PUSDC.
        </p>
      </div>
      <button
        type="button"
        @click="loadAll"
        :disabled="loading"
        data-testid="redemptions-refresh"
        class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw :size="12" :class="loading && 'animate-spin'" />
        Refresh
      </button>
    </header>

    <MPageLoader
      v-if="!loaded && loading"
      label="Loading redemptions"
      caption="Reading queue state from chain"
    />

    <div v-else-if="errMsg" class="flex flex-col items-center justify-center py-20 gap-4">
      <AlertTriangle :size="36" :stroke-width="1.4" class="text-negative/60" />
      <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
      <MButton variant="outline" @click="loadAll">Retry</MButton>
    </div>

    <div v-else-if="items.length === 0" class="flex flex-col items-center py-16 gap-3">
      <Inbox :size="40" :stroke-width="1.4" class="text-cool/35" />
      <p class="font-sans text-sm text-cool">No queued redemptions</p>
      <p class="font-sans text-xs text-cool/70 max-w-md text-center">
        When a queued redemption is submitted (directly or via escalation from an instant redeem), it
        appears here. The claim button enables after the issuer processes the epoch.
      </p>
    </div>

    <div v-else>
      <!-- Stats strip -->
      <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div class="rounded-xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] flex flex-col gap-1">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Total Requests</span>
          <span class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums">{{ items.length }}</span>
        </div>
        <div class="rounded-xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] flex flex-col gap-1">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Pending</span>
          <span class="font-accent italic text-2xl text-gold tabular-nums">{{ pendingCount }}</span>
        </div>
        <div class="rounded-xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717] flex flex-col gap-1">
          <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">Claimed</span>
          <span class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums">
            {{ items.filter(r => statusOf(r) === 'claimed').length }}
          </span>
        </div>
      </div>

      <!-- List -->
      <div class="flex flex-col gap-3">
        <div
          v-for="r in items"
          :key="`${r.queueAddress}:${r.requestId}`"
          :data-request-id="String(r.requestId)"
          data-testid="redemption-row"
          class="rounded-xl p-5 border border-haze dark:border-white/5 bg-white dark:bg-[#171717]
                 hover:border-gold/30 dark:hover:border-signal/25 transition-colors"
        >
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex items-center gap-4 min-w-0 flex-1">
              <div
                :class="[
                  'w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0',
                  statusOf(r) === 'settled' ? 'bg-positive/15 text-positive'
                    : statusOf(r) === 'claimed' ? 'bg-compute/15 dark:bg-signal/15 text-compute dark:text-signal'
                      : statusOf(r) === 'cancelled' ? 'bg-negative/15 text-negative'
                        : 'bg-gold/15 dark:bg-signal/15 text-gold dark:text-signal',
                ]"
              >
                <CheckCircle2 v-if="statusOf(r) === 'settled'" :size="18" :stroke-width="1.8" />
                <Coins v-else-if="statusOf(r) === 'claimed'" :size="18" :stroke-width="1.8" />
                <Ban v-else-if="statusOf(r) === 'cancelled'" :size="18" :stroke-width="1.8" />
                <Clock v-else :size="18" :stroke-width="1.8" />
              </div>
              <div class="min-w-0">
                <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                  Request #{{ r.requestId }} · {{ r.tokenSymbol }}
                </p>
                <p class="font-sans text-[11px] text-cool mt-0.5">
                  {{ r.tokenName }} · epoch {{ r.state.epochId }}
                </p>
                <div class="flex items-center gap-2 mt-2 flex-wrap">
                  <span
                    :class="[
                      'inline-flex items-center font-sans text-[9px] uppercase tracking-[0.22em] font-semibold px-2 py-0.5 rounded border',
                      statusTone(statusOf(r)).text,
                      statusTone(statusOf(r)).ring,
                    ]"
                  >
                    {{ statusLabel(statusOf(r)) }}
                  </span>
                  <span class="font-mono text-[10px] text-cool">
                    hint ≤ {{ Number(r.state.maxSharesHint).toLocaleString() }} shares
                  </span>
                </div>
              </div>
            </div>

            <!-- Right column: proceeds + claim -->
            <div class="flex flex-col items-end gap-2">
              <div class="min-h-[28px] text-right">
                <p
                  v-if="r.decryptedProceeds !== null"
                  class="font-accent italic text-xl text-midnight dark:text-white tabular-nums leading-tight"
                >
                  {{ formatUSD(Number(r.decryptedProceeds) / 1e6) }}
                </p>
                <button
                  v-else-if="r.state.settled"
                  type="button"
                  @click="decryptProceeds(r)"
                  :disabled="r.decryptingProceeds"
                  data-testid="redemption-decrypt-proceeds"
                  class="font-sans text-[10px] uppercase tracking-[0.22em] font-medium
                         text-compute dark:text-signal hover:text-compute/80 dark:hover:text-signal/80
                         transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Loader2 v-if="r.decryptingProceeds" :size="11" class="animate-spin" />
                  <ShieldCheck v-else :size="11" />
                  Decrypt payout
                </button>
                <p v-else class="font-sans text-[11px] text-cool flex items-center gap-1.5">
                  <Lock :size="11" :stroke-width="1.8" />
                  <span class="italic">Pending settlement</span>
                </p>
              </div>

              <button
                v-if="statusOf(r) === 'settled'"
                type="button"
                @click="claim(r)"
                :disabled="claimingIds.has(`${r.queueAddress}:${r.requestId}`)"
                data-testid="redemption-claim-cta"
                class="btn-gold-sweep px-5 py-2 rounded-lg font-sans font-semibold text-[10px] tracking-[0.18em] uppercase
                       flex items-center gap-2 cursor-pointer transition-all duration-300 hover:-translate-y-0.5"
              >
                <Loader2
                  v-if="claimingIds.has(`${r.queueAddress}:${r.requestId}`)"
                  :size="12"
                  class="animate-spin"
                />
                <Coins v-else :size="12" :stroke-width="2" />
                Claim
              </button>
              <a
                v-if="r.state.settled"
                :href="`https://sepolia.arbiscan.io/address/${r.queueAddress}`"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 font-mono text-[9px] text-cool hover:text-compute dark:hover:text-signal transition-colors"
              >
                queue
                <ExternalLink :size="9" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
