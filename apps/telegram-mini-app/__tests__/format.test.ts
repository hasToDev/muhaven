import { describe, expect, it } from 'vitest';
import {
  INTENT_ID_RE,
  OTP_RE,
  formatUsd,
  isValidIntentId,
  isValidOtp,
  withSeparators,
} from '../src/format.js';

describe('INTENT_ID_RE / isValidIntentId', () => {
  it('accepts a canonical intent id', () => {
    expect(isValidIntentId('oci_AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(isValidIntentId('oci_ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(true);
    expect(isValidIntentId('oci_0123456789ABCDEFGHIJKLMNOP')).toBe(true);
  });

  it('rejects bodies with the wrong length', () => {
    expect(isValidIntentId('oci_TOOSHORT')).toBe(false);
    expect(isValidIntentId(`oci_${'A'.repeat(25)}`)).toBe(false);
    expect(isValidIntentId(`oci_${'A'.repeat(27)}`)).toBe(false);
  });

  it('rejects bodies with lowercase', () => {
    expect(isValidIntentId('oci_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('rejects the wrong prefix', () => {
    expect(isValidIntentId('foo_AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isValidIntentId('OCI_AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isValidIntentId('AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('rejects null / undefined / empty', () => {
    expect(isValidIntentId(null)).toBe(false);
    expect(isValidIntentId(undefined)).toBe(false);
    expect(isValidIntentId('')).toBe(false);
  });

  it('rejects path-traversal-style probes that share the prefix', () => {
    expect(isValidIntentId('oci_../etc/passwd')).toBe(false);
    expect(isValidIntentId('oci_<script>alert(1)</script>')).toBe(false);
  });

  it('exposes the regex itself for cross-package consistency checks', () => {
    expect(INTENT_ID_RE.source).toBe('^oci_[A-Z0-9]{26}$');
  });
});

describe('OTP_RE / isValidOtp', () => {
  it('accepts a 6-digit code', () => {
    expect(isValidOtp('123456')).toBe(true);
    expect(isValidOtp('000000')).toBe(true);
    expect(isValidOtp('999999')).toBe(true);
  });

  it('rejects codes with wrong length', () => {
    expect(isValidOtp('12345')).toBe(false);
    expect(isValidOtp('1234567')).toBe(false);
    expect(isValidOtp('')).toBe(false);
  });

  it('rejects codes with non-digit chars', () => {
    expect(isValidOtp('12345a')).toBe(false);
    expect(isValidOtp(' 12345')).toBe(false);
    expect(isValidOtp('+12345')).toBe(false);
    expect(isValidOtp('12 345')).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isValidOtp(null)).toBe(false);
    expect(isValidOtp(undefined)).toBe(false);
  });

  it('exposes the regex itself for cross-package consistency checks', () => {
    expect(OTP_RE.source).toBe('^\\d{6}$');
  });
});

describe('withSeparators', () => {
  it('groups thousands with commas', () => {
    expect(withSeparators('1234567')).toBe('1,234,567');
    expect(withSeparators('1000000')).toBe('1,000,000');
    expect(withSeparators('1000')).toBe('1,000');
  });

  it('passes through values < 1,000', () => {
    expect(withSeparators('0')).toBe('0');
    expect(withSeparators('999')).toBe('999');
  });
});

describe('formatUsd', () => {
  it('formats sub-million amounts with 2 decimals', () => {
    expect(formatUsd('1000000')).toBe('$1.00');
    expect(formatUsd('200000000')).toBe('$200.00');
    expect(formatUsd('5000000000')).toBe('$5,000.00');
  });

  it('formats sub-cent amounts as $X.00 (display rounding)', () => {
    // $0.001 = 1000 base units. cents = 1000 % 1_000_000 = 1000. cents/10000 = 0.
    // Mini-app display rounds to whole cents intentionally — sub-cent
    // amounts in a Telegram preview are noise.
    expect(formatUsd('1000')).toBe('$0.00');
    expect(formatUsd('9999')).toBe('$0.00');
    expect(formatUsd('10000')).toBe('$0.01');
    expect(formatUsd('99999')).toBe('$0.09');
  });

  it('formats >=$1M without cents', () => {
    expect(formatUsd('1000000000000')).toBe('$1,000,000');
    expect(formatUsd('1234567000000')).toBe('$1,234,567');
  });

  it('does not show cents on the >=$1M boundary', () => {
    expect(formatUsd('1000000500000')).toBe('$1,000,000');
  });

  it('formats $0', () => {
    expect(formatUsd('0')).toBe('$0.00');
  });

  it('throws on a malformed amount', () => {
    expect(() => formatUsd('not-a-number')).toThrow();
    expect(() => formatUsd('1.5')).toThrow();
  });
});
