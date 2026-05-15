/**
 * Unit tests for `useAgentDistributeProgress` — the shared progress bus
 * the runDistribute composable writes to + ConfirmModal reads from.
 *
 * Scope:
 *   - Stage → phase mapping.
 *   - Monotonic phase advance (no regression on stale events).
 *   - Reset semantics between distributions.
 *   - markFailed pinning + late-event refusal after failure.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentDistributeProgress } from '../useAgentDistributeProgress'

describe('useAgentDistributeProgress', () => {
  beforeEach(() => {
    useAgentDistributeProgress().reset()
  })

  it('starts in idle with no failedAt', () => {
    const p = useAgentDistributeProgress()
    expect(p.state.value.phase).toBe('idle')
    expect(p.state.value.failedAt).toBeNull()
  })

  it('advances idle → start on startDistribution stage', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1, txHash: '0xstart' })
    expect(p.state.value.phase).toBe('start')
    expect(p.state.value.lastStage).toBe('startDistribution')
    expect(p.state.value.lastTxHash).toBe('0xstart')
  })

  it('advances start → escrows on batchCreate stage', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    p.applyEvent({ stage: 'batchCreate', current: 1, total: 2 })
    expect(p.state.value.phase).toBe('escrows')
    expect(p.state.value.current).toBe(1)
    expect(p.state.value.total).toBe(2)
  })

  it('advances escrows → fund on processBatch stage', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    p.applyEvent({ stage: 'batchCreate', current: 2, total: 2 })
    p.applyEvent({ stage: 'processBatch', current: 1, total: 1 })
    expect(p.state.value.phase).toBe('fund')
  })

  it('setEscrowIds also bumps phase to fund', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    p.applyEvent({ stage: 'batchCreate', current: 1, total: 1 })
    p.applyEvent({ stage: 'setEscrowIds', current: 1, total: 1 })
    expect(p.state.value.phase).toBe('fund')
  })

  it('a late "encrypt" event after escrows does NOT regress to start', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    p.applyEvent({ stage: 'batchCreate', current: 1, total: 2 })
    p.applyEvent({ stage: 'encrypt', current: 1, total: 1 })
    expect(p.state.value.phase).toBe('escrows')
  })

  it('a startDistribution event after we are already in fund does NOT regress', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    p.applyEvent({ stage: 'processBatch', current: 1, total: 1 })
    p.applyEvent({ stage: 'startDistribution', current: 1, total: 1 })
    expect(p.state.value.phase).toBe('fund')
  })

  it('markSettled flips phase to settled', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'processBatch', current: 1, total: 1 })
    p.markSettled()
    expect(p.state.value.phase).toBe('settled')
  })

  it('reset returns to idle / clears tx hash / message / counters / failedAt', () => {
    const p = useAgentDistributeProgress()
    p.applyEvent({ stage: 'startDistribution', current: 5, total: 10, txHash: '0xabc', message: 'mid' })
    p.markFailed()
    p.reset()
    expect(p.state.value.phase).toBe('idle')
    expect(p.state.value.failedAt).toBeNull()
    expect(p.state.value.lastTxHash).toBeNull()
    expect(p.state.value.message).toBeNull()
    expect(p.state.value.current).toBe(0)
    expect(p.state.value.total).toBe(0)
  })

  describe('markFailed', () => {
    it('flips phase to failed + pins failedAt to the active phase', () => {
      const p = useAgentDistributeProgress()
      p.applyEvent({ stage: 'batchCreate', current: 1, total: 3 })
      p.markFailed()
      expect(p.state.value.phase).toBe('failed')
      expect(p.state.value.failedAt).toBe('escrows')
    })

    it('failedAt defaults to "start" for a pre-flight failure (phase still idle)', () => {
      // Pre-flight reverts (e.g. setOperator rejected) happen before
      // any onProgress event lands. The bar should still paint the
      // first phase red rather than show three pending circles.
      const p = useAgentDistributeProgress()
      p.markFailed()
      expect(p.state.value.phase).toBe('failed')
      expect(p.state.value.failedAt).toBe('start')
    })

    it('late onProgress after markFailed is ignored', () => {
      // Code Reviewer H-1 fix: once marked failed the bus is inert.
      // A late callback from the SDK (e.g. an in-flight encrypt
      // resolving after the catch ran) MUST NOT flip the bar back to
      // active and leave the user with a spinner over a failed run.
      const p = useAgentDistributeProgress()
      p.applyEvent({ stage: 'batchCreate', current: 1, total: 1 })
      p.markFailed()
      p.applyEvent({ stage: 'processBatch', current: 1, total: 1 })
      expect(p.state.value.phase).toBe('failed')
      expect(p.state.value.failedAt).toBe('escrows')
    })

    it('markSettled after markFailed is a no-op', () => {
      const p = useAgentDistributeProgress()
      p.applyEvent({ stage: 'processBatch', current: 1, total: 1 })
      p.markFailed()
      p.markSettled()
      expect(p.state.value.phase).toBe('failed')
    })
  })

  it('different composable callers see the same module-level state', () => {
    // Module-level singleton invariant — every call into the composable
    // returns the SAME reactive ref. Critical because the runner writes
    // from one component and the modal reads from another.
    const a = useAgentDistributeProgress()
    const b = useAgentDistributeProgress()
    a.applyEvent({ stage: 'processBatch', current: 7, total: 7 })
    expect(b.state.value.phase).toBe('fund')
    expect(b.state.value.current).toBe(7)
  })
})
