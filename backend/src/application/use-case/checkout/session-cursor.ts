import { ApplicationHttpError } from '../../../core/errors.js';
import type { CheckoutSessionListCursor } from '../../../domain/checkout/repository/checkout-session.repository.js';

/**
 * Wave 4 §5 Path D — opaque cursor codec for `/checkout/sessions/list`.
 *
 * Encoded shape: base64url(`${createdAtMs}.${sessionId}`). The dot
 * separator is unambiguous because sessionId is constrained to
 * `[A-Z0-9]{26}` (no dots possible) and createdAtMs is purely digits.
 *
 * Decoded into a typed cursor for the repo layer. A malformed cursor
 * surfaces as a clean 400 rather than a generic 500 so dashboard
 * pagination is debuggable.
 */
export function encodeSessionCursor(cursor: CheckoutSessionListCursor): string {
  const raw = `${cursor.createdAtMs}.${cursor.sessionId}`;
  return Buffer.from(raw, 'utf-8').toString('base64url');
}

export function decodeSessionCursor(
  encoded: string | undefined,
): CheckoutSessionListCursor | undefined {
  if (!encoded) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
  } catch {
    throw ApplicationHttpError.badRequest('invalid cursor');
  }
  const dot = decoded.indexOf('.');
  if (dot <= 0 || dot === decoded.length - 1) {
    throw ApplicationHttpError.badRequest('invalid cursor');
  }
  const msStr = decoded.slice(0, dot);
  const sessionId = decoded.slice(dot + 1);
  if (!/^\d+$/.test(msStr)) {
    throw ApplicationHttpError.badRequest('invalid cursor');
  }
  if (!/^cs_[A-Z0-9]{26}$/.test(sessionId)) {
    throw ApplicationHttpError.badRequest('invalid cursor');
  }
  const createdAtMs = Number(msStr);
  if (!Number.isFinite(createdAtMs) || createdAtMs < 0) {
    throw ApplicationHttpError.badRequest('invalid cursor');
  }
  return { createdAtMs, sessionId };
}
