import { describe, expect, it } from 'vitest';
import { decodeBase64Url, parseCheckoutLocation } from '../src/fragment.js';

const VALID_SESSION_ID = 'cs_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 43 chars = base64url(32B) unpadded.
const VALID_FRAGMENT_KEY = 'A'.repeat(43);

function loc(pathname: string, hash: string): Location {
  return {
    pathname,
    hash,
    href: `https://muhaven.app${pathname}${hash}`,
    host: 'muhaven.app',
    hostname: 'muhaven.app',
    origin: 'https://muhaven.app',
    port: '',
    protocol: 'https:',
    search: '',
    assign: () => undefined,
    reload: () => undefined,
    replace: () => undefined,
    ancestorOrigins: {} as DOMStringList,
  } as unknown as Location;
}

describe('parseCheckoutLocation', () => {
  it('parses a well-formed URL', () => {
    const result = parseCheckoutLocation(
      loc(`/pay/c/${VALID_SESSION_ID}`, `#k=${VALID_FRAGMENT_KEY}`),
    );
    expect(result).toEqual({
      sessionId: VALID_SESSION_ID,
      fragmentKey: VALID_FRAGMENT_KEY,
    });
  });

  it('rejects a path with the wrong segment count', () => {
    expect(parseCheckoutLocation(loc('/pay/c', `#k=${VALID_FRAGMENT_KEY}`))).toBeNull();
    expect(
      parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}/extra`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
  });

  it('rejects the legacy /c/<id> path shape (pre-2026-05-15 subdomain origin)', () => {
    // Buyer pages served from the new origin only accept `/pay/c/<id>`.
    // Legacy URLs are bounced via the muhaven-checkout-web JS redirect
    // shim BEFORE they reach the buyer page, so the legacy shape never
    // arrives here. Reject explicitly so a future code path that
    // accidentally restores it is caught by the test.
    expect(
      parseCheckoutLocation(loc(`/c/${VALID_SESSION_ID}`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
  });

  it('rejects a path with the wrong leading segment', () => {
    expect(
      parseCheckoutLocation(loc(`/x/c/${VALID_SESSION_ID}`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
    expect(
      parseCheckoutLocation(loc(`/pay/x/${VALID_SESSION_ID}`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
  });

  it('rejects malformed sessionIds (path-traversal style probes)', () => {
    expect(
      parseCheckoutLocation(loc(`/pay/c/cs_../etc/passwd`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
    expect(
      parseCheckoutLocation(loc(`/pay/c/cs_short`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
    expect(
      parseCheckoutLocation(
        loc(`/pay/c/${'abcdefghijklmnopqrstuvwxyz'.toUpperCase()}`, `#k=${VALID_FRAGMENT_KEY}`),
      ),
    ).toBeNull();
    // Lowercase letters not allowed in the 26-char body.
    expect(
      parseCheckoutLocation(loc(`/pay/c/cs_abcdefghijklmnopqrstuvwxyz`, `#k=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
  });

  it('rejects when the fragment is missing', () => {
    expect(parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, ''))).toBeNull();
  });

  it('rejects fragments without `k=`', () => {
    expect(
      parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, `#somethingelse=${VALID_FRAGMENT_KEY}`)),
    ).toBeNull();
  });

  it('rejects fragment keys with the wrong length', () => {
    // base64url(31B) is 42 chars; (33B) is 44 chars. Both must be rejected
    // because the AES-256 key is fixed at 32 bytes.
    expect(parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, `#k=${'A'.repeat(42)}`))).toBeNull();
    expect(parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, `#k=${'A'.repeat(44)}`))).toBeNull();
  });

  it('rejects fragment keys containing forbidden chars', () => {
    expect(parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, `#k=${'!'.repeat(43)}`))).toBeNull();
    // Standard base64 (uses `+` and `/`) must be rejected — base64URL only.
    expect(
      parseCheckoutLocation(
        loc(`/pay/c/${VALID_SESSION_ID}`, `#k=${'+'.repeat(43)}`),
      ),
    ).toBeNull();
  });

  it('handles fragments with a leading `#` and without it', () => {
    // Browsers always include the `#`, but be tolerant on the `slice(1)` path.
    expect(
      parseCheckoutLocation(loc(`/pay/c/${VALID_SESSION_ID}`, `k=${VALID_FRAGMENT_KEY}`)),
    ).toEqual({ sessionId: VALID_SESSION_ID, fragmentKey: VALID_FRAGMENT_KEY });
  });
});

describe('decodeBase64Url', () => {
  it('decodes 32 bytes from a 43-char unpadded string', () => {
    const out = decodeBase64Url(VALID_FRAGMENT_KEY);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });

  it('decodes a known fixture (round-trip with Node Buffer)', () => {
    // Pick a known-bytes input and verify against Node's base64url.
    const sample = Uint8Array.from([
      0xfe, 0xed, 0xfa, 0xce, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
    ]);
    // Manually base64url-encode without padding.
    const encoded = Buffer.from(sample)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const decoded = decodeBase64Url(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(sample));
  });

  it('handles inputs that need each padding length (0, 1, 2)', () => {
    // 1 byte → 2 chars (need 2 pads)
    expect(decodeBase64Url(Buffer.from([0x41]).toString('base64').replace(/=+$/, ''))).toEqual(
      Uint8Array.from([0x41]),
    );
    // 2 bytes → 3 chars (need 1 pad)
    expect(
      decodeBase64Url(Buffer.from([0x41, 0x42]).toString('base64').replace(/=+$/, '')),
    ).toEqual(Uint8Array.from([0x41, 0x42]));
    // 3 bytes → 4 chars (no pad)
    expect(
      decodeBase64Url(Buffer.from([0x41, 0x42, 0x43]).toString('base64').replace(/=+$/, '')),
    ).toEqual(Uint8Array.from([0x41, 0x42, 0x43]));
  });
});
