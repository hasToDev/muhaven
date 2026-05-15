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
        stage: 'startDistribution',
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
    it('idle → start on startDistribution', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1, txHash: '0xstart' })
      expect(bus.state.value.phase).toBe('start')
      expect(bus.state.value.lastStage).toBe('startDistribution')
      expect(bus.state.value.lastTxHash).toBe('0xstart')
    })

    it('start → escrows on batchCreate', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 1, total: 2 })
      expect(bus.state.value.phase).toBe('escrows')
      expect(bus.state.value.current).toBe(1)
      expect(bus.state.value.total).toBe(2)
    })

    it('escrows → fund on processBatch', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 2, total: 2 })
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })

    it('setEscrowIds also bumps phase to fund', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'setEscrowIds', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })

    it('late "encrypt" event after escrows does NOT regress to start', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 1, total: 2 })
      bus.applyEventForRun(runId, { stage: 'encrypt', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('escrows')
    })

    it('late startDistribution after fund does NOT regress', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 1, total: 1 })
      bus.applyEventForRun(runId, { stage: 'startDistribution', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')
    })
  })

  describe('runId staleness', () => {
    it('drops applyEvent calls whose runId no longer matches the bus', () => {
      // A starts, advances to 'fund'. Then B resets (new runId). A's
      // late onProgress fires with A's captured runId — must be ignored.
      const bus = freshBus()
      const runIdA = bus.reset('tc_A')
      bus.applyEventForRun(runIdA, { stage: 'processBatch', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('fund')

      const runIdB = bus.reset('tc_B')
      expect(runIdB).not.toBe(runIdA)
      expect(bus.state.value.phase).toBe('idle')

      // A's stale onProgress (theoretical late SDK callback): silently dropped.
      bus.applyEventForRun(runIdA, { stage: 'batchCreate', current: 1, total: 1 })
      expect(bus.state.value.phase).toBe('idle')
      expect(bus.state.value.toolCallId).toBe('tc_B')
    })

    it('drops markSettled for a stale runId', () => {
      const bus = freshBus()
      const runIdA = bus.reset(null)
      bus.applyEventForRun(runIdA, { stage: 'processBatch', current: 1, total: 1 })
      bus.reset(null) // new runId
      bus.markSettledForRun(runIdA)
      expect(bus.state.value.phase).toBe('idle')
    })

    it('drops markFailed for a stale runId', () => {
      const bus = freshBus()
      const runIdA = bus.reset(null)
      bus.applyEventForRun(runIdA, { stage: 'batchCreate', current: 1, total: 1 })
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
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 1, total: 1 })
      bus.markSettledForRun(runId)
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 99, total: 99 })
      expect(bus.state.value.phase).toBe('settled')
      // Side fields should also stay frozen post-settle.
      expect(bus.state.value.current).toBe(1)
      expect(bus.state.value.total).toBe(1)
    })

    it('applyEvent after markFailed does NOT mutate phase', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 1, total: 1 })
      bus.markFailedForRun(runId)
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 99, total: 99 })
      expect(bus.state.value.phase).toBe('failed')
      expect(bus.state.value.failedAt).toBe('escrows')
    })

    it('markSettled after markFailed is a no-op (failed sticks)', () => {
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 1, total: 1 })
      bus.markFailedForRun(runId)
      bus.markSettledForRun(runId)
      expect(bus.state.value.phase).toBe('failed')
    })

    it('markFailed after markSettled is a no-op (settled sticks)', () => {
      // Code Reviewer H-2 / Reality F12: settle-then-fail must not
      // overwrite the success state.
      const bus = freshBus()
      const runId = bus.reset(null)
      bus.applyEventForRun(runId, { stage: 'processBatch', current: 1, total: 1 })
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
      bus.applyEventForRun(runId, { stage: 'batchCreate', current: 1, total: 3 })
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

  describe('singleton identity', () => {
    it('two composable calls share the same module-level state', () => {
      const a = useAgentDistributeProgress()
      const b = useAgentDistributeProgress()
      const runId = a.reset(null)
      a.applyEventForRun(runId, { stage: 'processBatch', current: 7, total: 7 })
      expect(b.state.value.phase).toBe('fund')
      expect(b.state.value.current).toBe(7)
    })
  })
})
