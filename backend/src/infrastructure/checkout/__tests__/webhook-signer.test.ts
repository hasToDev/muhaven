import { describe, expect, it } from 'vitest';
import {
  generateSigningSecret,
  WebhookSigner,
  WEBHOOK_SIGNATURE_HEADER_NAME,
} from '../webhook-signer.js';

describe('WebhookSigner', () => {
  const signer = new WebhookSigner();
  // NB: opaque test-only fixture — NOT a real Stripe webhook secret. The
  // signer treats this as raw HMAC key bytes; prefix is irrelevant on the
  // verification path. Deliberately not `whsec_*` so GitHub secret scanning
  // doesn't false-positive — see /security/secret-scanning/1.
  const secret = 'TEST_FIXTURE_NOT_A_REAL_SECRET_signer_round_trip';
  const body = new TextEncoder().encode(JSON.stringify({ x: 1 }));

  it('produces a header in `t=,v1=hex` shape', () => {
    const header = signer.sign(secret, body);
    expect(header.name).toBe(WEBHOOK_SIGNATURE_HEADER_NAME);
    expect(header.value).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('verifies its own signature', () => {
    const header = signer.sign(secret, body);
    expect(signer.verify(secret, body, header.value)).toBe(true);
  });

  it('rejects a signature against a different body', () => {
    const header = signer.sign(secret, body);
    const otherBody = new TextEncoder().encode(JSON.stringify({ x: 2 }));
    expect(signer.verify(secret, otherBody, header.value)).toBe(false);
  });

  it('rejects a signature with the wrong secret', () => {
    const header = signer.sign(secret, body);
    expect(signer.verify('different', body, header.value)).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    const header = signer.sign(secret, body, stale);
    expect(signer.verify(secret, body, header.value)).toBe(false);
  });

  it('rejects a future timestamp outside the replay window', () => {
    const future = new Date(Date.now() + 6 * 60 * 1000);
    const header = signer.sign(secret, body, future);
    expect(signer.verify(secret, body, header.value)).toBe(false);
  });

  it('accepts a timestamp inside the replay window', () => {
    const recent = new Date(Date.now() - 4 * 60 * 1000);
    const header = signer.sign(secret, body, recent);
    expect(signer.verify(secret, body, header.value)).toBe(true);
  });

  it('rejects a malformed header (missing v1)', () => {
    expect(signer.verify(secret, body, 't=1234567890')).toBe(false);
  });

  it('rejects a header where v1 is non-hex', () => {
    expect(signer.verify(secret, body, 't=1234567890,v1=NOTHEX')).toBe(false);
  });

  it('rejects a header with non-integer t', () => {
    expect(signer.verify(secret, body, 't=abc,v1=' + 'a'.repeat(64))).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(signer.verify(secret, body, '')).toBe(false);
  });

  it('verify+sign survives JSON ordering — bytes are the contract', () => {
    // Two semantically-equivalent JSON objects with different key order
    // produce DIFFERENT byte sequences. Receivers must verify against the
    // EXACT bytes they got over the wire — not a re-serialised object.
    const a = new TextEncoder().encode('{"a":1,"b":2}');
    const b = new TextEncoder().encode('{"b":2,"a":1}');
    const header = signer.sign(secret, a);
    expect(signer.verify(secret, a, header.value)).toBe(true);
    expect(signer.verify(secret, b, header.value)).toBe(false);
  });
});

describe('generateSigningSecret', () => {
  it('produces a high-entropy secret with the whsec_ prefix', () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(b).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
