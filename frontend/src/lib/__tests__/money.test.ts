import { describe, it, expect } from 'vitest'
import { formatMhUsdcBigInt } from '@/lib/money'

describe('formatMhUsdcBigInt', () => {
  describe('default options (minFrac=2, maxFrac=6)', () => {
    it('formats zero with USD convention', () => {
      expect(formatMhUsdcBigInt(0n)).toBe('0.00')
    })

    it('preserves single base unit (sub-cent precision)', () => {
      expect(formatMhUsdcBigInt(1n)).toBe('0.000001')
    })

    it('formats one whole dollar', () => {
      expect(formatMhUsdcBigInt(1_000_000n)).toBe('1.00')
    })

    it('strips trailing zeros down to minFrac=2', () => {
      expect(formatMhUsdcBigInt(15_500_000n)).toBe('15.50')
    })

    it('keeps non-trailing zeros (sub-cent precision triggers)', () => {
      expect(formatMhUsdcBigInt(1_005_000n)).toBe('1.005')
      expect(formatMhUsdcBigInt(1_000_100n)).toBe('1.0001')
    })

    it('preserves precision above Number.MAX_SAFE_INTEGER / 1e6 (~9.007e9)', () => {
      // The whole bug we are paying down: `Number(99e15) / 1e6` loses precision.
      // $99 billion mhUSDC = 99_000_000_000_000_000 base units → 99,000,000,000.00
      expect(formatMhUsdcBigInt(99_000_000_000_000_000n)).toBe('99,000,000,000.00')
    })

    it('survives the prior toFixed(2) failure mode well past MAX_SAFE_INTEGER', () => {
      // 10_000_000_000.50 USD = 10_000_000_000_500_000 base units. That
      // input is still representable as a Number (within ~1e16), so the
      // legacy Number-coerce path happens to round to the same digits at
      // 2 decimal places. The real precision loss surfaces well above
      // Number.MAX_SAFE_INTEGER, in BOTH the integer AND fractional digits.
      expect(formatMhUsdcBigInt(10_000_000_000_500_000n)).toBe('10,000,000,000.50')
      // 9_007_199_254_740_993 is one above Number.MAX_SAFE_INTEGER (the
      // canonical first-loss-of-precision sentinel). The BigInt formatter
      // preserves the trailing 3; Number(9007199254740993n) rounds to
      // 9007199254740992 (lost the bottom digit).
      expect(formatMhUsdcBigInt(9_007_199_254_740_993n, { maxFractionDigits: 6 })).toBe(
        '9,007,199,254.740993',
      )
      // Sanity check the precision claim against the legacy Number-coerce
      // path: it loses the trailing 3 (rounds to ...992 / 1e6). Render
      // both as strings to bypass the parser's own MAX_SAFE_INTEGER coerce
      // on numeric literals.
      const legacyPath = (Number(9_007_199_254_740_993n) / 1_000_000).toFixed(6)
      expect(legacyPath).toBe('9007199254.740992')
    })
  })

  describe('thousands separators (UX-H1)', () => {
    // Dashboard convention is `toLocaleString('en-US')` → commas every 3
    // digits in the WHOLE part only. Per UX review on this diff: institutional
    // scale numbers ("$99 billion") must read with commas to be parseable
    // next to dashboard cards that already render that way via formatUSD.
    it('comma-groups four-digit whole parts', () => {
      expect(formatMhUsdcBigInt(1_234_000_000n)).toBe('1,234.00')
    })
    it('comma-groups seven-digit whole parts', () => {
      expect(formatMhUsdcBigInt(1_234_567_000_000n)).toBe('1,234,567.00')
    })
    it('comma-groups while preserving sub-cent precision', () => {
      expect(formatMhUsdcBigInt(1_234_567_000_001n)).toBe('1,234,567.000001')
    })
    it('places minus before $ before grouped whole part', () => {
      expect(formatMhUsdcBigInt(-1_234_567_000_000n, { withSign: true })).toBe(
        '-$1,234,567.00',
      )
    })
  })

  describe('signed prefix', () => {
    it('prefixes $ when withSign=true', () => {
      expect(formatMhUsdcBigInt(1_500_000n, { withSign: true })).toBe('$1.50')
    })

    it('places minus before $ for negatives (USD convention)', () => {
      expect(formatMhUsdcBigInt(-1_500_000n, { withSign: true })).toBe('-$1.50')
    })

    it('handles negative without sign', () => {
      expect(formatMhUsdcBigInt(-1_500_000n)).toBe('-1.50')
    })
  })

  describe('precision overrides', () => {
    it('respects minFractionDigits=6 for the totalYield-too-small error', () => {
      // useAgentActionRunner.ts:746 — minTotalYield base units rendered
      // with .toFixed(6). For supply=1, minTotalYield=1 base unit:
      expect(formatMhUsdcBigInt(1n, { minFractionDigits: 6 })).toBe('0.000001')
    })

    it('respects minFractionDigits=0 (compact display)', () => {
      expect(formatMhUsdcBigInt(1_000_000n, { minFractionDigits: 0 })).toBe('1')
      expect(formatMhUsdcBigInt(1_500_000n, { minFractionDigits: 0 })).toBe('1.5')
    })

    it('truncates (not rounds) when maxFractionDigits cuts the tail', () => {
      // 1.000_001 → truncate to 2 digits → "1.00", NOT "1.01"
      expect(formatMhUsdcBigInt(1_000_001n, { maxFractionDigits: 2 })).toBe('1.00')
      // 1.999_999 → truncate to 2 digits → "1.99", NOT "2.00"
      expect(formatMhUsdcBigInt(1_999_999n, { maxFractionDigits: 2 })).toBe('1.99')
    })

    it('clamps minFrac > maxFrac to maxFrac', () => {
      // Caller passes incoherent min=4, max=2 → effective min=2
      expect(formatMhUsdcBigInt(1_000_000n, { minFractionDigits: 4, maxFractionDigits: 2 })).toBe('1.00')
    })

    it('clamps out-of-range fraction digits sanely', () => {
      // Negative / NaN min → treated as 0
      expect(formatMhUsdcBigInt(1_500_000n, { minFractionDigits: -3 })).toBe('1.5')
      // Excessive max (> 6) → clamped to 6
      expect(formatMhUsdcBigInt(1n, { maxFractionDigits: 18 })).toBe('0.000001')
    })
  })

  describe('string input', () => {
    it('accepts numeric strings', () => {
      expect(formatMhUsdcBigInt('1500000')).toBe('1.50')
    })

    it('accepts negative numeric strings', () => {
      expect(formatMhUsdcBigInt('-1500000')).toBe('-1.50')
    })

    it('falls back to "0" on malformed input (template-render-safe)', () => {
      // Calling sites are inside Vue templates; throwing would crash the
      // chat surface. Garbage in → "0.00" out matches `displayUsd`'s
      // catch-and-fallback historical behavior.
      expect(formatMhUsdcBigInt('not-a-number')).toBe('0.00')
      expect(formatMhUsdcBigInt('1.5')).toBe('0.00')
    })

    it('preserves withSign on malformed input (consistent with downstream rendering)', () => {
      // Callers like ConfirmModal's displayUsd pass `{withSign:true}` —
      // if garbage slips through it should still render with `$` so the
      // visual format stays consistent ("$0.00", not bare "0.00").
      expect(formatMhUsdcBigInt('not-a-number', { withSign: true })).toBe('$0.00')
    })

    it('renders zero with sign cleanly', () => {
      expect(formatMhUsdcBigInt(0n, { withSign: true })).toBe('$0.00')
    })
  })
})
