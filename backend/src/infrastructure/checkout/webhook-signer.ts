import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-style HMAC-SHA256 webhook signing (Wave 4 P5).
 *
 * Header format (matches Stripe's `Stripe-Signature` shape so issuer
 * receiver libraries can be ported with minimal change):
 *
 *     MuHaven-Signature: t=<unix>,v1=<hex-hmac>
 *
 * Signed payload = `${unixSec}.${rawBody}` where `rawBody` is the
 * UTF-8-encoded request body the dispatcher actually sent. Issuers MUST
 * verify against the raw body bytes — re-serialising the JSON object is
 * unsafe (key order / whitespace drift breaks the HMAC).
 *
 * Replay protection: receivers reject `t` outside a 5-minute window
 * (`MAX_SKEW_SEC`). The window survives clock skew up to ±5 min on
 * either side; receivers should also dedupe by event id within that
 * window if exactly-once semantics matter.
 */

const HEADER_NAME = 'MuHaven-Signature';
const SIG_VERSION = 'v1';
const MAX_SKEW_SEC = 5 * 60;

export interface WebhookSignatureHeader {
  /** `MuHaven-Signature: t=<unix>,v1=<hex>`. */
  name: string;
  value: string;
}

export class WebhookSigner {
  /**
   * Compute the signature header for a single delivery. `bodyBytes` is
   * the exact byte sequence the dispatcher will POST — the receiver
   * MUST verify against the same bytes (raw body middleware in Express,
   * `request.text()` in Cloudflare Workers).
   */
  sign(secret: string, bodyBytes: Uint8Array, now: Date = new Date()): WebhookSignatureHeader {
    const t = Math.floor(now.getTime() / 1000);
    const signed = `${t}.${Buffer.from(bodyBytes).toString('utf-8')}`;
    const sig = createHmac('sha256', secret).update(signed).digest('hex');
    return {
      name: HEADER_NAME,
      value: `t=${t},${SIG_VERSION}=${sig}`,
    };
  }

  /**
   * Verify a signature header. Receivers will use this same primitive;
   * we expose it here so the test suite + the Wave 5 issuer SDK can
   * share the implementation.
   *
   * Returns true on a clean verify; false on any timing/format/HMAC
   * mismatch. Constant-time HMAC compare via `timingSafeEqual`.
   */
  verify(
    secret: string,
    bodyBytes: Uint8Array,
    headerValue: string,
    opts: { now?: Date; maxSkewSec?: number } = {},
  ): boolean {
    const parsed = parseHeader(headerValue);
    if (!parsed) return false;

    const now = opts.now ?? new Date();
    const maxSkew = opts.maxSkewSec ?? MAX_SKEW_SEC;
    const skew = Math.abs(Math.floor(now.getTime() / 1000) - parsed.t);
    if (skew > maxSkew) return false;

    const signed = `${parsed.t}.${Buffer.from(bodyBytes).toString('utf-8')}`;
    const expected = createHmac('sha256', secret).update(signed).digest();

    let actual: Buffer;
    try {
      actual = Buffer.from(parsed.v1, 'hex');
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}

function parseHeader(headerValue: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const pair of headerValue.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
      t = n;
    } else if (key === SIG_VERSION) {
      // v1 must be lowercase hex; reject any non-hex char so the
      // timing-safe compare doesn't see a length-equal-but-malformed buf.
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1 = value.toLowerCase();
    }
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}

/**
 * Generate a 32-byte signing secret as a hex string. Surfaced to the
 * issuer ONCE at endpoint create time — the issuer is responsible for
 * storing it; the backend persists it directly so future deliveries can
 * sign with the same secret.
 */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

export const WEBHOOK_SIGNATURE_HEADER_NAME = HEADER_NAME;
export const WEBHOOK_SIGNATURE_MAX_SKEW_SEC = MAX_SKEW_SEC;
