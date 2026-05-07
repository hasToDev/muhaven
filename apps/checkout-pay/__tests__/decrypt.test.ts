import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptPayload, formatUsd6 } from '../src/decrypt.js';

/**
 * The buyer-side `decryptPayload` MUST be wire-compatible with the
 * backend's `CheckoutAesGcm.encrypt` codec. Rather than import the
 * backend module (which would create a cross-package dep), we
 * reproduce the codec here and round-trip it through `decryptPayload`.
 *
 * If the backend codec ever changes shape, BOTH sides will need to update;
 * this test pins the wire format on the buyer side.
 */

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function backendEncrypt(payload: unknown, keyBytes: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  const json = JSON.stringify(payload);
  const ct = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${b64url(iv)}:${b64url(authTag)}:${b64url(ct)}`;
}

describe('decryptPayload — round-trip with backend codec', () => {
  it('round-trips a representative payload', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const payload = {
      amountUsd6: '12345678',
      memo: 'Series A 2026 — investor #042',
      referenceId: 'inv-2026-042',
    };
    const enc = backendEncrypt(payload, key);
    const out = await decryptPayload(enc, fragmentKey);
    expect(out).toEqual(payload);
  });

  it('round-trips minimum-shape payload (amountUsd6 only)', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const payload = { amountUsd6: '1' };
    const out = await decryptPayload(backendEncrypt(payload, key), fragmentKey);
    expect(out).toEqual(payload);
  });

  it('rejects an envelope with the wrong number of segments', async () => {
    const key = randomBytes(32);
    await expect(decryptPayload('only-one-segment', b64url(key))).rejects.toThrow(
      /3 colon-separated/,
    );
    await expect(decryptPayload('aa:bb', b64url(key))).rejects.toThrow(
      /3 colon-separated/,
    );
  });

  it('rejects an envelope with an empty segment', async () => {
    const key = randomBytes(32);
    const enc = backendEncrypt({ amountUsd6: '1' }, key);
    const broken = enc.replace(/^[^:]+/, '');
    await expect(decryptPayload(broken, b64url(key))).rejects.toThrow(/empty segment/);
  });

  it('rejects an envelope with a non-12-byte IV', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    // Deliberately swap IV with an 11-byte buffer; valid b64url but wrong length.
    const wrongIv = b64url(randomBytes(11));
    const realEnc = backendEncrypt({ amountUsd6: '1' }, key);
    const tail = realEnc.split(':').slice(1).join(':');
    await expect(decryptPayload(`${wrongIv}:${tail}`, fragmentKey)).rejects.toThrow(
      /iv must be 12 bytes/,
    );
  });

  it('rejects an envelope with a non-16-byte authTag', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const wrongTag = b64url(randomBytes(15));
    const enc = backendEncrypt({ amountUsd6: '1' }, key);
    const [iv, , ct] = enc.split(':');
    await expect(decryptPayload(`${iv}:${wrongTag}:${ct}`, fragmentKey)).rejects.toThrow(
      /authTag must be 16 bytes/,
    );
  });

  it('rejects a fragment key that is not 32 bytes', async () => {
    const key = randomBytes(32);
    const enc = backendEncrypt({ amountUsd6: '1' }, key);
    // 31 bytes
    const shortKey = b64url(randomBytes(31));
    await expect(decryptPayload(enc, shortKey)).rejects.toThrow(
      /fragment key must be 32 bytes/,
    );
  });

  it('rejects a tampered ciphertext (GCM auth tag mismatch)', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const enc = backendEncrypt({ amountUsd6: '1' }, key);
    const [iv, tag, ct] = enc.split(':');
    // Flip the last char of the ciphertext (or use a different non-empty
    // value if it happens to match).
    const flipped = ct!.slice(0, -1) + (ct!.endsWith('A') ? 'B' : 'A');
    await expect(
      decryptPayload(`${iv}:${tag}:${flipped}`, fragmentKey),
    ).rejects.toBeDefined();
  });

  it('rejects a payload that is not a JSON object', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    // Manually encrypt a JSON STRING (not an object).
    const enc = backendEncrypt('hello', key);
    await expect(decryptPayload(enc, fragmentKey)).rejects.toThrow(
      /missing amountUsd6/,
    );
  });

  it('rejects a payload missing amountUsd6', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const enc = backendEncrypt({ memo: 'no amount here' }, key);
    await expect(decryptPayload(enc, fragmentKey)).rejects.toThrow(/missing amountUsd6/);
  });

  it('rejects a payload where amountUsd6 is non-string', async () => {
    const key = randomBytes(32);
    const fragmentKey = b64url(key);
    const enc = backendEncrypt({ amountUsd6: 123 }, key);
    await expect(decryptPayload(enc, fragmentKey)).rejects.toThrow(/missing amountUsd6/);
  });
});

describe('formatUsd6', () => {
  it('formats a 1.000000 USDC value', () => {
    expect(formatUsd6('1000000')).toBe('1.00');
  });

  it('formats sub-cent amounts (preserves at least 2 decimals)', () => {
    expect(formatUsd6('1')).toBe('0.000001');
    expect(formatUsd6('10')).toBe('0.00001');
    expect(formatUsd6('100')).toBe('0.0001');
    expect(formatUsd6('1000')).toBe('0.001');
    expect(formatUsd6('10000')).toBe('0.01');
    expect(formatUsd6('100000')).toBe('0.10');
  });

  it('formats trailing-zero amounts to 2 decimals', () => {
    expect(formatUsd6('500000')).toBe('0.50');
    expect(formatUsd6('5000000')).toBe('5.00');
  });

  it('groups thousands with commas', () => {
    expect(formatUsd6('12345678901234')).toBe('12,345,678.901234');
    expect(formatUsd6('1000000000')).toBe('1,000.00');
  });

  it('preserves non-trailing-zero precision', () => {
    expect(formatUsd6('12345678')).toBe('12.345678');
    expect(formatUsd6('100050')).toBe('0.10005');
  });

  it('handles zero (degenerate case)', () => {
    expect(formatUsd6('0')).toBe('0.00');
  });
});
