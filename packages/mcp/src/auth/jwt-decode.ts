/**
 * Tiny base64url-decoder for JWT payload INSPECTION ONLY. Does NOT
 * verify the signature — callers are operator-facing diagnostics
 * (`muhaven-broker doctor`, MCP `no_active_session_key` fallback
 * enrichment) that surface `sub` + `scope` + `exp` to help an operator
 * see WHICH user the broker's stored JWT was issued for, without
 * needing to manually decode it.
 *
 * Trust model: the broker keystore is the source-of-truth for the JWT
 * bytes; the backend is the source-of-truth for whether those bytes
 * are still trusted (server-side jwtVerify on every request). This
 * decoder is purely informational — its output never gates an action.
 */

export interface DecodedJwt {
  /** `sub` claim — the userId the JWT was issued to. Null when absent
   *  (malformed JWT or non-standard issuer; surfaced as "(missing)"). */
  readonly sub: string | null;
  /** `scope` claim — array of scope patterns when present (Wave 4 P3
   *  device-flow tokens carry these); empty array when absent or
   *  malformed. */
  readonly scope: readonly string[];
  /** `exp` claim — epoch seconds when the JWT expires. Null when
   *  absent. */
  readonly expSec: number | null;
  /** `iss` claim — JWT issuer, when present. Helpful for spotting
   *  stage-vs-prod token mix-ups. */
  readonly iss: string | null;
}

export class JwtDecodeError extends Error {
  readonly code: 'malformed_segments' | 'malformed_base64' | 'malformed_json';
  constructor(code: JwtDecodeError['code'], message: string) {
    super(message);
    this.name = 'JwtDecodeError';
    this.code = code;
  }
}

/**
 * Decode a JWT's payload (middle segment) without verifying the
 * signature. Throws `JwtDecodeError` when the input is not a
 * three-segment dot-separated structure OR the middle segment isn't
 * valid base64url-encoded JSON.
 */
export function decodeJwtPayload(jwt: string): DecodedJwt {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    throw new JwtDecodeError(
      'malformed_segments',
      `expected 3 dot-separated segments, got ${segments.length}`,
    );
  }
  // TS noUncheckedIndexedAccess: segments[1] is `string | undefined`
  // even after the length check above. The branch is impossible at
  // runtime, but the explicit guard keeps the bundle strict-mode clean.
  const payloadSegment = segments[1];
  if (payloadSegment === undefined) {
    throw new JwtDecodeError('malformed_segments', 'payload segment missing');
  }
  let payloadJson: string;
  try {
    // Node 16+ supports 'base64url' encoding natively; works on every
    // supported MCP runtime (engines.node >= 20 per package.json).
    payloadJson = Buffer.from(payloadSegment, 'base64url').toString('utf8');
  } catch (err) {
    throw new JwtDecodeError(
      'malformed_base64',
      `payload segment is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (err) {
    throw new JwtDecodeError(
      'malformed_json',
      `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new JwtDecodeError(
      'malformed_json',
      `payload is not a JSON object (got ${parsed === null ? 'null' : typeof parsed})`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  return {
    sub: typeof obj.sub === 'string' ? obj.sub : null,
    scope: Array.isArray(obj.scope)
      ? obj.scope.filter((s): s is string => typeof s === 'string')
      : [],
    expSec: typeof obj.exp === 'number' ? obj.exp : null,
    iss: typeof obj.iss === 'string' ? obj.iss : null,
  };
}

/**
 * Sanitize an arbitrary JWT claim string for safe printing to a
 * terminal. Strips ALL control chars + non-ASCII (defends against
 * ANSI/OSC escape injection by a forged JWT — `iss: "...\x1b]0;OWNED\x07"`
 * would otherwise spoof the operator's terminal window title). Caps
 * length so a pathological JWT with a 100KB claim doesn't spam the
 * doctor output (Security Engineer round-1 M-1).
 *
 * Returns `''` for null/undefined/empty input so callers can use it
 * unconditionally without null checks. Visible-corruption (`?`) is
 * preferred to silent dropping so an operator notices when a forged
 * JWT lands in their keystore.
 *
 * Note: the regex operates on UTF-16 code units (not code points), so
 * a surrogate-pair emoji becomes TWO `?` characters not one. This is
 * intentional — preserves byte-position fidelity for forensic reading
 * of a hostile JWT (see `__tests__/jwt-decode.test.ts` surrogate-pair
 * cases — round-2 LOW note).
 */
export function sanitizeClaimForTerminal(value: string | null | undefined, maxLen = 120): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[^\x20-\x7e]/g, '?');
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…(truncated)` : stripped;
}

/**
 * Render a user-id (UUID or other opaque string) as a short prefix
 * suitable for log lines and operator-facing fallback messages.
 * Operators recognize their own user-id by the first 8 chars; we never
 * print the full id to avoid copy/paste handoffs that include the
 * trailing entropy in chat transcripts.
 *
 * Strips non-printable / non-ASCII characters BEFORE truncation as a
 * defense against a forged JWT injecting bidi-override / ANSI escape /
 * Unicode-control codepoints into operator-visible messages (Security
 * Engineer round-1 M-3). The legitimate sub is always a v4 UUID
 * (36 chars of hex+hyphens), so any non-ASCII byte signals a forgery.
 * The `?` substitution preserves visibility of the corruption rather
 * than silently dropping it.
 *
 * Acceptable-disclosure note: an 8-char prefix + 4-char suffix of a v4
 * UUID retains roughly 48 bits of entropy — not enough to be a
 * population-wide identifier, and the operator IS the subject. MCP
 * transcripts may be shared (Discord support, bug reports), so this
 * truncation is the deliberate ceiling on the information surface.
 *
 * Boundary note (round-2 LOW): for sub.length ≤ 12 the value is
 * returned unchanged. UUIDs are always 36 chars so they always
 * truncate; the ≤12 branch is for callers that pass non-UUID subs
 * (legacy SIWE tokens, test fixtures). If a future caller passes a
 * 12-char attacker-controlled sub, it would be displayed in full —
 * acceptable today because every production code-path passes a v4
 * UUID; document this contract at the call site if you add a new one.
 */
export function truncateSubject(sub: string | null): string {
  if (!sub) return '(missing)';
  // eslint-disable-next-line no-control-regex
  const sanitized = sub.replace(/[^\x20-\x7e]/g, '?');
  if (sanitized.length <= 12) return sanitized;
  return `${sanitized.slice(0, 8)}…${sanitized.slice(-4)}`;
}
