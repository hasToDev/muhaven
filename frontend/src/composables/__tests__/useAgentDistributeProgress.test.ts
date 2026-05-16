/**
 * Unit tests for `useAgentDistributeProgress` — the shared progress bus
 * the runDistribute composable writes to + ConfirmModal reads from.
 *
 * Scope:
 *   - reset returns a fresh runId + stores the toolCallId.
 *   - Stage → phase mapping with monotonic advance.
 *   - runId staleness — events for an old runId are dropped.
 *   - Terminal-state guards on applyEvent / markSettled / markFailed.
 *   - markFailed records the active phase as failedAt.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentDistributeProgress } from '../useAgentDistributeProgress'

function freshBus() {
  // Reset twice to ensure we start from a known runId (the module-level
  // state persists across tests within a file).
  const bus = useAgentDistributeProgress()
  bus.reset(null)
  return bus
}

describe('useAgentDistributeProgress', () => {
  beforeEach(() => {
    // Reset to a clean baseline before each test. runId monotonically
    // increments — tests don't assert specific runId numbers, only
    // before/after relationships.
    useAgentDistributeProgress().reset(null)
  })

  describe('reset', () => {
    it('returns a monotonically increasing runId', () => {
      const bus = useAgentDistributeProgress()
      const a = bus.reset(null)
      const b = bus.reset(null)
      const c = bus.reset(null)
      expect(b).toBeGreaterThan(a)
      expect(c).toBeGreaterThan(b)
    })

    it('stores the toolCallId for downstream modal gating', () => {
      const bus = useAgentDistributeProgress()
      bus.reset('tc_abc123')
      expect(bus.state.value.toolCallId).toBe('tc_abc123')
    })

    it('clears every per-run field back to idle', () => {
      const bus = useAgentDistributeProgress()
      const runId = bus.reset('tc_one')
      bus.applyEventForRun(runId, {
        stage: 'openEpoch',
        current: 1,
        total: 1,
        txHash: '0xabc',
        message: 'mid',
      })
      bus.markFailedForRun(runId)
      bus.reset(null)
      expect(bus.state.value.phase).toBe('idle')
      expect(bus.state.value.failedAt).toBeNull()
      expect(bus.state.value.toolCallId).toBeNull()
      expect(bus.state.value.lastTxHash).toBeNull()
      expect(bus.state.value.message).toBeNull()
      expect(bus.state.value.current).toBe(0)
      expect(bus.state.value.total).toBe(0)
    })
  })

  describe('applyEventForRun — phase advance', () => {
    it('idle → start on openEpoch', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1, txHash: '0xstart' })
      expect(bus.state.value.phase).toBe('start')
      expect(bus.state.value.lastStage).toBe('openEpoch')
      expect(bus.state.value.lastTxHash).toBe('0xstart')
    })

    it('start → escrows on snapshotBatch', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 2 })
      expect(bus.state.value.phase).toBe('escrows')
      expect(bus.state.value.current).toBe(1)
      expect(bus.state.value.total).toBe(2)
    })

    it('finalizeSnapshot keeps phase on escrows (does NOT drop back to start)', () => {
      // Plan §"Architectural pins" pin 2 — load-bearing UX semantic.
      // The monotonic-bus rule would silently swallow a regression
      // (phase wouldn't visibly drop), but the bar would freeze on
      // "Allocate" through finalize and the user would see no motion
      // for the duration of the finalize UserOp. Mapping finalize to
      // 'escrows' (its semantic phase) keeps the bar progressing
      // visibly through the snapshot-close step.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('escrows')
      expect(bus.state.value.lastStage).toBe('finalizeSnapshot')
    })

    it('escrows → fund on fundEpoch', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 2, total: 2 })
      bus.applyEventForRun(runId, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1, txHash: '0xfund' })
      expect(bus.state.value.phase).toBe('fund')
      expect(bus.state.value.lastTxHash).toBe('0xfund')
    })

    it('"encrypt" event during fundEpoch does NOT advance phase on its own', () => {
      // The SDK emits 'encrypt' inside fundEpoch (totalYield encryption)
      // BEFORE the 'fundEpoch' event. The bus shouldn't react to
      // 'encrypt' alone — would cause phase to advance from 'escrows'
      // to nothing-or-stay (currently maps to null). Test asserts the
      // bar stays on 'escrows' across an encrypt-then-fund sequence.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'encrypt', current: 0, total: 1 })
      // Phase still 'escrows' — encrypt is the prelude to fund, not a
      // new phase on its own.
      expect(bus.state.value.phase).toBe('escrows')
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })

    it('late "encrypt" after fund does NOT regress', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'encrypt', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })

    it('late openEpoch after fund does NOT regress', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })

    it('investor-side stages (claimYield / sweepExpired) do NOT touch phase', () => {
      // These stages are emitted by the YieldSnapshotClient on
      // investor-side / cleanup paths — never on the issuer's
      // distribute path. If a stray event leaked in (e.g. shared
      // module import), the bus shouldn't advance.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'claimYield', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('start')
      bus.applyEventForRun(runId, { stage: 'sweepExpired', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('start')
    })
  })

  describe('runId staleness', () => {
    it('drops applyEvent calls whose runId no longer matches the bus', () => {
      // A starts, advances to 'fund'. Then B resets (new runId). A's
      // late onProgress fires with A's captured runId — must be ignored.
      const bus = freshBus()
      const runIdA = bus.reset('tc_A')
      bus.applyEventForRun(runIdA, { stage: 'fundEpoch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')

      const runIdB = bus.reset('tc_B')
      expect(runIdB).not.toBe(runIdA)
      expect(bus.state.value.phase).toBe('idle')

      // A's stale onProgress (theoretical late SDK callback): silently dropped.
      bus.applyEventForRun(runIdA, { stage: 'snapshotBatch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('idle')
      expect(bus.state.value.toolCallId).toBe('tc_B')
    })

    it('drops markSettled for a stale runId', () => {
      const bus = freshBus()
      const runIdA = bus.reset(null)
      bus.applyEventForRun(runIdA, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.reset(null) // new runId
      bus.markSettledForRun(runIdA)
      expect(bus.state.value.phase).toBe('idle')
    })

    it('drops markFailed for a stale runId', () => {
      const bus = freshBus()
      const runIdA = bus.reset(null)
      bus.applyEventForRun(runIdA, { stage: 'snapshotBatch', current: 1, total: 1 })
      bus.reset(null) // new runId
      bus.markFailedForRun(runIdA)
      expect(bus.state.value.phase).toBe('idle')
    })
  })

  describe('terminal-state guards', () => {
    it('applyEvent after markSettled does NOT mutate phase', () => {
      // Late onProgress arriving after the runner has resolved must not
      // demote 'settled' or mutate side fields (Reality F11).
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.markSettledForRun(runId)
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 99, total: 99 })
      expect(bus.state.value.phase).toBe('settled')
      // Side fields should also stay frozen post-settle.
      expect(bus.state.value.current).toBe(1)
      expect(bus.state.value.total).toBe(1)
    })

    it('applyEvent after markFailed does NOT mutate phase', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 1 })
      bus.markFailedForRun(runId)
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 99, total: 99 })
      expect(bus.state.value.phase).toBe('failed')
      expect(bus.state.value.failedAt).toBe('escrows')
    })

    it('markSettled after markFailed is a no-op (failed sticks)', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.markFailedForRun(runId)
      bus.markSettledForRun(runId)
      expect(bus.state.value.phase).toBe('failed')
    })

    it('markFailed after markSettled is a no-op (settled sticks)', () => {
      // Code Reviewer H-2 / Reality F12: settle-then-fail must not
      // overwrite the success state.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.markSettledForRun(runId)
      bus.markFailedForRun(runId)
      expect(bus.state.value.phase).toBe('settled')
      expect(bus.state.value.failedAt).toBeNull()
    })
  })

  describe('markFailed', () => {
    it('pins failedAt to the active phase at throw time', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 3 })
      bus.markFailedForRun(runId)
      expect(bus.state.value.phase).toBe('failed')
      expect(bus.state.value.failedAt).toBe('escrows')
    })

    it('defensive fallback: failedAt="start" if called from idle phase', () => {
      // The runner gates markFailed calls behind a "phase is SDK-set"
      // check, so this branch should be unreachable in production. Kept
      // as defensive coverage in case a future caller forgets the gate.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.markFailedForRun(runId)
      expect(bus.state.value.phase).toBe('failed')
      expect(bus.state.value.failedAt).toBe('start')
    })
  })

  describe('setMessageForRun (round-2 RC-HIGH-2 + RC-MED-1)', () => {
    it('writes message when phase is escrows and runId matches', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      // phase is now 'escrows'; lastStage is 'finalizeSnapshot'.
      bus.setMessageForRun(runId, 'Reading encrypted supply…')
      expect(bus.state.value.message).toBe('Reading encrypted supply…')
      expect(bus.state.value.phase).toBe('escrows')
    })

    it('silently drops writes from a stale runId', () => {
      const bus = freshBus()
      const runIdA = bus.reset(null)
      bus.applyEventForRun(runIdA, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      // Establish a baseline synthetic message under runIdA.
      bus.setMessageForRun(runIdA, 'baseline')
      expect(bus.state.value.message).toBe('baseline')
      // New run starts; toolCallId cleared, runId bumped.
      bus.reset(null)
      const runIdB = bus.state.value.runId
      // Re-enter 'escrows' under the NEW runId so the phase guard
      // would otherwise permit a write. The runId-stale guard from
      // the prior run still drops it.
      bus.applyEventForRun(runIdB, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      bus.setMessageForRun(runIdA, 'stale write')
      expect(bus.state.value.message).not.toBe('stale write')
    })

    it('silently drops writes when phase is not escrows (phase guard)', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      // Phase is 'idle' — synthetic write should drop.
      bus.setMessageForRun(runId, 'too early')
      expect(bus.state.value.message).toBeNull()

      bus.applyEventForRun(runId, { stage: 'openEpoch', current: 1, total: 1 })
      // Phase is 'start' — synthetic write should still drop.
      bus.setMessageForRun(runId, 'wrong phase')
      expect(bus.state.value.message).toBeNull()

      bus.applyEventForRun(runId, { stage: 'snapshotBatch', current: 1, total: 1 })
      // Phase is 'escrows' — write should land now.
      bus.setMessageForRun(runId, 'now ok')
      expect(bus.state.value.message).toBe('now ok')

      bus.applyEventForRun(runId, { stage: 'fundEpoch', current: 1, total: 1 })
      // Phase is 'fund' — synthetic write should drop again.
      bus.setMessageForRun(runId, 'too late')
      // 'fundEpoch' event was emitted with no message; applyEventForRun
      // wrote `message = null`. setMessageForRun's phase guard refused.
      expect(bus.state.value.message).toBeNull()
    })

    it('silently drops writes on terminal phases (failed / settled)', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'finalizeSnapshot', current: 1, total: 1 })
      bus.markFailedForRun(runId)
      bus.setMessageForRun(runId, 'should drop on failed')
      expect(bus.state.value.message).not.toBe('should drop on failed')

      const runId2 = bus.reset(null)
      bus.applyEventForRun(runId2, { stage: 'fundEpoch', current: 1, total: 1 })
      bus.markSettledForRun(runId2)
      bus.setMessageForRun(runId2, 'should drop on settled')
      expect(bus.state.value.message).not.toBe('should drop on settled')
    })
  })

  describe('singleton identity', () => {
    it('two composable calls share the same module-level state', () => {
      const a = useAgentDistributeProgress()
      const b = useAgentDistributeProgress()
      const runId = a.reset(null)
      a.applyEventForRun(runId, { stage: 'fundEpoch', current: 7, total: 7 })
      expect(b.state.value.phase).toBe('fund')
      expect(b.state.value.current).toBe(7)
    })
  })
})
