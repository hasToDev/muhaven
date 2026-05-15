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
 *
 * Phases are monotonic: once we advance to 'escrows' we never regress
 * to 'start' even if the SDK happens to emit a stray earlier-stage event
 * mid-pipeline. The phase order is enforced via PHASE_ORDER below.
 *
 * Cancellation semantics (operator pick 2026-05-19 Q2): once we've
 * advanced past 'start' the modal disables Cancel. The flag
 * `canCancel.value` is the derived read; it flips from true → false on
 * the first SDK callback that names a phase other than 'start' AND once
 * we've emitted at least one txHash (= the on-chain start tx is broadcast).
 *
 * Refresh semantics (operator pick 2026-05-19 Q3): NO sessionStorage
 * persistence. A mid-distribute page refresh loses the modal state
 * deliberately — the user goes to /distribute to see the YieldRecord row.
 */
import { ref, type Ref } from 'vue'
import type { ProgressEvent } from '@muhaven/sdk'

/**
 * 'failed' is sticky-on-the-phase-we-died-in: when the SDK pipeline
 * throws mid-flight the runner calls `markFailed()`; the bus keeps
 * `failedAt` set to the phase that was active so the modal can paint
 * the right step red without losing the "phase 1+2 done" history.
 * Self-review fix landed 2026-05-20 (Code Reviewer H-1 + UX H-1).
 */
export type DistributeProgressPhase = 'idle' | 'start' | 'escrows' | 'fund' | 'settled' | 'failed'

export const PHASE_ORDER: readonly DistributeProgressPhase[] = [
  'idle',
  'start',
  'escrows',
  'fund',
  'settled',
  'failed',
] as const

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
   * The phase that was active when `markFailed` flipped `phase` to
   * 'failed'. `null` outside the failed state. Lets the modal paint
   * the failing step red while still showing earlier steps as done.
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

// Module-level state — initialised lazily on first composable call.
// Lives outside the composable so every component sees the SAME ref and
// reactive updates propagate without prop drilling.
const state: Ref<DistributeProgressState> = ref({
  phase: 'idle',
  failedAt: null,
  lastStage: null,
  current: 0,
  total: 0,
  lastTxHash: null,
  message: null,
})

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

function applyEvent(evt: ProgressEvent): void {
  // Refuse to overwrite a 'failed' phase. Once the runner has marked
  // the bus failed, late-arriving onProgress events (e.g. an SDK
  // post-throw cleanup) MUST NOT flip the modal back to "in progress"
  // and leave the user staring at a spinner with no recovery path.
  if (state.value.phase === 'failed') return

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

function markSettled(): void {
  if (state.value.phase === 'failed') return
  state.value.phase = 'settled'
}

/**
 * Flip the bus to 'failed'. Self-review fix 2026-05-20:
 * `failedAt` records the phase that was active so the modal can paint
 * the failing step red. Called by the runner's catch block when
 * `sdk.distributeYield` (or any pre-flight) throws. After this, the
 * bus is INERT — `applyEvent` and `markSettled` both no-op until
 * `reset()` is called (typically when a new descriptor lands).
 */
function markFailed(): void {
  const wasActive = state.value.phase
  if (wasActive === 'start' || wasActive === 'escrows' || wasActive === 'fund') {
    state.value.failedAt = wasActive
  } else {
    // Pre-flight failures (e.g. setOperator revert, kernel-binding
    // mismatch) happen before any SDK progress event lands — phase is
    // still 'idle'. Anchor the red icon at the first phase so the
    // user sees a coherent "Start failed" indication rather than an
    // all-pending bar with a separate error surface.
    state.value.failedAt = 'start'
  }
  state.value.phase = 'failed'
}

function reset(): void {
  state.value = {
    phase: 'idle',
    failedAt: null,
    lastStage: null,
    current: 0,
    total: 0,
    lastTxHash: null,
    message: null,
  }
}

/**
 * Vue composable exposing the shared distribute-progress state plus
 * helpers the runner calls (`applyEvent`, `markSettled`, `markFailed`,
 * `reset`). Derived flags like "is the modal cancellable" live on the
 * ConfirmModal side because they need to combine the bus state with
 * the modal's own `status` ref.
 */
export function useAgentDistributeProgress(): {
  state: Ref<DistributeProgressState>
  applyEvent: (evt: ProgressEvent) => void
  markSettled: () => void
  markFailed: () => void
  reset: () => void
} {
  return { state, applyEvent, markSettled, markFailed, reset }
}
