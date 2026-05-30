/** Unit tests for the pure rebalance copy helpers. */
import { describe, it, expect } from 'vitest'
import {
  bpsToPct,
  rebalanceLegsSummary,
  describeRebalancePlanShortfall,
  rebalanceNotices,
} from '@/composables/useRebalanceCopy'
import type { RebalancePlan, RebalanceLeg, RebalanceDriftRow } from '@/composables/useRebalance'

const leg = (o: Partial<RebalanceLeg>): RebalanceLeg => ({
  kind: o.kind ?? 'buy',
  tokenAddress: o.tokenAddress ?? ('0x' + '0'.repeat(40)) as `0x${string}`,
  symbol: o.symbol ?? 'TKN',
  shares: o.shares ?? '1',
  maxSharesHint: o.maxSharesHint ?? '1',
  estValueUsd: o.estValueUsd ?? 1,
})

describe('bpsToPct', () => {
  it('formats whole percents without decimals', () => {
    expect(bpsToPct(500)).toBe('5%')
    expect(bpsToPct(10000)).toBe('100%')
    expect(bpsToPct(0)).toBe('0%')
  })
  it('keeps up to two decimals', () => {
    expect(bpsToPct(1234)).toBe('12.34%')
    expect(bpsToPct(50)).toBe('0.5%')
  })
})

describe('rebalanceLegsSummary', () => {
  it('renders sells and buys with shares + symbol', () => {
    const s = rebalanceLegsSummary([
      leg({ kind: 'sell', shares: '14', symbol: 'CETES' }),
      leg({ kind: 'buy', shares: '1', symbol: 'USTBL' }),
    ])
    expect(s).toBe('Sell 14 CETES · Buy 1 USTBL')
  })
})

describe('describeRebalancePlanShortfall', () => {
  it('returns null for a legs plan (modal handles it)', () => {
    const plan: RebalancePlan = {
      status: 'legs',
      legs: [leg({})],
      rows: [],
      maxDriftBps: 1000,
      toleranceBps: 500,
      excluded: [],
      truncated: 0,
      belowMin: [],
    }
    expect(describeRebalancePlanShortfall(plan)).toBeNull()
  })

  it('maps no_targets to an info nudge', () => {
    const r = describeRebalancePlanShortfall({ status: 'no_targets' })
    expect(r?.severity).toBe('info')
    expect(r?.title).toMatch(/target allocations/i)
  })

  it('maps balanced to success with both percentages', () => {
    const r = describeRebalancePlanShortfall({
      status: 'balanced',
      rows: [],
      maxDriftBps: 200,
      toleranceBps: 500,
    })
    expect(r?.severity).toBe('success')
    expect(r?.description).toContain('2%')
    expect(r?.description).toContain('5%')
  })

  it('maps all_below_min to a truthful info nudge (drifted, not "balanced")', () => {
    const r = describeRebalancePlanShortfall({
      status: 'all_below_min',
      belowMin: ['CETES'],
      maxDriftBps: 3000,
      toleranceBps: 500,
    })
    expect(r?.severity).toBe('info')
    expect(r?.title).not.toMatch(/balanced/i)
    expect(r?.description).toContain('30%')
    expect(r?.description).toContain('CETES')
    expect(r?.description).toMatch(/minimum investment/i)
  })

  it('maps sell_exceeds_instant to an actionable info nudge naming the token', () => {
    const r = describeRebalancePlanShortfall({
      status: 'sell_exceeds_instant',
      tokens: ['CETES'],
    })
    expect(r?.severity).toBe('info')
    expect(r?.description).toContain('CETES')
    expect(r?.description).toMatch(/queue|instant/i)
  })

  it('maps no_value + error to their reasons', () => {
    expect(describeRebalancePlanShortfall({ status: 'no_value', reason: 'nope' })).toMatchObject({
      severity: 'info',
      description: 'nope',
    })
    expect(describeRebalancePlanShortfall({ status: 'error', reason: 'boom' })).toMatchObject({
      severity: 'error',
      description: 'boom',
    })
  })
})

describe('rebalanceNotices', () => {
  const row = (symbol: string): RebalanceDriftRow => ({
    tokenAddress: ('0x' + '0'.repeat(40)) as `0x${string}`,
    symbol,
    navUsd: 1,
    balanceShares: null,
    valueUsd: 0,
    currentBps: 0,
    targetBps: 0,
    driftBps: 0,
    excluded: true,
  })

  it('flags excluded tokens', () => {
    const notes = rebalanceNotices({
      status: 'legs',
      legs: [leg({})],
      rows: [],
      maxDriftBps: 1000,
      toleranceBps: 500,
      excluded: [row('CETES'), row('GOLD1')],
      truncated: 0,
      belowMin: [],
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('CETES, GOLD1')
  })

  it('flags legs skipped below minimum investment (belowMin)', () => {
    const notes = rebalanceNotices({
      status: 'legs',
      legs: [leg({})],
      rows: [],
      maxDriftBps: 1000,
      toleranceBps: 500,
      excluded: [],
      truncated: 0,
      belowMin: ['TBILL1'],
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('TBILL1')
    expect(notes[0]).toMatch(/minimum investment/i)
  })

  it('flags leg-cap truncation', () => {
    const notes = rebalanceNotices({
      status: 'legs',
      legs: [leg({}), leg({})],
      rows: [],
      maxDriftBps: 1000,
      toleranceBps: 500,
      excluded: [],
      truncated: 3,
      belowMin: [],
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('3 smaller adjustment')
  })

  it('returns no notices for a clean plan', () => {
    expect(
      rebalanceNotices({
        status: 'legs',
        legs: [leg({})],
        rows: [],
        maxDriftBps: 1000,
        toleranceBps: 500,
        excluded: [],
        truncated: 0,
        belowMin: [],
      }),
    ).toEqual([])
  })
})
