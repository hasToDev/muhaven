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
  applyMinInvestmentConstraints,
  applyEscalationCheck,
  applyBudgetConstraints,
  MIN_LEG_USD,
  MAX_LEGS,
  type RebalanceTokenInput,
  type RebalancePlan,
  type RebalanceLeg,
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

  it('refuses a sell-only plan when an underweight target is too small to buy a whole share (operator NVDAon case)', () => {
    // CETES $100 (overweight), NVDAon target 50% but 1 share = $500 → its $50
    // allocation buys 0 whole shares → the only leg would be a pointless CETES
    // sell. Must surface cannot_deploy, NOT a "Sell CETES" plan.
    const cetes = input({ symbol: 'CETES', navUsd: 1, balanceShares: 100n, targetBps: 5000 })
    const nvdaon = input({ symbol: 'NVDAon', navUsd: 500, balanceShares: 0n, targetBps: 5000 })
    const plan = buildRebalancePlan(500, [cetes, nvdaon])
    expect(plan.status).toBe('cannot_deploy')
    if (plan.status === 'cannot_deploy') expect(plan.tokens).toEqual(['NVDAon'])
  })
})

const CONSTRAINT_A = '0x' + 'a'.repeat(40)
const CONSTRAINT_B = '0x' + 'b'.repeat(40)

function constraintLegsPlan(
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
    unaffordable: [],
  }
}
const csSell = {
  kind: 'sell' as const,
  tokenAddress: CONSTRAINT_A as `0x${string}`,
  symbol: 'A',
  shares: '30',
  maxSharesHint: '30',
  estValueUsd: 30,
}
const csBuy = {
  kind: 'buy' as const,
  tokenAddress: CONSTRAINT_B as `0x${string}`,
  symbol: 'B',
  shares: '30',
  maxSharesHint: '30',
  estValueUsd: 30,
}

describe('applyMinInvestmentConstraints', () => {
  it('passes legs through when nothing is below minInvestment', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyMinInvestmentConstraints(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs).toHaveLength(2)
    expect(plan.belowMin).toEqual([])
  })

  it('drops a leg below the token minInvestment + records it in belowMin', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 100n, instantCapRemainingBase6: null }], // 30 < 100
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 1n, instantCapRemainingBase6: null }],
    ])
    const plan = applyMinInvestmentConstraints(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.belowMin).toEqual(['A'])
    expect(plan.legs.map((l) => l.symbol)).toEqual(['B'])
  })

  it('returns "all_below_min" (NOT balanced) when minInvestment drops every leg', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 1000n, instantCapRemainingBase6: null }],
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 1000n, instantCapRemainingBase6: null }],
    ])
    const plan = applyMinInvestmentConstraints(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('all_below_min')
    if (plan.status === 'all_below_min') {
      expect(plan.belowMin.sort()).toEqual(['A', 'B'])
      expect(plan.maxDriftBps).toBe(3000)
    }
  })
})

describe('applyEscalationCheck', () => {
  it('refuses the mixed batch when a sell would escalate to the queue', () => {
    // Sell A costs $30 = 30_000_000 base-6; remaining cap is only 10_000_000.
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 10_000_000n }],
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyEscalationCheck(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('sell_exceeds_instant')
    if (plan.status === 'sell_exceeds_instant') expect(plan.tokens).toEqual(['A'])
  })

  it('allows a queue-escalating sell when there are NO buys (sell queues safely)', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 10_000_000n }],
    ])
    const plan = applyEscalationCheck(constraintLegsPlan([csSell]), c)
    expect(plan.status).toBe('legs')
  })

  it('treats an UNKNOWN sell cap as would-escalate when buys are present (CR M-2)', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyEscalationCheck(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('sell_exceeds_instant')
    if (plan.status === 'sell_exceeds_instant') expect(plan.tokens).toEqual(['A'])
  })

  it('an UNKNOWN sell cap with NO buys still proceeds (sell queues safely)', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyEscalationCheck(constraintLegsPlan([csSell]), c)
    expect(plan.status).toBe('legs')
  })

  it('does not flag escalation when the sell fits within the remaining cap', () => {
    const c = new Map<string, LegExecutionConstraint>([
      [CONSTRAINT_A.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 100_000_000n }],
      [CONSTRAINT_B.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const plan = applyEscalationCheck(constraintLegsPlan([csSell, csBuy]), c)
    expect(plan.status).toBe('legs')
  })
})

describe('applyBudgetConstraints', () => {
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)
  const C = '0x' + 'c'.repeat(40)

  function legsPlan(legs: RebalanceLeg[]): Extract<RebalancePlan, { status: 'legs' }> {
    return {
      status: 'legs',
      legs,
      rows: [],
      maxDriftBps: 3000,
      toleranceBps: 500,
      excluded: [],
      truncated: 0,
      belowMin: [],
      unaffordable: [],
    }
  }
  const sell = (sym: string, addr: string, usd: number): RebalanceLeg => ({
    kind: 'sell',
    tokenAddress: addr as `0x${string}`,
    symbol: sym,
    shares: '1',
    maxSharesHint: '1',
    estValueUsd: usd,
  })
  const buy = (sym: string, addr: string, usd: number): RebalanceLeg => ({
    ...sell(sym, addr, usd),
    kind: 'buy',
  })

  it('passes buys through when sell proceeds cover them (with headroom)', () => {
    // sell A $30 (proceeds ~$29.97 after haircut) funds buy B $29 (cash 0).
    const plan = applyBudgetConstraints(legsPlan([sell('A', A, 30), buy('B', B, 29)]), 0n)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs.map((l) => l.symbol)).toEqual(['A', 'B'])
    expect(plan.unaffordable).toEqual([])
  })

  it('skips an exactly-at-proceeds buy via the haircut while a partial rebalance proceeds (CR L-1)', () => {
    // sell A $30 → proceeds haircut to $29.97. Buy B $30 is exactly-at-proceeds
    // → skipped (would under-fund on-chain). Buy C $5 still fits → kept.
    const plan = applyBudgetConstraints(legsPlan([sell('A', A, 30), buy('B', B, 30), buy('C', C, 5)]), 0n)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs.map((l) => l.symbol)).toEqual(['A', 'C'])
    expect(plan.unaffordable).toEqual(['B'])
  })

  it('skips a buy the budget cannot fund (the operator TSLAx case)', () => {
    // No sells, cash $0 → buy B $30 unaffordable. Only-buys → insufficient_funds.
    const plan = applyBudgetConstraints(legsPlan([buy('B', B, 30)]), 0n)
    expect(plan.status).toBe('insufficient_funds')
    if (plan.status === 'insufficient_funds') expect(plan.tokens).toEqual(['B'])
  })

  it('funds buys from existing mhUSDC when there are no sells', () => {
    // $30 cash funds the $30 buy.
    const plan = applyBudgetConstraints(legsPlan([buy('B', B, 30)]), 30_000_000n)
    expect(plan.status).toBe('legs')
  })

  it('funds the largest-impact buy first and skips the rest when budget is tight', () => {
    // sell A $30 → budget ~$29.97. Two buys: B $25, C $20 → keep B (bigger,
    // leaves ~$4.97), skip C ($20 > $4.97).
    const plan = applyBudgetConstraints(
      legsPlan([sell('A', A, 30), buy('B', B, 25), buy('C', C, 20)]),
      0n,
    )
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs.map((l) => l.symbol)).toEqual(['A', 'B'])
    expect(plan.unaffordable).toEqual(['C'])
  })

  it('refuses (insufficient_funds, NOT a pointless sell) when ALL buys are unaffordable', () => {
    // The operator's NVDAon case: sell A $10, buy B $30. Even with A's proceeds
    // the buy is unaffordable → there's NO reason to sell A. Surface the
    // shortfall instead of proposing a sell-only batch.
    const plan = applyBudgetConstraints(legsPlan([sell('A', A, 10), buy('B', B, 30)]), 0n)
    expect(plan.status).toBe('insufficient_funds')
    if (plan.status === 'insufficient_funds') expect(plan.tokens).toEqual(['B'])
  })

  it('is a no-op when there are no buys', () => {
    const plan = applyBudgetConstraints(legsPlan([sell('A', A, 30)]), 0n)
    expect(plan.status).toBe('legs')
    if (plan.status !== 'legs') return
    expect(plan.legs).toHaveLength(1)
  })
})

describe('pipeline ordering (minInvestment → budget → escalation)', () => {
  const CETES = '0x' + 'a'.repeat(40)
  const NVDAON = '0x' + 'd'.repeat(40)
  function plan(legs: RebalanceLeg[]): Extract<RebalancePlan, { status: 'legs' }> {
    return {
      status: 'legs',
      legs,
      rows: [],
      maxDriftBps: 3000,
      toleranceBps: 500,
      excluded: [],
      truncated: 0,
      belowMin: [],
      unaffordable: [],
    }
  }
  const sellCetes: RebalanceLeg = {
    kind: 'sell',
    tokenAddress: CETES as `0x${string}`,
    symbol: 'CETES',
    shares: '30',
    maxSharesHint: '30',
    estValueUsd: 30,
  }
  const buyNvdaon: RebalanceLeg = {
    kind: 'buy',
    tokenAddress: NVDAON as `0x${string}`,
    symbol: 'NVDAon',
    shares: '1',
    maxSharesHint: '1',
    estValueUsd: 500, // 1 share = $500, far above the $30 CETES proceeds
  }

  it('an unaffordable buy yields insufficient_funds — NOT "sell CETES first" (operator 2026-05-30)', () => {
    // CETES sell WOULD escalate (cap $10 < cost $30), so the OLD order would
    // have returned sell_exceeds_instant ("sell CETES first") — pointless,
    // because NVDAon ($500) is unaffordable even with the proceeds. With budget
    // BEFORE escalation, we instead surface insufficient_funds.
    const constraints = new Map<string, LegExecutionConstraint>([
      [CETES.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: 10_000_000n }],
      [NVDAON.toLowerCase(), { minInvestmentShares: 0n, instantCapRemainingBase6: null }],
    ])
    const p0 = plan([sellCetes, buyNvdaon])
    const p1 = applyMinInvestmentConstraints(p0, constraints)
    expect(p1.status).toBe('legs')
    if (p1.status !== 'legs') return
    const p2 = applyBudgetConstraints(p1, 0n) // no cash, only $30 sell proceeds
    expect(p2.status).toBe('insufficient_funds')
    if (p2.status === 'insufficient_funds') expect(p2.tokens).toEqual(['NVDAon'])
    // Escalation never runs because p2 isn't a legs plan → no "sell CETES first".
  })
})
