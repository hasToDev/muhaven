import { beforeAll, describe, expect, it } from 'vitest';
import {
  composeMessage,
  OperatorAlertPayloadSchema,
  type OperatorAlertPayload,
} from '../operator-alert-transport.js';

// Required by `getLogger` (memoized through `core/config.ts`'s env parse).
// `OperatorAlertPayloadSchema.parse()` paths don't reach the logger, but
// other tests in this file do trigger transitively-imported logger getters.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

const KNOWN_TOKEN = '0x1d6C140204F21835F1AF2A0615826A333827d946';

function payload(overrides: Partial<OperatorAlertPayload> = {}): OperatorAlertPayload {
  return {
    tokenSymbol: 'USYC',
    errorClass: 'ZeroRateError',
    shortMessage: 'ratePerShare floored to 0; every claim would silent-fail to zero.',
    severity: 'error',
    ...overrides,
  };
}

describe('composeMessage — structured header', () => {
  it('produces the Token / Error / blank-line / body shape with no epoch', () => {
    const result = composeMessage(payload());
    expect(result).toMatch(
      /^Token: USYC\nError: ZeroRateError\n\nratePerShare/,
    );
  });

  it('inserts an Epoch row between Error and the blank line when epochId is set', () => {
    const result = composeMessage(payload({ epochId: 17n }));
    expect(result).toMatch(/^Token: USYC\nError: ZeroRateError\nEpoch: 17\n\n/);
  });

  it('renders uint256 epoch IDs as decimal text (no scientific notation)', () => {
    const big = (2n ** 256n) - 1n; // max uint256, 78 digits
    const result = composeMessage(payload({ epochId: big }));
    expect(result).toContain(`Epoch: ${big.toString()}`);
    expect(result).not.toContain('e+');
  });
});

describe('composeMessage — short-message length cap (Round-2 R2-CR HIGH)', () => {
  it('passes a small message through unchanged', () => {
    const result = composeMessage(payload({ shortMessage: 'small' }));
    expect(result.endsWith('small')).toBe(true);
    expect(result.length).toBeLessThan(100);
  });

  it('trims the BODY (not the header) when composed length exceeds 1024', () => {
    // Long body, no epoch. Header = 'Token: USYC\nError: ZeroRateError\n\n' = 35 chars.
    // Body budget = 1024 - 35 = 989. Body of 1024 'a' is trimmed to 989.
    const result = composeMessage(payload({ shortMessage: 'a'.repeat(1024) }));
    expect(result.length).toBe(1024);
    // Header invariant.
    expect(result.startsWith('Token: USYC\nError: ZeroRateError\n\n')).toBe(true);
  });

  it('preserves Epoch: digits even when body is at the cap', () => {
    // Round-2 Reality L-1 — the prior post-compose walkback could chew
    // Epoch: digits. New impl trims body only; header is invariant.
    const result = composeMessage(
      payload({
        epochId: 99999999999999999n, // 17 digits
        shortMessage: 'a'.repeat(2000), // way over cap
      }),
    );
    expect(result).toContain('Epoch: 99999999999999999');
    expect(result.length).toBe(1024);
  });

  it('trims a partial address tail in the body (Security H-2)', () => {
    // Construct a body where the trim would otherwise land mid-address.
    // Header = 35 chars. Body budget = 989. Body = 970 chars + ' ' + KNOWN_TOKEN (42)
    // = 1013 chars → slice at 989 lands 23 chars into the address.
    // Trim walkback removes the partial address from the body end.
    const body = 'x '.repeat(485) + ' ' + KNOWN_TOKEN; // 970 + 1 + 42 = 1013
    const result = composeMessage(payload({ shortMessage: body }));
    expect(result.length).toBeLessThanOrEqual(1024);
    // No partial address at the end.
    expect(result).not.toMatch(/0x[a-fA-F0-9]{1,39}$/);
  });

  it('preserves UTF-16 surrogate pairs at the body trim boundary', () => {
    // Header = 35 chars. Body budget = 989. Body = 988 ASCII + 𝐀 (2 code units).
    // Total body length = 990 → over budget by 1. Slice at 989 lands on the high
    // surrogate; trim walkback removes it to avoid a lone surrogate.
    const body = 'x'.repeat(988) + '𝐀';
    const result = composeMessage(payload({ shortMessage: body }));
    const lastCode = result.charCodeAt(result.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});

describe('OperatorAlertPayloadSchema — wire-boundary parse', () => {
  it('accepts a well-formed payload', () => {
    expect(() => OperatorAlertPayloadSchema.parse(payload())).not.toThrow();
  });

  it('accepts an optional epochId as bigint', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse(payload({ epochId: 42n })),
    ).not.toThrow();
  });

  it('rejects oversized shortMessage', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse(payload({ shortMessage: 'x'.repeat(1025) })),
    ).toThrow();
  });

  it('rejects oversized errorClass', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse(payload({ errorClass: 'X'.repeat(65) })),
    ).toThrow();
  });

  it('rejects unknown severity', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse({
        ...payload(),
        // @ts-expect-error — exercising runtime guard
        severity: 'critical',
      }),
    ).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse({
        ...payload(),
        extraField: 'attacker injection',
      }),
    ).toThrow();
  });

  it('rejects epochId that is a number (not bigint)', () => {
    expect(() =>
      OperatorAlertPayloadSchema.parse({
        ...payload(),
        // @ts-expect-error — exercising runtime guard
        epochId: 42,
      }),
    ).toThrow();
  });
});
