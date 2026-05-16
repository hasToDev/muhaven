/**
 * Wave 4 P7 Phase 2 — shared progress bus for `distribute_yield`.
 *
 * The SDK's `YieldSnapshotClient` lifecycle (`openEpoch` →
 * `snapshotAll` → `finalizeSnapshot` → `fundEpoch`) runs three logical
 * phases that take ~1-2 minutes for non-trivial holder counts. The
 * runner produces `ProgressEvent`s; the ConfirmModal renders them as a
 * three-step bar. They live in separate Vue components with no
 * parent/child link, so the cleanest cross-cut is a module-level
 * reactive `ref` exposed via a composable (same shape pattern as
 * `useFhe`).
 *
 * Stages → phases mapping (collapses the YieldSnapshot SDK stages into
 * 3 user-facing steps + a final settled state). The mapping below
 * targets the Wave 3.5 `YieldSnapshotClient` (the prior Wave 3
 * `MuHavenClient.distributeYield` pipeline was rewired out 2026-05-22 —
 * see `development/DEV_WAVE_4/PHASE_2_YIELD_SNAPSHOT_REWIRE.md`):
 *
 *   phase 'start'   ← stage 'openEpoch'
 *   phase 'escrows' ← stage 'snapshotBatch', stage 'finalizeSnapshot'
 *                     (NB: finalizeSnapshot maps to 'escrows' — NOT back
 *                     to 'start'. It is the closing step of the
 *                     allocation phase; routing it to 'start' would
 *                     drop the bar back to phase 1 mid-flight under the
 *                     monotonic rule. Pinned by the rewire plan.)
 *   phase 'fund'    ← stage 'fundEpoch'
 *   stage 'encrypt' → null (handled by the SDK during fundEpoch's
 *                     totalYield encryption; routing it would cause a
 *                     spurious phase regression for the ratePerShare
 *                     dance. Surfaces as the "Encrypting…" sub-message
 *                     under phase 'fund' once the encrypt event fires.)
 *   stage 'claimYield' / 'sweepExpired' → null (investor / cleanup —
 *                     not on the issuer's distribute path)
 *   phase 'settled' ← runner posts this once fundEpoch resolves
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
 * Stages outside the YieldSnapshot distribute pipeline (e.g. 'redeem',
 * 'wrap', investor-side 'claimYield') map to null — the runner's
 * onProgress filter ignores them, but the typing makes the dispatch
 * explicit.
 *
 * Pinned mappings (rewire 2026-05-22):
 *   - `finalizeSnapshot → 'escrows'` (NOT `'start'`). Finalize is the
 *     CLOSING step of the allocation phase; routing it to `'start'`
 *     would drop the bar back to phase 1 mid-flight (monotonic rule
 *     would silently swallow the regression — bar would freeze on
 *     "Allocate to holders" while finalize tx is in flight).
 *   - `encrypt → null`. The SDK emits this during `fundEpoch`'s
 *     totalYield encryption; the bar should already be on phase
 *     `'fund'` by then (or arrive there via `fundEpoch` straight after).
 *     Letting `encrypt` drive the phase would cause an `escrows → null`
 *     no-op now and a spurious regression class if a future SDK change
 *     re-emits `encrypt` earlier in the pipeline.
 */
function stageToPhase(stage: ProgressEvent['stage']): DistributeProgressPhase | null {
  switch (stage) {
    case 'openEpoch':
      return 'start'
    case 'snapshotBatch':
    case 'finalizeSnapshot':
      return 'escrows'
    case 'fundEpoch':
      return 'fund'
    case 'encrypt':
      // Fires inside `fundEpoch` for the totalYield encryption. The bar
      // is on `'fund'` by the time the corresponding fundEpoch event
      // fires, so routing this to a phase would either be a no-op
      // (already on 'fund') or a spurious regression (if encrypt fires
      // before any phase advance). Surfaces as the "Encrypting total
      // yield" sub-message under whichever phase is active.
      return null
    case 'claimYield':
    case 'sweepExpired':
      // Investor-side / post-distribution stages — not on the issuer's
      // distribute path. The runner doesn't drive these; the bus
      // shouldn't react if a stray event leaks in.
      return null
    default:
      return null
  }
}

/**
 * Apply an SDK progress event, but only if the runId matches the
 * current run. Stale events from a prior runner whose closure is still
 * being scheduled are silently dropped. Also no-ops on terminal phase
 * so a post-settle onProgress doesn't mutate visible state.
 *
 * Round-1 self-review HIGH (FD-H-1, 2026-05-22): events whose stage
 * maps to `null` (e.g. `'encrypt'` fired by `fundEpoch` for the
 * totalYield encryption) skip ALL state mutation — without this guard,
 * the active phase's hint would briefly switch to the null-stage's
 * message ("Encrypting total yield" appearing under the
 * "Allocate to holders" hint while the bar is still on `'escrows'`).
 * The runner uses the dedicated `setMessageForRun` helper for
 * synthetic dead-window hints (e.g. "Reading encrypted supply…")
 * which respects the runId guard but doesn't touch lastStage / current
 * / total.
 */
function applyEventForRun(runId: number, evt: ProgressEvent): void {
  if (state.value.runId !== runId) return
  if (state.value.phase === 'failed' || state.value.phase === 'settled') return

  const target = stageToPhase(evt.stage)
  if (!target) return

  state.value.lastStage = evt.stage
  state.value.current = evt.current
  state.value.total = evt.total
  // Round-2 review RC-MED-2 (invariant pin): unconditionally writing
  // `evt.message ?? null` is intentional. SDK events without a message
  // field (txHash-only broadcast events) DO blank the message slot —
  // this is the mechanism by which a synthetic `setMessageForRun` hint
  // from the dead window between finalizeSnapshot and fundEpoch
  // (e.g. "Computing per-share rate…") is cleared as soon as the
  // `fundEpoch` event arrives. The new phase's hint copy then takes
  // over (via `distributePhaseMeta`). Do NOT change this to
  // `if (evt.message) state.value.message = evt.message` without
  // adding a separate phase-transition reset for the message slot —
  // otherwise the dead-window synthetic hint would leak into the
  // 'fund' phase.
  state.value.message = evt.message ?? null
  if (evt.txHash) state.value.lastTxHash = evt.txHash
  if (activeRank(target) > activeRank(state.value.phase)) {
    state.value.phase = target
  }
}

/**
 * Set the bus's `message` slot for synthetic UX hints that aren't
 * driven by an SDK event. Used by `runDistribute` to bridge the
 * ~1-2s dead window between `finalizeSnapshot` and `fundEpoch` (the
 * ratePerShare compute step: refresh L2 grant + decrypt supply +
 * floor math) where the bar would otherwise sit on `'escrows'` with a
 * stale "Epoch K finalised" message + no animation. UX round-1 review
 * (UX-M-2 + FD-M-1, 2026-05-22) flagged this as the highest "is it
 * stuck?" trust-dip in the surface.
 *
 * Round-2 review RC-HIGH-2 added the `phase === 'escrows'` guard.
 * Without it, a future SDK change that emits an intermediate event
 * during the refresh/decrypt window (currently impossible — only
 * `fundEpoch` emits and it's the next phase advance) could collide
 * with an in-flight synthetic write. Pinning the guard to `'escrows'`
 * documents the calling contract (runner invokes this ONLY between
 * the finalizeSnapshot event and the fundEpoch event) and fails
 * silently on misuse rather than painting stray hint copy under the
 * wrong phase's label.
 *
 * Also dropped silently on runId mismatch — same posture as
 * `applyEventForRun`.
 */
function setMessageForRun(runId: number, message: string): void {
  if (state.value.runId !== runId) return
  if (state.value.phase !== 'escrows') return
  state.value.message = message
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
  setMessageForRun: (runId: number, message: string) => void
  markSettledForRun: (runId: number) => void
  markFailedForRun: (runId: number) => void
} {
  return { state, reset, applyEventForRun, setMessageForRun, markSettledForRun, markFailedForRun }
}
