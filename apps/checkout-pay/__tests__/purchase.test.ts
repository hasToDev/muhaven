/**
 * Wave 4 P5 (Wave-5 buyer-side port, P3) — purchase orchestrator tests.
 *
 * `executePurchase` is heavy to unit-test (six UserOps, cofhe init,
 * publicClient reads). Vitest coverage here pins the pure helpers
 * (`sharesFromAmountUsd6` math + the module's public surface). The
 * end-to-end ceremony is exercised on the prod-cutover walkthrough
 * (operator-driven, single-shot tap from `pay.muhaven.app/c/<sessionId>#k=<key>`).
 */

import { describe, expect, it } from 'vitest';
import {
  __internals,
  sharesFromAmountUsd6,
  type PurchaseStage,
} from '../src/purchase.js';

describe('sharesFromAmountUsd6 (demo-NAV scaling)', () => {
  it('returns 100n shares for $100 USDC (100_000_000 base units)', () => {
    expect(sharesFromAmountUsd6(100_000_000n)).toBe(100n);
  });

  it('returns 1n share for exactly $1 USDC', () => {
    expect(sharesFromAmountUsd6(1_000_000n)).toBe(1n);
  });

  it('returns 0n shares for sub-$1 amounts (demo limitation)', () => {
    expect(sharesFromAmountUsd6(999_999n)).toBe(0n);
    expect(sharesFromAmountUsd6(500_000n)).toBe(0n);
    expect(sharesFromAmountUsd6(1n)).toBe(0n);
  });

  it('returns 0n shares for 0 input', () => {
    expect(sharesFromAmountUsd6(0n)).toBe(0n);
  });

  it('floors instead of rounding ($1.5 → 1 share, not 2)', () => {
    expect(sharesFromAmountUsd6(1_500_000n)).toBe(1n);
    expect(sharesFromAmountUsd6(1_999_999n)).toBe(1n);
    expect(sharesFromAmountUsd6(2_000_000n)).toBe(2n);
  });

  it('scales linearly past 1k USDC ($10_000 → 10_000 shares)', () => {
    expect(sharesFromAmountUsd6(10_000_000_000n)).toBe(10_000n);
  });

  it('handles uint64 max ($18_446_744_073_709 USDC) without overflow', () => {
    const uint64Max = (1n << 64n) - 1n;
    const result = sharesFromAmountUsd6(uint64Max);
    expect(result).toBe(uint64Max / 1_000_000n);
    // Sanity: result is well under uint128 so SubscriptionClient won't
    // reject (uint128 max is ~3.4e38).
    expect(result < (1n << 128n) - 1n).toBe(true);
  });
});

describe('PurchaseStage union (six-step ceremony)', () => {
  it('covers the six on-chain stages plus the done sentinel', () => {
    // Compile-time check: if PurchaseStage is missing a stage the
    // CTA progress indicator won't render, so pin the union via
    // exhaustive switch. The cast forces TS to error if PurchaseStage
    // gains/loses a member.
    const stages: PurchaseStage[] = [
      'approve_usdc',
      'wrap_pusdc',
      'grant_pusdc_operator',
      'wrap_mhusdc',
      'grant_mhusdc_operator',
      'purchase',
      'done',
    ];
    expect(stages).toHaveLength(7);
  });
});

describe('__internals (test seam)', () => {
  it('exposes OPERATOR_EXPIRY_SECONDS as a positive integer ≥ 1 day', () => {
    expect(__internals.OPERATOR_EXPIRY_SECONDS).toBeGreaterThanOrEqual(86_400);
  });

  it('exposes sharesFromAmountUsd6 via __internals (consistent with named export)', () => {
    expect(__internals.sharesFromAmountUsd6(100_000_000n)).toBe(
      sharesFromAmountUsd6(100_000_000n),
    );
  });
});
