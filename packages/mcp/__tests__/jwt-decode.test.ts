import { describe, it, expect } from 'vitest';
import {
  decodeJwtPayload,
  JwtDecodeError,
  sanitizeClaimForTerminal,
  truncateSubject,
} from '../src/auth/jwt-decode.js';

/**
 * Build a fake JWT carrying the given payload object. Header/signature
 * are placeholders — the decoder under test does NOT verify them.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = 'sig';
  return `${header}.${body}.${sig}`;
}

describe('decodeJwtPayload', () => {
  it('extracts sub, scope, exp, iss from a well-formed payload', () => {
    const jwt = fakeJwt({
      sub: '4b488b44-b13b-4ccb-b419-a1b801fe8814',
      scope: ['mcp.read.*', 'mcp.propose.*'],
      exp: 1779465597,
      iss: 'muhaven',
      walletAddress: '0x678d2e3F778C4528911b137ED4db282834f3735E',
    });
    const decoded = decodeJwtPayload(jwt);
    expect(decoded.sub).toBe('4b488b44-b13b-4ccb-b419-a1b801fe8814');
    expect(decoded.scope).toEqual(['mcp.read.*', 'mcp.propose.*']);
    expect(decoded.expSec).toBe(1779465597);
    expect(decoded.iss).toBe('muhaven');
  });

  it('returns empty scope array when scope claim absent', () => {
    const jwt = fakeJwt({ sub: 'u1', exp: 0 });
    expect(decodeJwtPayload(jwt).scope).toEqual([]);
  });

  it('returns empty scope array when scope claim is not an array', () => {
    const jwt = fakeJwt({ sub: 'u1', scope: 'mcp.read.*' });
    expect(decodeJwtPayload(jwt).scope).toEqual([]);
  });

  it('filters non-string entries from scope array', () => {
    const jwt = fakeJwt({ sub: 'u1', scope: ['mcp.read.*', 42, null, 'mcp.propose.*'] });
    expect(decodeJwtPayload(jwt).scope).toEqual(['mcp.read.*', 'mcp.propose.*']);
  });

  it('returns null sub when sub claim absent', () => {
    const jwt = fakeJwt({ exp: 0 });
    expect(decodeJwtPayload(jwt).sub).toBeNull();
  });

  it('returns null sub when sub claim is not a string', () => {
    const jwt = fakeJwt({ sub: 42, exp: 0 });
    expect(decodeJwtPayload(jwt).sub).toBeNull();
  });

  it('returns null expSec when exp claim absent', () => {
    const jwt = fakeJwt({ sub: 'u1' });
    expect(decodeJwtPayload(jwt).expSec).toBeNull();
  });

  it('returns null iss when iss claim absent', () => {
    const jwt = fakeJwt({ sub: 'u1' });
    expect(decodeJwtPayload(jwt).iss).toBeNull();
  });

  it('throws JwtDecodeError on wrong segment count (< 3)', () => {
    expect(() => decodeJwtPayload('a.b')).toThrow(JwtDecodeError);
    expect(() => decodeJwtPayload('a')).toThrow(JwtDecodeError);
    expect(() => decodeJwtPayload('')).toThrow(JwtDecodeError);
  });

  it('throws JwtDecodeError on wrong segment count (> 3)', () => {
    expect(() => decodeJwtPayload('a.b.c.d')).toThrow(JwtDecodeError);
  });

  it('throws JwtDecodeError when payload segment is not valid JSON', () => {
    // base64url("not json") is "bm90IGpzb24"
    const jwt = 'header.bm90IGpzb24.sig';
    expect(() => decodeJwtPayload(jwt)).toThrow(JwtDecodeError);
  });

  it('throws JwtDecodeError when payload JSON is a primitive', () => {
    // base64url('42')
    const jwt = `header.${Buffer.from('42').toString('base64url')}.sig`;
    expect(() => decodeJwtPayload(jwt)).toThrow(JwtDecodeError);
  });

  it('throws JwtDecodeError when payload JSON is null', () => {
    const jwt = `header.${Buffer.from('null').toString('base64url')}.sig`;
    expect(() => decodeJwtPayload(jwt)).toThrow(JwtDecodeError);
  });

  it('JwtDecodeError carries a typed code', () => {
    try {
      decodeJwtPayload('a.b');
    } catch (err) {
      expect(err).toBeInstanceOf(JwtDecodeError);
      expect((err as JwtDecodeError).code).toBe('malformed_segments');
      return;
    }
    throw new Error('expected throw');
  });
});

describe('truncateSubject', () => {
  it('returns "(missing)" for null', () => {
    expect(truncateSubject(null)).toBe('(missing)');
  });

  it('returns short strings unchanged', () => {
    expect(truncateSubject('short')).toBe('short');
    expect(truncateSubject('twelvecharss')).toBe('twelvecharss');
  });

  it('truncates 13-char input (just past the boundary)', () => {
    expect(truncateSubject('thirteenchars')).toBe('thirteen…hars');
  });

  it('truncates UUIDs to first-8 + last-4 with an ellipsis', () => {
    // U+2026 (single-char "horizontal ellipsis")
    expect(truncateSubject('4b488b44-b13b-4ccb-b419-a1b801fe8814')).toBe('4b488b44…8814');
  });

  it('truncates long opaque strings', () => {
    expect(truncateSubject('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefgh…wxyz');
  });

  it('strips ANSI/control codepoints before truncation (Security M-3)', () => {
    // \x1b...\x07 = ESC...BEL — the OSC window-title escape that
    // would otherwise spoof the operator's terminal. We strip the
    // CONTROL chars; the printable body (`]0;OWNED`) becomes literal
    // text after sanitization, which is harmless.
    expect(truncateSubject('safe\x1b]0;OWNED\x07suffix')).toBe('safe?]0;…ffix');
  });

  it('strips Unicode bidi-override codepoints (Security M-3)', () => {
    // U+202E = right-to-left override; would otherwise reverse display
    // order of subsequent characters.
    expect(truncateSubject('safe‮paywned‬')).toBe('safe?pay…ned?');
  });

  it('strips non-ASCII emoji (surrogate-pair counted as two code units)', () => {
    // '🚀' is U+1F680, encoded as a UTF-16 surrogate pair → 2 code
    // units in JS, both replaced. 'user' (4) + '??' (from rocket) +
    // 'rocket' (6) = 12 chars exactly, returned unchanged.
    expect(truncateSubject('user🚀rocket')).toBe('user??rocket');
  });

  it('strips longer surrogate-pair sequences past the truncation boundary', () => {
    // 'usr🚀🚀rocket' = 3 + 2 + 2 + 6 = 13 chars after sanitization
    // ('usr????rocket') → 13 > 12 → first-8 ('usr????r') + … + last-4.
    expect(truncateSubject('usr🚀🚀rocket')).toBe('usr????r…cket');
  });
});

describe('sanitizeClaimForTerminal', () => {
  it('returns empty string for null / undefined / empty', () => {
    expect(sanitizeClaimForTerminal(null)).toBe('');
    expect(sanitizeClaimForTerminal(undefined)).toBe('');
    expect(sanitizeClaimForTerminal('')).toBe('');
  });

  it('preserves printable ASCII unchanged', () => {
    expect(sanitizeClaimForTerminal('muhaven')).toBe('muhaven');
    expect(sanitizeClaimForTerminal('mcp.read.* mcp.propose.*')).toBe('mcp.read.* mcp.propose.*');
  });

  it('replaces ANSI/BEL control codepoints with ? (terminal-spoof defense)', () => {
    // The control codepoints (\x1b and \x07) are the dangerous part —
    // strip those and the OSC body becomes harmless literal text.
    expect(sanitizeClaimForTerminal('muhaven\x1b]0;OWNED\x07')).toBe('muhaven?]0;OWNED?');
  });

  it('replaces non-ASCII code points with ? (one ? per JS code unit)', () => {
    // 'é' is a single code unit U+00E9 → one ? in output.
    expect(sanitizeClaimForTerminal('café')).toBe('caf?');
  });

  it('replaces surrogate-pair emoji with two ? (one per code unit)', () => {
    expect(sanitizeClaimForTerminal('hi🚀')).toBe('hi??');
  });

  it('truncates to maxLen with explicit suffix', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeClaimForTerminal(long, 50);
    expect(out).toBe('x'.repeat(50) + '…(truncated)');
  });

  it('honors custom maxLen', () => {
    expect(sanitizeClaimForTerminal('hello world', 5)).toBe('hello…(truncated)');
  });

  it('does not truncate exactly-at-maxLen input', () => {
    expect(sanitizeClaimForTerminal('exact', 5)).toBe('exact');
  });
});
