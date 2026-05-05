import { describe, expect, it } from 'vitest';
import { CheckoutAesGcm, b64url, b64urlDecode } from '../aes-gcm.js';

describe('CheckoutAesGcm', () => {
  const aes = new CheckoutAesGcm();

  it('round-trips a JSON-serialisable payload', () => {
    const payload = { amountUsd6: '12345000', memo: 'hello' };
    const { encPayload, key } = aes.encrypt(payload);
    expect(key.length).toBe(32);
    const parts = encPayload.split(':');
    expect(parts).toHaveLength(3);
    const decrypted = aes.decrypt(encPayload, key);
    expect(decrypted).toEqual(payload);
  });

  it('produces a different IV for every call so identical payloads diverge', () => {
    const payload = { amountUsd6: '1' };
    const a = aes.encrypt(payload);
    const b = aes.encrypt(payload);
    expect(a.encPayload).not.toBe(b.encPayload);
  });

  it('throws when a wrong-length key is passed', () => {
    const { encPayload } = aes.encrypt({ a: 1 });
    expect(() => aes.decrypt(encPayload, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('throws when ciphertext is tampered with', () => {
    const { encPayload, key } = aes.encrypt({ amountUsd6: '1' });
    const parts = encPayload.split(':');
    const tampered = Buffer.from(parts[2] + 'A', 'utf-8').toString('base64url').replace(/=+$/, '');
    const corrupted = `${parts[0]}:${parts[1]}:${tampered}`;
    expect(() => aes.decrypt(corrupted, key)).toThrow();
  });

  it('throws when authTag is tampered with', () => {
    const { encPayload, key } = aes.encrypt({ amountUsd6: '1' });
    const parts = encPayload.split(':');
    const orig = b64urlDecode(parts[1]);
    orig[0] = orig[0] ^ 0x01;
    const corrupted = `${parts[0]}:${b64url(Buffer.from(orig))}:${parts[2]}`;
    expect(() => aes.decrypt(corrupted, key)).toThrow();
  });

  it('throws on malformed envelope (missing segment)', () => {
    const key = Buffer.alloc(32);
    expect(() => aes.decrypt('a:b', key)).toThrow(/3 colon/);
    expect(() => aes.decrypt('a:b:c:d', key)).toThrow(/3 colon/);
  });

  it('throws when IV length is wrong', () => {
    const { encPayload, key } = aes.encrypt({ amountUsd6: '1' });
    const parts = encPayload.split(':');
    const badIv = b64url(Buffer.alloc(8));
    const corrupted = `${badIv}:${parts[1]}:${parts[2]}`;
    expect(() => aes.decrypt(corrupted, key)).toThrow(/IV must be 12/);
  });
});
