/**
 * Unit tests for the in-package decimal helpers used by the 0.2.1
 * `positionBuy` mhUSDC→shares conversion. Pure functions, no IO.
 *
 * Mirrors the backend's `parseDecimalToUsd6` test cases so the two
 * implementations stay behaviourally equivalent (round-trip via the
 * same string-parsing recipe).
 */
import { describe, expect, it } from 'vitest';
import {
  computeSharesFromUsd6,
  formatUsd6AsDecimal,
  parseDecimalToUsd6,
} from '../src/tools/decimal.js';

describe('parseDecimalToUsd6', () => {
  it.each([
    ['1', 1_000_000n],
    ['1.0', 1_000_000n],
    ['1.000000', 1_000_000n],
    ['0', 0n],
    ['0.5', 500_000n],
    ['0.01', 10_000n],
    ['0.123456', 123_456n],
    ['2400.5', 2_400_500_000n],
    ['100', 100_000_000n],
  ])('parses %s → %s base units', (input, expected) => {
    expect(parseDecimalToUsd6(input)).toBe(expected);
  });

  it('truncates fractional past 6 dp (no rounding — never over-report)', () => {
    expect(parseDecimalToUsd6('0.1234567')).toBe(123_456n);
    expect(parseDecimalToUsd6('0.999999999')).toBe(999_999n);
  });

  it.each([
    [''],
    ['abc'],
    ['1e6'],
    ['-1'],
    ['+1'],
    ['1.0.0'],
    [' 1.0'],
    ['1.0 '],
    ['1,000'],
    ['.5'],
    ['5.'],
  ])('rejects %s', (input) => {
    expect(() => parseDecimalToUsd6(input)).toThrow();
  });
});

describe('computeSharesFromUsd6', () => {
  it('floor-divides cleanly when notional is a clean multiple of NAV', () => {
    // 5 mhUSDC at NAV $1 → 5 shares
    expect(computeSharesFromUsd6(5_000_000n, 1_000_000n)).toBe(5n);
    // 3 mhUSDC at NAV $0.01 → 300 shares
    expect(computeSharesFromUsd6(3_000_000n, 10_000n)).toBe(300n);
  });

  it('floors when notional is NOT a clean multiple of NAV', () => {
    // 5 mhUSDC at NAV $2.5 → 2 shares (not 2.5)
    expect(computeSharesFromUsd6(5_000_000n, 2_500_000n)).toBe(2n);
    // 7 mhUSDC at NAV $2.5 → 2 shares (floor of 2.8)
    expect(computeSharesFromUsd6(7_000_000n, 2_500_000n)).toBe(2n);
  });

  it('returns 0 when notional < per-share NAV (sub-1-share buy)', () => {
    // 3 mhUSDC at NAV $2400.5 (GOLD-ish) → 0 shares
    expect(computeSharesFromUsd6(3_000_000n, 2_400_500_000n)).toBe(0n);
    // 0.5 mhUSDC at NAV $1 → 0 shares
    expect(computeSharesFromUsd6(500_000n, 1_000_000n)).toBe(0n);
  });

  it('throws on non-positive NAV (would div by zero or invert meaning)', () => {
    expect(() => computeSharesFromUsd6(1_000_000n, 0n)).toThrow();
    expect(() => computeSharesFromUsd6(1_000_000n, -1n)).toThrow();
  });

  it('throws on negative notional', () => {
    expect(() => computeSharesFromUsd6(-1n, 1_000_000n)).toThrow();
  });
});

describe('formatUsd6AsDecimal', () => {
  it('renders integer values without decimal point', () => {
    expect(formatUsd6AsDecimal(0n)).toBe('0');
    expect(formatUsd6AsDecimal(1_000_000n)).toBe('1');
    expect(formatUsd6AsDecimal(5_000_000n)).toBe('5');
  });

  it('trims trailing zeros from the fractional part', () => {
    expect(formatUsd6AsDecimal(1_500_000n)).toBe('1.5');
    expect(formatUsd6AsDecimal(1_230_000n)).toBe('1.23');
  });

  it('pads the fractional part to 6 digits before trimming (no leading-zero drop)', () => {
    // 10_000 base units = $0.01 (NOT "$0.1" or "$0.10")
    expect(formatUsd6AsDecimal(10_000n)).toBe('0.01');
    // 123_456 base units = $0.123456
    expect(formatUsd6AsDecimal(123_456n)).toBe('0.123456');
    // 100 base units = $0.0001
    expect(formatUsd6AsDecimal(100n)).toBe('0.0001');
  });

  it('throws on negative input', () => {
    expect(() => formatUsd6AsDecimal(-1n)).toThrow();
  });
});
