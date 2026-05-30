/**
 * Unit tests for the PURE rebalance drift math (`buildRebalancePlan`).
 *
 * The chain/decrypt gathering in `computeRebalancePlan` is exercised by the
 * live walkthrough; the math that decides legs (weights → drift → minimal
 * sell/buy legs, dust filter, exclusion renormalisation, MAX_LEGS cap,
 * sells-before-buys ordering, already-balanced short-circuit) is isolated here.
 */
import { describe, it, expect } from 'vitest'
import {
  buildRebalancePlan,
  applyExecutionConstraints,
  MIN_LEG_USD,
  MAX_LEGS,
  type RebalanceTokenInput,
  type RebalancePlan,
  type LegExecutionConstraint,
} from '@/composables/useRebalance'

let addrSeq = 0
function addr(): `0x${string}` {
  addrSeq += 1
  return `0x${addrSeq.toString(16).padStart(40, '0')}` as `0x${string}`
}

function input(
  o: Partial<RebalanceTokenInput> & { targetBps: number },
): RebalanceTokenInput {
  // NB: preserve EXPLICIT null for navUsd / balanceShares (the exclusion
  // signals) — `??` would coalesce null away to the default.
  return {
    tokenAddress: o.tokenAddress ?? addr(),
    symbol: o.symbol ?? 'TKN',
    navUsd: 'navUsd' in o ? (o.navUsd as number | null) : 1,
    balanceShares: 'balanceShares' in o ? (o.balanceShares as bigint | null) : 0n,
    targetBps: o.targetBps,
  }
}

describe('buildRebalancePlan', () => {
  it('returns "balanced" when max drift is within tolerance', () => {
    const a = input({ symbol: 'A', navUsd: 1, balanceShares: 60n, targetBps: 6000 })
    const b = input({ symbol: 'B', navUsd: 1, balanceShares: 40n, targetBps: 4000 })
    const plan = buildRebalancePlan(500, [a, b])
    expect(plan.status).toBe('balanced')
    if (plan.status === 'balanced') {
      expect(plan.maxDriftBps).toBe(0)
    }
  })

  it('produces sell + buy legs for a drifted portfolio, sells first', () => {
    const a = input({ symbol: 'A', navUsd: 1, balanceShares: 80n, targetBps: 5000 })
    const b = input({ symbol: 'B', navUsd: 1, balanceShares: 20n, targetBps: 5000 })
    const plan = buildRebalancePlan(500, [a, b])
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs).toHaveLength(2)
    // Sells ordered before buys.
    expect(plan.legs[0].kind).toBe('sell')
    expect(plan.legs[1].kind).toBe('buy')
    // A is overweight ($80 of $100, target $50) → sell ~30 shares.
    expect(plan.legs[0].symbol).toBe('A')
    expect(plan.legs[0].shares).toBe('30')
    // B is underweight → buy ~30 shares.
    expect(plan.legs[1].symbol).toBe('B')
    expect(plan.legs[1].shares).toBe('30')
    expect(plan.truncated).toBe(0)
    expect(plan.excluded).toHaveLength(0)
  })

  it('floors share counts (conservative — never overspends/over-requests)', () => {
    // nav 3 so deltas don't divide evenly. A: $90 (30 sh), B: $10 (≈3.33 sh).
    const a = input({ symbol: 'A', navUsd: 3, balanceShares: 30n, targetBps: 5000 })
    const b = input({ symbol: 'B', navUsd: 3, balanceShares: 4n, targetBps: 5000 })
    // total = $90 + $12 = $102; target each $51. A delta = 51-90 = -39 → sell 13.
    // B delta = 51-12 = +39 → buy 13.
    const plan = buildRebalancePlan(300, [a, b])
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    const sell = plan.legs.find((l) => l.symbol === 'A')!
    const buy = plan.legs.find((l) => l.symbol === 'B')!
    expect(sell.kind).toBe('sell')
    expect(Number(sell.shares)).toBe(Math.floor(39 / 3)) // 13
    expect(buy.kind).toBe('buy')
    expect(Number(buy.shares)).toBe(Math.floor(39 / 3)) // 13
  })

  it('short-circuits to "balanced" when drift exceeds tolerance but legs are sub-dust', () => {
    // Cheap tokens: $0.01/share. Tiny drift (>tolerance) but every leg < $1.
    const a = input({ symbol: 'A', navUsd: 0.01, balanceShares: 5000n, targetBps: 5000 })
    const b = input({ symbol: 'B', navUsd: 0.01, balanceShares: 4950n, targetBps: 5000 })
    // total ≈ $99.50; deltas ≈ ±$0.25 < MIN_LEG_USD.
    const plan = buildRebalancePlan(10, [a, b])
    expect(MIN_LEG_USD).toBeGreaterThan(0.25)
    expect(plan.status).toBe('balanced')
  })

  it('returns "no_value" when the included portfolio has zero value', () => {
    const a = input({ symbol: 'A', navUsd: 1, balanceShares: 0n, targetBps: 10000 })
    const plan = buildRebalancePlan(500, [a])
    expect(plan.status).toBe('no_value')
  })

  it('excludes a token whose balance could not be read + renormalises the rest', () => {
    const a = input({ symbol: 'A', navUsd: 1, balanceShares: 80n, targetBps: 3000 })
    const c = input({ symbol: 'C', navUsd: 1, balanceShares: 20n, targetBps: 3000 })
    // B excluded (balance unreadable). Its 4000bps target is dropped and
    // A/C renormalise to 50/50 over the $100 included value.
    const b = input({ symbol: 'B', navUsd: 1, balanceShares: null, targetBps: 4000 })
    const plan = buildRebalancePlan(500, [a, b, c])
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.excluded.map((r) => r.symbol)).toEqual(['B'])
    // A ($80) overweight vs renorm target $50 → sell; C ($20) → buy.
    const sell = plan.legs.find((l) => l.symbol === 'A')!
    const buy = plan.legs.find((l) => l.symbol === 'C')!
    expect(sell.kind).toBe('sell')
    expect(buy.kind).toBe('buy')
  })

  it('also excludes a token with no NAV', () => {
    const a = input({ symbol: 'A', navUsd: 1, balanceShares: 100n, targetBps: 5000 })
    const b = input({ symbol: 'B', navUsd: null, balanceShares: 50n, targetBps: 5000 })
    const plan = buildRebalancePlan(500, [a, b])
    // Only A included → it's 100% of value, renorm target 100% → balanced.
    expect(plan.status === 'balanced' || plan.status === 'legs').toBe(true)
    const excludedSymbols =
      plan.status === 'legs' ? plan.excluded.map((r) => r.symbol) : []
    if (plan.status === 'legs') expect(excludedSymbols).toContain('B')
  })

  it('caps legs at MAX_LEGS and reports the truncation count', () => {
    // 10 tokens, each meaningfully over/underweight → 10 candidate legs.
    const inputs: RebalanceTokenInput[] = []
    for (let i = 0; i < 10; i++) {
      // Alternate heavy/light balances so half are sells, half buys.
      const balance = i % 2 === 0 ? 200n : 0n
      inputs.push(input({ symbol: `T${i}`, navUsd: 1, balanceShares: balance, targetBps: 1000 }))
    }
    const plan = buildRebalancePlan(100, inputs)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs.length).toBeLessThanOrEqual(MAX_LEGS)
    expect(plan.legs.length + plan.truncated).toBe(10)
    expect(plan.truncated).toBe(10 - MAX_LEGS)
  })
})

describe('applyExecutionConstraints', () => {
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)

  function legsPlan(
    legs: Extract<RebalancePlan, { status: 'legs' }>['legs'],
  ): Extract<RebalancePlan, { status: 'legs' }> {
    return {
      status: 'legs',
      legs,
      rows: [],
      maxDriftBps: 3000,
      toleranceBps: 500,
      excluded: [],
      truncated: 0,
      belowMin: [],
    }
  }

  const sellLeg = {
    kind: 'sell' as const,
    tokenAddress: A as `0x${string}`,
    symbol: 'A',
    shares: '30',
    maxSharesHint: '30',
    estValueUsd: 30,
  }
  const buyLeg = {
    kind: 'buy' as const,
    tokenAddress: B as `0x${string}`,
    symbol: 'B',
    shares: '30',
    maxSharesHint: '30',
    estValueUsd: 30,
  }

  it('passes legs through untouched when all constraints are satisfied', () => {
    // Generous cap, zero minInvestment → nothing binds. (NB: in production
    // computeRebalancePlan ALWAYS populates a constraint per leg; an EMPTY map
    // for a sell+buy is the M-2 unknown-cap case and correctly refuses.)
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 1_000_000_000n }],
      [B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs).toHaveLength(2)
    expect(plan.belowMin).toEqual([])
  })

  it('drops a leg below the token minInvestment + records it in belowMin', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 100n, instantCapRemainingBase6: null }], // 30 < 100 → drop
      [B.toLowerCase(), { minInvestmentShares: 1n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.belowMin).toEqual(['A'])
    expect(plan.legs.map((l) => l.symbol)).toEqual(['B'])
  })

  it('refuses the mixed batch when a sell would escalate to the queue', () => {
    // Sell A costs $30 = 30_000_000 base-6; remaining cap is only 10_000_000.
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 10_000_000n }],
      [B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    expect(plan.status).toBe('sell_exceeds_instant')
    if (plan.status === 'sell_exceeds_instant') {
      expect(plan.tokens).toEqual(['A'])
    }
  })

  it('allows a queue-escalating sell when there are NO buys (sell queues safely)', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 10_000_000n }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg]), c)
    expect(plan.status).toBe('legs') // no dependent buys → fine to queue
  })

  it('returns "all_below_min" (NOT balanced) when minInvestment drops every leg', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 1000n, instantCapRemainingBase6: null }],
      [B.toLowerCase(), { minInvestmentShares: 1000n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    // Drift exceeded tolerance — must NOT claim "balanced" (CR M-1).
    expect(plan.status).toBe('all_below_min')
    if (plan.status === 'all_below_min') {
      expect(plan.belowMin.sort()).toEqual(['A', 'B'])
      expect(plan.maxDriftBps).toBe(3000)
    }
  })

  it('treats an UNKNOWN sell cap as would-escalate when buys are present (CR M-2)', () => {
    // Cap read failed for the sell (null) while a buy leg is present → refuse
    // the mixed batch rather than risk a silent half-trade.
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
      [B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    expect(plan.status).toBe('sell_exceeds_instant')
    if (plan.status === 'sell_exceeds_instant') expect(plan.tokens).toEqual(['A'])
  })

  it('an UNKNOWN sell cap with NO buys still proceeds (sell queues safely)', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg]), c)
    expect(plan.status).toBe('legs')
  })

  it('does not flag escalation when the sell fits within the remaining cap', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 100_000_000n }], // $100 ≥ $30
      [B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyExecutionConstraints(legsPlan([sellLeg, buyLeg]), c)
    expect(plan.status).toBe('legs')
  })
})
