import { describe, it, expect } from 'vitest'
import {
  isMhUsdcUnknown,
  isMhUsdcInsufficient,
  isBuyBlockedOnMhUsdc,
  type BuyGateInput,
} from '../tradeGate'

// mhUSDC is 6-dp; costs/balances are base units (1 USDC == 1_000_000n).
const $ = (n: number): bigint => BigInt(Math.round(n * 1e6))

describe('tradeGate — buy affordability (FHE pre-submit gate)', () => {
  describe('isMhUsdcUnknown', () => {
    it('is true in buy mode when balance is encrypted (null) and a cost is typed', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: $(100) }
      expect(isMhUsdcUnknown(i)).toBe(true)
    })

    it('is false when no cost is typed yet (estimatedCost null) — gate stays dormant', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: null }
      expect(isMhUsdcUnknown(i)).toBe(false)
    })

    it('is false once the balance is revealed', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(50), estimatedCost: $(100) }
      expect(isMhUsdcUnknown(i)).toBe(false)
    })

    it('is false in sell mode even with an encrypted balance', () => {
      const i: BuyGateInput = { mode: 'sell', mhUsdcBalance: null, estimatedCost: $(100) }
      expect(isMhUsdcUnknown(i)).toBe(false)
    })
  })

  describe('isMhUsdcInsufficient', () => {
    it('is true when the revealed balance is below the cost', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(50), estimatedCost: $(100) }
      expect(isMhUsdcInsufficient(i)).toBe(true)
    })

    it('is false when the revealed balance exactly covers the cost', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(100), estimatedCost: $(100) }
      expect(isMhUsdcInsufficient(i)).toBe(false)
    })

    it('is false when the revealed balance exceeds the cost', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(200), estimatedCost: $(100) }
      expect(isMhUsdcInsufficient(i)).toBe(false)
    })

    it('is false when the balance is still encrypted (unknown, not insufficient)', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: $(100) }
      expect(isMhUsdcInsufficient(i)).toBe(false)
    })

    it('is false in sell mode', () => {
      const i: BuyGateInput = { mode: 'sell', mhUsdcBalance: $(10), estimatedCost: $(100) }
      expect(isMhUsdcInsufficient(i)).toBe(false)
    })

    it('treats a revealed zero balance as insufficient against any positive cost', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: 0n, estimatedCost: $(1) }
      expect(isMhUsdcInsufficient(i)).toBe(true)
    })
  })

  describe('isBuyBlockedOnMhUsdc — the CTA-disabled union', () => {
    it('blocks while the balance is encrypted and a cost is typed (reveal first)', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: $(100) }
      expect(isBuyBlockedOnMhUsdc(i)).toBe(true)
    })

    it('stays blocked after revealing a short balance', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(40), estimatedCost: $(100) }
      expect(isBuyBlockedOnMhUsdc(i)).toBe(true)
    })

    it('unblocks after revealing a sufficient balance', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(120), estimatedCost: $(100) }
      expect(isBuyBlockedOnMhUsdc(i)).toBe(false)
    })

    it('does not block before any amount is typed', () => {
      const i: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: null }
      expect(isBuyBlockedOnMhUsdc(i)).toBe(false)
    })

    it('never blocks in sell mode', () => {
      expect(
        isBuyBlockedOnMhUsdc({ mode: 'sell', mhUsdcBalance: null, estimatedCost: $(100) }),
      ).toBe(false)
      expect(
        isBuyBlockedOnMhUsdc({ mode: 'sell', mhUsdcBalance: $(1), estimatedCost: $(100) }),
      ).toBe(false)
    })
  })

  // Exercises the full operator-reported lifecycle: encrypted → block;
  // reveal-short → still block; reveal-sufficient → allow.
  it('models the reveal lifecycle: unknown → (reveal short) blocked → (reveal enough) allowed', () => {
    const cost = $(100)
    const encrypted: BuyGateInput = { mode: 'buy', mhUsdcBalance: null, estimatedCost: cost }
    expect(isMhUsdcUnknown(encrypted)).toBe(true)
    expect(isBuyBlockedOnMhUsdc(encrypted)).toBe(true)

    const revealedShort: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(60), estimatedCost: cost }
    expect(isMhUsdcUnknown(revealedShort)).toBe(false)
    expect(isMhUsdcInsufficient(revealedShort)).toBe(true)
    expect(isBuyBlockedOnMhUsdc(revealedShort)).toBe(true)

    const revealedEnough: BuyGateInput = { mode: 'buy', mhUsdcBalance: $(140), estimatedCost: cost }
    expect(isBuyBlockedOnMhUsdc(revealedEnough)).toBe(false)
  })
})
