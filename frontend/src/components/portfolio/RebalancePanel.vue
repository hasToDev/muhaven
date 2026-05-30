<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { Scale, Pencil, RotateCcw, Check, Search, Plus, ShieldCheck, Eye } from 'lucide-vue-next'
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
 * Wave 5 Slice 3 — in-app rebalance panel (iteration 2).
 *
 * Collapses to a slim STATUS STRIP by default (so it doesn't crowd the
 * Holdings section — it's mounted BELOW Holdings). The strip carries an
 * RWA-ONLY "current vs target" verification readout computed from the
 * already-revealed `holdings[].decryptedBalance × nav` (NO extra passkey /
 * decrypt) so the user can see whether the mix converged — the portfolio
 * donut can't, because it includes USDC + mhUSDC cash. After a rebalance the
 * readout refreshes (onComplete re-decrypts) and the state flips to Balanced.
 *
 * The targets editor expands inline (search + frozen-order list of held +
 * targeted tokens) and executes via the shared launcher → ConfirmModal.
 */

const props = defineProps<{ walletAddress: string | null }>()

const targetsStore = useRebalanceTargetsStore()
const marketplace = useMarketplaceStore()
const portfolio = usePortfolioStore()
const launcher = useRebalanceLauncher()

const editing = ref(false)
const saveError = ref<string | null>(null)
const justRan = ref(false)
// Editor state — percent (0..100 integer) keyed by lowercased address.
const pct = ref<Record<string, number>>({})
const tolerancePct = ref<number>(DEFAULT_TOLERANCE_BPS / 100)
// Frozen render order (lowercased addresses), snapshotted on edit-open so rows
// never jump while the user types (#5). Added tokens append.
const editorOrder = ref<string[]>([])
const searchQuery = ref('')

const confirmModalRef = ref<InstanceType<typeof ConfirmModal> | null>(null)
const activeAction = ref<ActionDescriptor | null>(null)
const editorRef = ref<HTMLElement | null>(null)

const isConfigured = computed(() => targetsStore.isConfigured)
const tolerancePctVal = computed(() => targetsStore.toleranceBps / 100)

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
function holdingFor(addr: string) {
  const lower = addr.toLowerCase()
  return portfolio.holdings.find((h) => h.tokenAddress.toLowerCase() === lower)
}
function symbolFor(addr: string): string {
  return holdingFor(addr)?.symbol ?? marketplace.getByAddress(addr)?.symbol ?? shortAddr(addr)
}

// ── RWA-only verification readout (#2 + #3) ──────────────────────────
// Reuses already-revealed balances; never triggers a decrypt itself.
const targetEntries = computed(
  () => Object.entries(targetsStore.targets) as [string, number][],
)

/** A targeted token that IS held but still locked → the readout would lie. */
const anyTargetedLocked = computed(() =>
  targetEntries.value.some(([addr]) => {
    const h = holdingFor(addr)
    return h != null && h.decryptedBalance === null
  }),
)

/** A held targeted token is "readable" for the RWA-only weight math only when
 *  BOTH its balance is decrypted AND its NAV is known. A null NAV is EXCLUDED
 *  (not valued at par) to mirror the launcher, which drops null-NAV tokens from
 *  the plan + renormalises — so the readout never disagrees with the plan (CR L-2). */
function readableValue(addr: string): number | null {
  const h = holdingFor(addr)
  if (!h) return 0 // not held → 0% (a pure buy target)
  if (h.decryptedBalance === null || h.nav === null) return null // locked / no NAV
  return Number(h.decryptedBalance) * h.nav
}

const rwaTotal = computed(() => {
  let t = 0
  for (const [addr] of targetEntries.value) {
    const v = readableValue(addr)
    if (v !== null) t += v
  }
  return t
})

interface DriftRow {
  address: string
  symbol: string
  currentPct: number
  targetPct: number
  driftPct: number
  withinTolerance: boolean
}
const driftRows = computed<DriftRow[]>(() => {
  const total = rwaTotal.value
  const tol = tolerancePctVal.value
  const out: DriftRow[] = []
  for (const [addr, bps] of targetEntries.value) {
    const value = readableValue(addr)
    // Held-with-null-NAV → excluded from the readout (mirrors the launcher's
    // plan exclusion). Held-but-locked is caught by `anyTargetedLocked` (the
    // readout shows the reveal nudge instead of rows). Unheld → value 0.
    if (value === null) continue
    const currentPct = total > 0 ? (value / total) * 100 : 0
    const targetPct = bps / 100
    const driftPct = currentPct - targetPct
    out.push({
      address: addr,
      symbol: symbolFor(addr),
      currentPct,
      targetPct,
      driftPct,
      withinTolerance: Math.abs(driftPct) <= tol,
    })
  }
  return out.sort((a, b) => b.targetPct - a.targetPct)
})

const maxAbsDriftPct = computed(() =>
  driftRows.value.reduce((m, r) => Math.max(m, Math.abs(r.driftPct)), 0),
)

type RebalanceState = 'unconfigured' | 'locked' | 'balanced' | 'drifted'
const rebalanceState = computed<RebalanceState>(() => {
  if (!isConfigured.value) return 'unconfigured'
  if (anyTargetedLocked.value) return 'locked'
  // Strict `<` mirrors the launcher's `maxDriftBps < toleranceBps` so the strip
  // doesn't claim "Balanced" at the exact boundary where a rebalance would still
  // produce legs (CR N-2).
  return maxAbsDriftPct.value < tolerancePctVal.value ? 'balanced' : 'drifted'
})

function fmtPct(p: number): string {
  return `${p.toFixed(p < 10 ? 1 : 0)}%`
}
function fmtSigned(p: number): string {
  const v = Math.abs(p) < 0.05 ? 0 : p
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

// ── Editor rows (held + targeted, frozen order) + search/add (#6) ────
const editorRows = computed(() =>
  editorOrder.value.map((addr) => ({ address: addr, symbol: symbolFor(addr) })),
)
const searchResults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  const inOrder = new Set(editorOrder.value.map((a) => a.toLowerCase()))
  return marketplace.tokens
    .filter((t) => t.status === 'active' && !inOrder.has(t.address.toLowerCase()))
    .filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    .slice(0, 6)
})

function currentPctFor(addr: string): number {
  return driftRows.value.find((r) => r.address.toLowerCase() === addr.toLowerCase())?.currentPct ?? 0
}

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

/** Default editor list: HELD + TARGETED only (not the whole catalog), ordered
 *  by current value desc, snapshotted so it never re-sorts on input (#5/#6). */
function buildDefaultOrder(): string[] {
  const byAddr = new Map<string, number>()
  for (const h of portfolio.holdings) {
    const v = h.decryptedBalance !== null ? Number(h.decryptedBalance) * (h.nav ?? 1) : 0
    byAddr.set(h.tokenAddress.toLowerCase(), v)
  }
  for (const addr of Object.keys(targetsStore.targets)) {
    if (!byAddr.has(addr.toLowerCase())) byAddr.set(addr.toLowerCase(), 0)
  }
  return Array.from(byAddr.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([a]) => a)
}

onMounted(async () => {
  if (props.walletAddress) targetsStore.load(props.walletAddress)
  await ensureMarketplace()
})

async function ensureMarketplace(): Promise<void> {
  if (marketplace.loaded) return
  try {
    await marketplace.load()
  } catch {
    /* the editor still renders held/targeted rows; search just returns nothing */
  }
}

watch(
  () => props.walletAddress,
  (addr) => {
    if (addr) targetsStore.load(addr)
  },
)

async function startEdit(): Promise<void> {
  hydrateEditor()
  editorOrder.value = buildDefaultOrder()
  searchQuery.value = ''
  saveError.value = null
  justRan.value = false
  editing.value = true
  void ensureMarketplace()
  await nextTick()
  editorRef.value?.focus()
}

function cancelEdit(): void {
  editing.value = false
  saveError.value = null
}

function onPctInput(addr: string, value: string): void {
  const n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
  pct.value = { ...pct.value, [addr.toLowerCase()]: n }
}

function addToken(addr: string): void {
  const lower = addr.toLowerCase()
  if (!editorOrder.value.includes(lower)) {
    editorOrder.value = [...editorOrder.value, lower]
    pct.value = { ...pct.value, [lower]: pct.value[lower] ?? 0 }
  }
  searchQuery.value = ''
}

function save(): void {
  if (!props.walletAddress) {
    saveError.value = 'Connect your wallet first.'
    return
  }
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
      description: 'Ask HavenBot to rebalance, or tap "Rebalance".',
    })
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : 'Could not save targets.'
  }
}

function resetTargets(): void {
  if (!props.walletAddress) return
  targetsStore.clear(props.walletAddress)
  hydrateEditor()
  editorOrder.value = buildDefaultOrder()
  toast.info('Targets cleared')
}

/** Reveal the targeted holdings so the verification readout can compute (the
 *  user opted in — same as the Holdings "Reveal" buttons). Sequential to avoid
 *  nonce collisions, mirroring portfolio.refreshAfterTrade. */
async function revealTargeted(): Promise<void> {
  const addr = props.walletAddress as `0x${string}` | null
  if (!addr) return
  for (const [taddr] of targetEntries.value) {
    const idx = portfolio.holdings.findIndex(
      (h) => h.tokenAddress.toLowerCase() === taddr.toLowerCase(),
    )
    if (idx >= 0 && portfolio.holdings[idx].decryptedBalance === null) {
      try {
        await portfolio.decryptHolding(idx, addr)
      } catch (e) {
        console.warn('[RebalancePanel] reveal-for-verify failed', e)
      }
    }
  }
}

async function onRebalanceClick(): Promise<void> {
  justRan.value = false
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
  if (result.ok === true) {
    toast.success('Rebalanced', {
      description: 'Your portfolio settled in one confidential transaction.',
    })
  } else if (result.ok === 'deferred') {
    toast.info('Continue on the next page', { description: result.reason })
  }
}

function onCancel(): void {
  activeAction.value = null
}

function onComplete(payload: { action: ActionDescriptor; ok: boolean }): void {
  if (payload.ok && props.walletAddress) {
    const addr = props.walletAddress as `0x${string}`
    justRan.value = true
    // refreshAfterTrade re-decrypts the revealed holdings → driftRows recompute
    // → the readout shows the new (converged) mix + the state flips to Balanced.
    void portfolio.refreshAfterTrade(addr).catch((e) => {
      console.warn('[RebalancePanel] post-rebalance refresh failed', e)
    })
  }
  if (payload.ok) activeAction.value = null
}
</script>

<template>
  <section
    class="rounded-2xl border border-haze dark:border-white/5 bg-white dark:bg-[#171717] p-4 md:p-5"
    data-testid="rebalance-panel"
  >
    <!-- Header -->
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5 min-w-0">
        <div
          class="w-8 h-8 rounded-lg bg-gold/10 dark:bg-signal/10 border border-gold/25 dark:border-signal/25
                 flex items-center justify-center flex-shrink-0"
        >
          <Scale :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
        </div>
        <div class="min-w-0">
          <h3 class="font-sans font-semibold text-sm text-midnight dark:text-white leading-tight">
            Auto-rebalance
          </h3>
          <!-- State sub-line -->
          <p
            role="status"
            aria-live="polite"
            data-testid="rebalance-state"
            :data-state="rebalanceState"
            class="font-sans text-xs leading-tight mt-0.5 truncate"
            :class="{
              'text-positive': rebalanceState === 'balanced',
              'text-gold dark:text-signal': rebalanceState === 'drifted',
              'text-cool': rebalanceState === 'locked' || rebalanceState === 'unconfigured',
            }"
          >
            <template v-if="rebalanceState === 'balanced'">Balanced ✓ within {{ tolerancePctVal }}%</template>
            <template v-else-if="rebalanceState === 'drifted'">Drifted · max {{ fmtPct(maxAbsDriftPct) }} off target</template>
            <template v-else-if="rebalanceState === 'locked'">Reveal your holdings to verify the mix</template>
            <template v-else>Set a target mix to enable rebalancing</template>
          </p>
        </div>
      </div>

      <!-- Actions (hidden while editing) -->
      <div v-if="!editing" class="flex items-center gap-2 flex-shrink-0">
        <button
          v-if="isConfigured"
          type="button"
          @click="startEdit"
          data-testid="rebalance-edit-targets"
          class="inline-flex items-center gap-1 font-sans text-xs font-semibold text-compute dark:text-signal
                 hover:underline cursor-pointer"
        >
          <Pencil :size="12" :stroke-width="2" />
          Edit
        </button>
        <MButton
          v-if="isConfigured"
          :variant="rebalanceState === 'drifted' ? 'primary' : 'secondary'"
          size="sm"
          :loading="launcher.computing.value"
          :disabled="launcher.computing.value || !walletAddress"
          @click="onRebalanceClick"
          data-testid="rebalance-cta"
        >
          Rebalance
        </MButton>
      </div>
    </div>

    <!-- ░░ Not configured: prompt ░░ -->
    <div v-if="rebalanceState === 'unconfigured' && !editing" class="mt-3">
      <p class="font-sans text-xs text-cool mb-3">
        Set a target allocation for your tokens (totalling 100%). HavenBot computes the
        exact buy/sell legs from your encrypted balances whenever you rebalance.
      </p>
      <MButton variant="secondary" size="sm" @click="startEdit" data-testid="rebalance-set-targets">
        Set target allocations
      </MButton>
    </div>

    <!-- ░░ Configured + not editing: verification readout ░░ -->
    <div v-else-if="!editing" class="mt-3">
      <!-- Just-ran banner -->
      <div
        v-if="justRan"
        data-testid="rebalance-just-ran"
        class="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-positive/10 border border-positive/25"
      >
        <ShieldCheck :size="14" :stroke-width="1.8" class="text-positive flex-shrink-0" />
        <p class="font-sans text-xs text-positive">Settled — your mix is updating to reflect the new balance.</p>
      </div>

      <!-- Locked: reveal nudge -->
      <div
        v-if="rebalanceState === 'locked'"
        class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg
               bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/10"
      >
        <span class="font-sans text-xs text-cool">Reveal your holdings to see current vs target.</span>
        <button
          type="button"
          @click="revealTargeted"
          data-testid="rebalance-reveal"
          class="inline-flex items-center gap-1 font-sans text-xs font-semibold text-compute dark:text-signal hover:underline cursor-pointer flex-shrink-0"
        >
          <Eye :size="12" :stroke-width="2" />
          Reveal
        </button>
      </div>

      <!-- Drift rows -->
      <div v-else class="space-y-2" data-testid="rebalance-drift">
        <div
          v-for="row in driftRows"
          :key="row.address"
          :data-testid="`rebalance-drift-row-${row.symbol}`"
          class="flex items-center gap-3"
        >
          <span class="font-mono text-xs text-midnight dark:text-white w-16 flex-shrink-0 truncate">
            {{ row.symbol }}
          </span>
          <!-- mini bar: fill = current%, tick = target% -->
          <div class="relative flex-1 h-1.5 rounded-full bg-mist dark:bg-white/10">
            <div
              class="absolute inset-y-0 left-0 rounded-full"
              :class="row.withinTolerance ? 'bg-positive/70' : 'bg-gold dark:bg-signal'"
              :style="{ width: Math.min(100, Math.max(0, row.currentPct)) + '%' }"
            />
            <div
              class="absolute top-[-2px] bottom-[-2px] w-0.5 bg-cool/80 rounded"
              :style="{ left: Math.min(100, Math.max(0, row.targetPct)) + '%' }"
              aria-hidden="true"
            />
          </div>
          <span class="font-mono text-[11px] text-cool w-24 text-right flex-shrink-0 tabular-nums">
            {{ fmtPct(row.currentPct) }} → {{ fmtPct(row.targetPct) }}
          </span>
          <span
            class="font-mono text-[11px] w-10 text-right flex-shrink-0 tabular-nums inline-flex items-center justify-end gap-0.5"
            :class="row.withinTolerance ? 'text-positive' : 'text-gold dark:text-signal'"
          >
            <Check v-if="row.withinTolerance" :size="11" :stroke-width="2.4" aria-hidden="true" />
            <template v-else>{{ fmtSigned(row.driftPct) }}</template>
          </span>
        </div>
      </div>
    </div>

    <!-- ░░ Editor (inline expand) ░░ -->
    <div v-else class="mt-3">
      <!-- Search / add -->
      <div class="relative mb-3">
        <Search :size="14" :stroke-width="1.8" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-cool" aria-hidden="true" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search tokens to add…"
          aria-label="Search tokens to add"
          data-testid="rebalance-editor-search"
          class="w-full pl-8 pr-3 py-1.5 rounded-lg font-sans text-sm
                 bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/15
                 text-midnight dark:text-white placeholder:text-cool
                 focus:outline-none focus:border-gold dark:focus:border-signal"
        />
        <div
          v-if="searchResults.length"
          class="absolute z-10 left-0 right-0 mt-1 rounded-lg overflow-hidden
                 bg-white dark:bg-[#1f1e1e] border border-haze dark:border-white/15 shadow-xl"
        >
          <button
            v-for="t in searchResults"
            :key="t.address"
            type="button"
            @click="addToken(t.address)"
            :data-testid="`rebalance-editor-add-${t.symbol}`"
            class="flex items-center justify-between w-full px-3 py-2 text-left
                   hover:bg-mist dark:hover:bg-[#252323] cursor-pointer"
          >
            <span class="font-mono text-sm text-midnight dark:text-white">{{ t.symbol }}</span>
            <Plus :size="14" :stroke-width="2" class="text-compute dark:text-signal" />
          </button>
        </div>
      </div>

      <div
        ref="editorRef"
        tabindex="-1"
        role="group"
        aria-label="Edit target allocations"
        class="space-y-1.5 mb-3 max-h-[min(48vh,360px)] overflow-y-auto focus:outline-none"
        data-testid="rebalance-editor"
      >
        <p
          v-if="editorRows.length === 0"
          class="font-sans text-xs text-cool"
          data-testid="rebalance-editor-empty"
        >
          Search above to add the tokens you want to hold.
        </p>
        <div
          v-for="t in editorRows"
          :key="t.address"
          class="flex items-center justify-between gap-3 rounded-lg px-3 py-1.5
                 bg-mist/40 dark:bg-[#0d0e10] border border-haze dark:border-white/10"
        >
          <span class="font-mono text-sm text-midnight dark:text-white truncate min-w-0">
            {{ t.symbol }}
          </span>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="font-mono text-[11px] text-cool tabular-nums">cur {{ fmtPct(currentPctFor(t.address)) }}</span>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="100"
              step="1"
              :value="pct[t.address.toLowerCase()] ?? 0"
              @input="onPctInput(t.address, ($event.target as HTMLInputElement).value)"
              :aria-label="`Target percent for ${t.symbol}`"
              class="w-14 text-right rounded-md px-2 py-1 font-mono text-sm
                     bg-white dark:bg-[#1f1e1e] border border-haze dark:border-white/15
                     text-midnight dark:text-white focus:outline-none focus:border-gold dark:focus:border-signal"
            />
            <span class="font-sans text-xs text-cool">%</span>
          </div>
        </div>
      </div>

      <!-- Live sum + tolerance -->
      <div class="flex items-center justify-between gap-3 mb-2">
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
            class="w-14 text-right rounded-md px-2 py-1 font-mono text-sm
                   bg-white dark:bg-[#1f1e1e] border border-haze dark:border-white/15
                   text-midnight dark:text-white focus:outline-none focus:border-gold dark:focus:border-signal"
          />
          %
        </label>
      </div>

      <p
        v-if="!toleranceValid"
        role="status"
        class="font-sans text-xs text-cool mb-2"
        data-testid="rebalance-tolerance-hint"
      >
        Tolerance must be between {{ MIN_TOLERANCE_BPS / 100 }}% and {{ MAX_TOLERANCE_BPS / 100 }}%.
      </p>
      <p
        v-if="saveError"
        role="alert"
        class="font-sans text-xs text-negative mb-2"
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
          Save
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
    </div>

    <ConfirmModal
      ref="confirmModalRef"
      :action="activeAction"
      @confirm="onConfirm"
      @cancel="onCancel"
      @complete="onComplete"
    />
  </section>
</template>
