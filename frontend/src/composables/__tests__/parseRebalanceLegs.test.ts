/**
 * Unit tests for `parseRebalanceLegs` — the runner's re-validation of the
 * hash-bound `preview.legs` (mirror of dispatchActionTxs H-1/H-2). This is the
 * security gate that runs BEFORE the silent atomic UserOp, so it must reject
 * every tampered-descriptor shape.
 */
import { describe, it, expect } from 'vitest'
import { parseRebalanceLegs, MAX_REBALANCE_LEGS } from '@/composables/useAgentActionRunner'

const TOKEN = '0x8d77ccf0a3a56c976a7deae59af1d27f27407b0d'

describe('parseRebalanceLegs', () => {
  it('parses a valid sell+buy leg set', () => {
    const legs = parseRebalanceLegs([
      { kind: 'sell', tokenAddress: TOKEN, shares: '14', maxSharesHint: '14' },
      { kind: 'buy', tokenAddress: TOKEN, shares: '1' },
    ])
    expect(legs).toHaveLength(2)
    expect(legs[0]).toEqual({ kind: 'sell', tokenAddress: TOKEN, shares: 14n, maxSharesHint: 14n })
    // maxSharesHint defaults to shares when omitted.
    expect(legs[1]).toEqual({ kind: 'buy', tokenAddress: TOKEN, shares: 1n, maxSharesHint: 1n })
  })

  it('rejects an empty / non-array legs payload', () => {
    expect(() => parseRebalanceLegs([])).toThrow(/no legs/i)
    expect(() => parseRebalanceLegs(undefined)).toThrow(/no legs/i)
    expect(() => parseRebalanceLegs('legs')).toThrow(/no legs/i)
  })

  it('rejects more than MAX_REBALANCE_LEGS legs', () => {
    const many = Array.from({ length: MAX_REBALANCE_LEGS + 1 }, () => ({
      kind: 'buy',
      tokenAddress: TOKEN,
      shares: '1',
    }))
    expect(() => parseRebalanceLegs(many)).toThrow(/leg limit/i)
  })

  it('rejects an invalid kind (smuggled non-buy/sell selector)', () => {
    expect(() =>
      parseRebalanceLegs([{ kind: 'transfer', tokenAddress: TOKEN, shares: '1' }]),
    ).toThrow(/kind must be/i)
  })

  it('rejects a malformed token address', () => {
    expect(() =>
      parseRebalanceLegs([{ kind: 'buy', tokenAddress: '0xDEAD', shares: '1' }]),
    ).toThrow(/invalid tokenAddress/i)
  })

  it('rejects non-integer shares', () => {
    expect(() =>
      parseRebalanceLegs([{ kind: 'buy', tokenAddress: TOKEN, shares: '1.5' }]),
    ).toThrow(/positive integers/i)
  })

  it('rejects zero shares', () => {
    expect(() =>
      parseRebalanceLegs([{ kind: 'buy', tokenAddress: TOKEN, shares: '0' }]),
    ).toThrow(/must be > 0/i)
  })

  it('rejects shares greater than maxSharesHint', () => {
    expect(() =>
      parseRebalanceLegs([
        { kind: 'sell', tokenAddress: TOKEN, shares: '10', maxSharesHint: '5' },
      ]),
    ).toThrow(/> maxSharesHint/i)
  })
})
