/**
 * Wave 4 P7 Phase 2 — shared progress bus for `distribute_yield`.
 *
 * The SDK's `MuHavenClient.distributeYield(totalYield, { onProgress })`
 * runs three sequential stages (start → escrows → fund) that take
 * ~1-2 minutes for non-trivial investor counts. The runner produces
 * `ProgressEvent`s; the ConfirmModal renders them as a three-step bar.
 * They live in separate Vue components with no parent/child link, so the
 * cleanest cross-cut is a module-level reactive `ref` exposed via a
 * composable (same shape pattern as `useFhe`).
 *
 * Stages → phases mapping (collapses the 7 SDK stages into 3 user-facing
 * steps + a final settled state):
 *
 *   phase 'start'   ← stage 'encrypt' (during startDistributionFlow),
 *                     stage 'startDistribution'
 *   phase 'escrows' ← stage 'encrypt' (during createYieldEscrowsFlow),
 *                     stage 'batchCreate'
 *   phase 'fund'    ← stage 'setEscrowIds', stage 'processBatch'
 *   phase 'settled' ← runner posts this once distributeYield resolves
 *   phase 'failed'  ← runner posts this if the SDK pipeline throws
 *                     mid-flight (pre-flight throws do NOT reach this —
 *                     see runner JSDoc)
 *
 * Phases are monotonic: once we advance to 'escrows' we never regress
 * to 'start' even if the SDK happens to emit a stray earlier-stage event
 * mid-pipeline.
 *
 * Cross-run isolation (second-pass review 2026-05-21):
 *   - Each `reset()` call captures the descriptor's `toolCallId` AND
 *     bumps an internal `runId`. The runner threads `runId` through
 *     every subsequent `applyEvent` / `markSettled` / `markFailed`
 *     call; any call whose `runId` doesn't match the current bus state
 *     is silently dropped. This closes the "stale `onProgress` from a
 *     prior run mutates the new run's bar" race (Code Reviewer H-1).
 *   - The `toolCallId` is exposed to the modal so the 3-phase bar can
 *     gate its v-if on `bus.toolCallId === props.action.toolCallId` —
 *     when a descriptor swaps in mid-flight, the bar hides for the new
 *     descriptor (preventing the "B's preview rows + A's progress bar"
 *     confusion surfaced by the Reality Checker descriptor-swap walk).
 *
 * Terminal-state guards (second-pass review):
 *   - `applyEvent` early-returns on `phase === 'failed' | 'settled'`.
 *   - `markSettled` early-returns on `failed` (never demote a fail).
 *   - `markFailed` early-returns on `settled` (never demote a success).
 *
 * Refresh semantics (operator pick 2026-05-19 Q3): NO sessionStorage
 * persistence. A mid-distribute page refresh loses the modal state
 * deliberately — the user goes to /distribute to see the YieldRecord row.
 */
import { ref, type Ref } from 'vue'
import type { ProgressEvent } from '@muhaven/sdk'

/**
 * Phase states. `'failed'` is non-monotonic: it overrides via a
 * dedicated `markFailed` call. `'idle'` is the post-reset / no-run-yet
 * state — the modal hides the 3-phase bar while phase is idle so
 * pre-flight failures don't paint a misleading red step-1.
 */
export type DistributeProgressPhase = 'idle' | 'start' | 'escrows' | 'fund' | 'settled' | 'failed'

const ACTIVE_ORDER: readonly DistributeProgressPhase[] = [
  'idle',
  'start',
  'escrows',
  'fund',
  'settled',
]

function activeRank(phase: DistributeProgressPhase): number {
  // 'failed' is excluded — we never compare 'failed' for monotonic
  // advance; it overrides via a dedicated markFailed() call.
  return ACTIVE_ORDER.indexOf(phase)
}

export interface DistributeProgressState {
  phase: DistributeProgressPhase
  /**
   * Monotonic counter bumped on every `reset`. Runner captures the
   * value at the start of `runDistribute` and threads it through every
   * subsequent call — stale events from a previous run are dropped.
   */
  runId: number
  /**
   * The descriptor's `toolCallId` this run belongs to. `null` outside
   * an active run. The modal gates the 3-phase bar's visibility on
   * `bus.toolCallId === props.action.toolCallId` so a descriptor-swap
   * mid-flight doesn't show B's preview with A's progress bar.
   */
  toolCallId: string | null
  /**
   * The phase that was active when `markFailed` flipped `phase` to
   * 'failed'. `null` outside the failed state. Lets the modal paint
   * the failing step red while still showing earlier steps as done.
   *
   * Always `'start' | 'escrows' | 'fund'` when set — the runner only
   * calls `markFailed` after the SDK pipeline has emitted at least one
   * onProgress event, so pre-flight throws never reach here.
   */
  failedAt: Exclude<DistributeProgressPhase, 'idle' | 'settled' | 'failed'> | null
  /** Last SDK stage event we saw — for sub-step labelling ("encrypting…", "batch 2/4…"). */
  lastStage: ProgressEvent['stage'] | null
  /** Per-stage current/total — surfaces "batch 2/4" inside the 'escrows' / 'fund' phases. */
  current: number
  total: number
  /** Most recent stage tx hash (broadcast tx for the active stage). */
  lastTxHash: string | null
  /** Free-form sub-message from the SDK ("encrypting batch 2/4"). */
  message: string | null
}

function initialState(): DistributeProgressState {
  return {
    phase: 'idle',
    runId: 0,
    toolCallId: null,
    failedAt: null,
    lastStage: null,
    current: 0,
    total: 0,
    lastTxHash: null,
    message: null,
  }
}

// Module-level state — initialised lazily on first composable call.
// Lives outside the composable so every component sees the SAME ref and
// reactive updates propagate without prop drilling.
const state: Ref<DistributeProgressState> = ref(initialState())

/**
 * Map an SDK `ProgressEvent.stage` to the user-facing 3-phase bucket.
 * Stages outside the distribute pipeline (e.g. 'redeem', 'wrap') map to
 * null — the runner's onProgress filter ignores them, but the typing
 * makes the dispatch explicit.
 */
function stageToPhase(stage: ProgressEvent['stage']): DistributeProgressPhase | null {
  switch (stage) {
    case 'encrypt':
      // 'encrypt' fires in BOTH startDistributionFlow and
      // createYieldEscrowsFlow. We can't disambiguate from the event
      // alone, so we let the monotonic phase rule keep us on the
      // already-advanced phase (e.g. once we're on 'escrows', a stray
      // 'encrypt' won't drag us back to 'start').
      return null
    case 'startDistribution':
      return 'start'
    case 'batchCreate':
      return 'escrows'
    case 'setEscrowIds':
    case 'processBatch':
      return 'fund'
    default:
      return null
  }
}

/**
 * Apply an SDK progress event, but only if the runId matches the
 * current run. Stale events from a prior runner whose closure is still
 * being scheduled are silently dropped. Also no-ops on terminal phase
 * so a post-settle onProgress doesn't mutate visible state.
 */
function applyEventForRun(runId: number, evt: ProgressEvent): void {
  if (state.value.runId !== runId) return
  if (state.value.phase === 'failed' || state.value.phase === 'settled') return

  state.value.lastStage = evt.stage
  state.value.current = evt.current
  state.value.total = evt.total
  state.value.message = evt.message ?? null
  if (evt.txHash) state.value.lastTxHash = evt.txHash
  const target = stageToPhase(evt.stage)
  if (target && activeRank(target) > activeRank(state.value.phase)) {
    state.value.phase = target
  }
}

/**
 * Flip the bus to 'settled' for the given runId. No-op if a different
 * run has since taken over (runId mismatch) or if the bus is already
 * 'failed' (never demote a failure).
 */
function markSettledForRun(runId: number): void {
  if (state.value.runId !== runId) return
  if (state.value.phase === 'failed') return
  state.value.phase = 'settled'
}

/**
 * Flip the bus to 'failed' for the given runId, recording the active
 * phase at throw time so the modal can paint the right step red. No-op
 * if a different run owns the bus or if the bus is already 'settled'
 * (never demote a success).
 *
 * Callers MUST only invoke this if the SDK pipeline has actually
 * emitted at least one onProgress event (i.e. `phase` is 'start' /
 * 'escrows' / 'fund'). Pre-flight failures should NOT call this — the
 * runner gates the call accordingly so the 3-phase bar isn't painted
 * with a fake red step-1 for client-side validation errors.
 */
function markFailedForRun(runId: number): void {
  if (state.value.runId !== runId) return
  if (state.value.phase === 'settled') return
  // Defensive: if a caller violates the "only call after SDK started"
  // contract, fall back to step 1 anchoring. The runner's guard prevents
  // this in practice; the fallback exists so a bug elsewhere doesn't
  // leave `failedAt: null` on a `phase: 'failed'` bus.
  const wasActive = state.value.phase
  if (wasActive === 'start' || wasActive === 'escrows' || wasActive === 'fund') {
    state.value.failedAt = wasActive
  } else {
    state.value.failedAt = 'start'
  }
  state.value.phase = 'failed'
}

/**
 * Reset the bus to idle and bump the runId. Returns the new runId so
 * the runner can thread it through subsequent `applyEventForRun` /
 * `markSettledForRun` / `markFailedForRun` calls.
 *
 * `toolCallId` is stored so the modal can verify the bus belongs to the
 * currently-displayed descriptor before rendering the 3-phase bar.
 */
function reset(toolCallId: string | null = null): number {
  const newRunId = state.value.runId + 1
  state.value = {
    ...initialState(),
    runId: newRunId,
    toolCallId,
  }
  return newRunId
}

/**
 * Vue composable exposing the shared distribute-progress state plus
 * helpers. Modal callers only need `state` (for reactive reads); runner
 * callers use `reset` / `applyEventForRun` / `markSettledForRun` /
 * `markFailedForRun`.
 */
export function useAgentDistributeProgress(): {
  state: Ref<DistributeProgressState>
  reset: (toolCallId?: string | null) => number
  applyEventForRun: (runId: number, evt: ProgressEvent) => void
  markSettledForRun: (runId: number) => void
  markFailedForRun: (runId: number) => void
} {
  return { state, reset, applyEventForRun, markSettledForRun, markFailedForRun }
}
