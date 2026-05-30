<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { Scale, Pencil, RotateCcw, Check } from 'lucide-vue-next'
import MButton from '@/components/ui/MButton.vue'
import ConfirmModal from '@/components/agent/ConfirmModal.vue'
import { runAgentAction } from '@/composables/useAgentActionRunner'
import { useRebalanceLauncher } from '@/composables/useRebalanceLauncher'
import {
  useRebalanceTargetsStore,
  validateRebalanceTargets,
  DEFAULT_TOLERANCE_BPS,
  MIN_TOLERANCE_BPS,
  MAX_TOLERANCE_BPS,
} from '@/stores/rebalanceTargets'
import { useMarketplaceStore } from '@/stores/marketplace'
import { usePortfolioStore } from '@/stores/portfolio'
import type { ActionDescriptor } from '@/services/api'

/**
 * Wave 5 Slice 3 — in-app rebalance panel. Two things in one card:
 *   1. A target-allocation editor (per-token % inputs summing to 100% +
 *      a drift tolerance) persisted to localStorage (per wallet).
 *   2. A "Rebalance toward targets" CTA that computes the drift legs under
 *      the user's decrypt permit, mints a hash-bound confirm token, and opens
 *      the SAME ConfirmModal the HavenBot chat path uses → ONE silent atomic
 *      UserOp (sells before buys).
 *
 * Targets are CLEARTEXT (a % allocation isn't secret); only balances are
 * encrypted, and those are read client-side at preview time, never here.
 */

const props = defineProps<{ walletAddress: string | null }>()

const targetsStore = useRebalanceTargetsStore()
const marketplace = useMarketplaceStore()
const portfolio = usePortfolioStore()
const launcher = useRebalanceLauncher()

const editing = ref(false)
const saveError = ref<string | null>(null)
// Local editor state — percent (0..100 integer) keyed by lowercased address.
const pct = ref<Record<string, number>>({})
const tolerancePct = ref<number>(DEFAULT_TOLERANCE_BPS / 100)

// Own ConfirmModal instance for the CTA (the AgentPage modal isn't reachable
// from the Portfolio route).
const confirmModalRef = ref<InstanceType<typeof ConfirmModal> | null>(null)
const activeAction = ref<ActionDescriptor | null>(null)
// Editor container — focused on open so AT announces the region (FD M4).
const editorRef = ref<HTMLElement | null>(null)

const activeTokens = computed(() =>
  marketplace.tokens.filter((t) => t.status === 'active'),
)

/**
 * Rows shown in the editor (FD H1). The UNION of the active marketplace tokens
 * AND any address that already has a stored target — so a token that was
 * targeted then later paused/delisted stays VISIBLE + zeroable instead of
 * silently vanishing from the editor (which would strand the sum below 100%
 * with no way to fix it). Keyed + sorted by current percent desc.
 */
const editorRows = computed<{ address: `0x${string}`; symbol: string }[]>(() => {
  const byAddr = new Map<string, { address: `0x${string}`; symbol: string }>()
  for (const t of activeTokens.value) {
    byAddr.set(t.address.toLowerCase(), {
      address: t.address as `0x${string}`,
      symbol: t.symbol,
    })
  }
  for (const addr of Object.keys(pct.value)) {
    const lower = addr.toLowerCase()
    if (byAddr.has(lower)) continue
    const meta = marketplace.getByAddress(lower)
    byAddr.set(lower, {
      address: lower as `0x${string}`,
      symbol: meta?.symbol ?? `${lower.slice(0, 6)}…${lower.slice(-4)}`,
    })
  }
  return Array.from(byAddr.values()).sort(
    (a, b) => (pct.value[b.address.toLowerCase()] ?? 0) - (pct.value[a.address.toLowerCase()] ?? 0),
  )
})

const isConfigured = computed(() => targetsStore.isConfigured)

/** Stored targets as display chips: [{ address, symbol, pct }]. */
const targetChips = computed(() => {
  const out: { address: string; symbol: string; pct: number }[] = []
  for (const [addr, bps] of Object.entries(targetsStore.targets)) {
    const meta = marketplace.getByAddress(addr)
    out.push({
      address: addr,
      symbol: meta?.symbol ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`,
      pct: bps / 100,
    })
  }
  return out.sort((a, b) => b.pct - a.pct)
})

const sumPct = computed(() =>
  Object.values(pct.value).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0),
)
const sumValid = computed(() => Math.round(sumPct.value) === 100)
const toleranceValid = computed(() => {
  const bps = Math.round(tolerancePct.value * 100)
  return bps >= MIN_TOLERANCE_BPS && bps <= MAX_TOLERANCE_BPS
})

function hydrateEditor(): void {
  const next: Record<string, number> = {}
  for (const [addr, bps] of Object.entries(targetsStore.targets)) {
    next[addr.toLowerCase()] = Math.round(bps / 100)
  }
  pct.value = next
  tolerancePct.value = targetsStore.toleranceBps / 100
}

onMounted(async () => {
  if (props.walletAddress) targetsStore.load(props.walletAddress)
  // Hydrate the chips/summary from the (sync) targets store FIRST so they
  // paint immediately without waiting on the marketplace network round-trip
  // (FD M2). The editor's symbol labels fill in once the marketplace resolves.
  hydrateEditor()
  await ensureMarketplace()
})

/** Idempotent marketplace load with retry-on-failure (FD M1). */
async function ensureMarketplace(): Promise<void> {
  if (marketplace.loaded) return
  try {
    await marketplace.load()
  } catch {
    /* the editor still renders stored-target rows; "Set targets" stays usable */
  }
}

// Re-load targets when the wallet changes (login / account switch).
watch(
  () => props.walletAddress,
  (addr) => {
    if (addr) {
      targetsStore.load(addr)
      hydrateEditor()
    }
  },
)

async function startEdit(): Promise<void> {
  hydrateEditor()
  saveError.value = null
  editing.value = true
  // Retry the catalog if a prior load failed so the editor isn't empty (M1).
  void ensureMarketplace()
  // Move focus into the editor region so AT announces it (FD M4).
  await nextTick()
  editorRef.value?.focus()
}

function cancelEdit(): void {
  editing.value = false
  saveError.value = null
  hydrateEditor()
}

function onPctInput(addr: string, value: string): void {
  const n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
  pct.value = { ...pct.value, [addr.toLowerCase()]: n }
}

function save(): void {
  if (!props.walletAddress) {
    saveError.value = 'Connect your wallet first.'
    return
  }
  // Build bps targets from non-zero percents only.
  const targets: Record<string, number> = {}
  for (const [addr, p] of Object.entries(pct.value)) {
    if (p > 0) targets[addr.toLowerCase()] = Math.round(p) * 100
  }
  const toleranceBps = Math.round(tolerancePct.value * 100)
  const reason = validateRebalanceTargets(targets, toleranceBps)
  if (reason) {
    saveError.value = reason
    return
  }
  try {
    targetsStore.save(props.walletAddress, targets, toleranceBps)
    saveError.value = null
    editing.value = false
    toast.success('Targets saved', {
      description: 'Ask HavenBot to rebalance, or tap "Rebalance toward targets".',
    })
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Could not save targets.'
  }
}

function resetTargets(): void {
  if (!props.walletAddress) return
  targetsStore.clear(props.walletAddress)
  hydrateEditor()
  toast.info('Targets cleared')
}

async function onRebalanceClick(): Promise<void> {
  const addr = props.walletAddress as `0x${string}` | null
  await launcher.launch(addr, (descriptor) => {
    activeAction.value = descriptor
  })
}

// ── ConfirmModal glue (mirrors AgentPage.onAuthorize / onConfirmComplete) ──
async function onConfirm(action: ActionDescriptor): Promise<void> {
  confirmModalRef.value?.setSubmitting()
  const result = await runAgentAction(action)
  await confirmModalRef.value?.reportResult(result)
  // Mirror AgentPage.onAuthorize toast parity (FD H2). rebalance always
  // returns ok:true today, but handle the other arms so a future change
  // doesn't leave the CTA path silent.
  if (result.ok === true) {
    toast.success('Rebalanced', {
      description: 'Your portfolio settled in one confidential transaction.',
    })
  } else if (result.ok === 'deferred') {
    toast.info('Continue on the next page', { description: result.reason })
  }
  // ok:false keeps the modal open with its in-place error surface.
}

function onCancel(): void {
  activeAction.value = null
}

function onComplete(payload: { action: ActionDescriptor; ok: boolean }): void {
  if (payload.ok && props.walletAddress) {
    const addr = props.walletAddress as `0x${string}`
    void portfolio.refreshAfterTrade(addr).catch((e) => {
      console.warn('[RebalancePanel] post-rebalance refresh failed', e)
    })
  }
  // Close on success; keep open on error so the actionable message stays.
  if (payload.ok) activeAction.value = null
}
</script>

<template>
  <section
    class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-5 md:p-6"
    data-testid="rebalance-panel"
  >
    <div class="flex items-start justify-between gap-3 mb-4">
      <div class="flex items-center gap-2.5">
        <div
          class="w-9 h-9 rounded-xl bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25
                 flex items-center justify-center flex-shrink-0"
        >
          <Scale :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
        </div>
        <div>
          <h3 class="font-sans font-semibold text-base text-midnight dark:text-white">
            Auto-rebalance
          </h3>
          <p class="font-sans text-xs text-cool">
            Drift back toward your target mix in one confidential transaction.
          </p>
        </div>
      </div>
      <button
        v-if="isConfigured && !editing"
        type="button"
        @click="startEdit"
        data-testid="rebalance-edit-targets"
        class="inline-flex items-center gap-1 font-sans text-xs font-semibold text-compute dark:text-signal
               hover:underline cursor-pointer flex-shrink-0"
      >
        <Pencil :size="12" :stroke-width="2" />
        Edit targets
      </button>
    </div>

    <!-- Configured + not editing: summary chips + CTA -->
    <template v-if="isConfigured && !editing">
      <div class="flex flex-wrap gap-2 mb-4" data-testid="rebalance-target-chips">
        <span
          v-for="chip in targetChips"
          :key="chip.address"
          class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1
                 bg-mist/60 dark:bg-[#0d0e10] border border-haze dark:border-white/10
                 font-mono text-xs text-midnight dark:text-white"
        >
          {{ chip.symbol }}
          <span class="text-cool">{{ chip.pct }}%</span>
        </span>
        <span class="inline-flex items-center font-sans text-xs text-cool">
          · tolerance {{ targetsStore.toleranceBps / 100 }}%
        </span>
      </div>
      <MButton
        variant="primary"
        size="md"
        :loading="launcher.computing.value"
        :disabled="launcher.computing.value || !walletAddress"
        @click="onRebalanceClick"
        data-testid="rebalance-cta"
        class="w-full sm:w-auto"
      >
        Rebalance toward targets
      </MButton>
    </template>

    <!-- Not configured + not editing: prompt -->
    <template v-else-if="!editing">
      <p class="font-sans text-sm text-cool mb-4">
        Set a target allocation for your tokens (totalling 100%). HavenBot will then
        compute the exact buy/sell legs from your encrypted balances whenever you ask
        it to rebalance.
      </p>
      <MButton variant="secondary" size="md" @click="startEdit" data-testid="rebalance-set-targets">
        Set target allocations
      </MButton>
    </template>

    <!-- Editor -->
    <template v-else>
      <div
        ref="editorRef"
        tabindex="-1"
        role="group"
        aria-label="Edit target allocations"
        class="space-y-2 mb-4 focus:outline-none"
        data-testid="rebalance-editor"
      >
        <p
          v-if="editorRows.length === 0"
          class="font-sans text-xs text-cool"
          data-testid="rebalance-editor-empty"
        >
          No tokens available yet — the catalog is still loading. Try again in a moment.
        </p>
        <div
          v-for="t in editorRows"
          :key="t.address"
          class="flex items-center justify-between gap-3 rounded-lg px-3 py-2
                 bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/10"
        >
          <span class="font-mono text-sm text-midnight dark:text-white truncate min-w-0">
            {{ t.symbol }}
          </span>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="100"
              step="1"
              :value="pct[t.address.toLowerCase()] ?? 0"
              @input="onPctInput(t.address, ($event.target as HTMLInputElement).value)"
              :aria-label="`Target percent for ${t.symbol}`"
              class="w-16 text-right rounded-md px-2 py-1 font-mono text-sm
                     bg-white dark:bg-[#1f1e1e] border border-haze dark:border-white/15
                     text-midnight dark:text-white focus:outline-none focus:border-gold dark:focus:border-signal"
            />
            <span class="font-sans text-xs text-cool">%</span>
          </div>
        </div>
      </div>

      <!-- Live sum + tolerance -->
      <div class="flex items-center justify-between gap-3 mb-3">
        <span
          role="status"
          aria-live="polite"
          class="font-sans text-xs font-semibold"
          :class="sumValid ? 'text-positive' : 'text-cool'"
          data-testid="rebalance-sum"
        >
          Total: {{ Math.round(sumPct) }}% {{ sumValid ? '✓' : '(must equal 100%)' }}
        </span>
        <label class="flex items-center gap-1.5 font-sans text-xs text-cool">
          Tolerance
          <input
            type="number"
            inputmode="decimal"
            :min="MIN_TOLERANCE_BPS / 100"
            :max="MAX_TOLERANCE_BPS / 100"
            step="0.5"
            v-model.number="tolerancePct"
            aria-label="Drift tolerance percent"
            class="w-16 text-right rounded-md px-2 py-1 font-mono text-sm
                   bg-white dark:bg-[#1f1e1e] border border-haze dark:border-white/15
                   text-midnight dark:text-white focus:outline-none focus:border-gold dark:focus:border-signal"
          />
          %
        </label>
      </div>

      <p
        v-if="!toleranceValid"
        role="status"
        class="font-sans text-xs text-cool mb-3"
        data-testid="rebalance-tolerance-hint"
      >
        Tolerance must be between {{ MIN_TOLERANCE_BPS / 100 }}% and {{ MAX_TOLERANCE_BPS / 100 }}%.
      </p>

      <p
        v-if="saveError"
        role="alert"
        class="font-sans text-xs text-negative mb-3"
        data-testid="rebalance-save-error"
      >
        {{ saveError }}
      </p>

      <div class="flex items-center gap-2">
        <MButton
          variant="primary"
          size="sm"
          :disabled="!sumValid || !toleranceValid"
          @click="save"
          data-testid="rebalance-save"
        >
          <Check :size="14" :stroke-width="2" class="mr-1" />
          Save targets
        </MButton>
        <MButton variant="ghost" size="sm" @click="cancelEdit">Cancel</MButton>
        <button
          v-if="isConfigured"
          type="button"
          @click="resetTargets"
          class="ml-auto inline-flex items-center gap-1 font-sans text-xs text-cool hover:text-negative cursor-pointer"
        >
          <RotateCcw :size="12" :stroke-width="2" />
          Clear
        </button>
      </div>
    </template>

    <!-- CTA ConfirmModal (own instance for the Portfolio route) -->
    <ConfirmModal
      ref="confirmModalRef"
      :action="activeAction"
      @confirm="onConfirm"
      @cancel="onCancel"
      @complete="onComplete"
    />
  </section>
</template>
