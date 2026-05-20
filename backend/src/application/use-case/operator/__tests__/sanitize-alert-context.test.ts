import { beforeAll, describe, expect, it } from 'vitest';
import { sanitizeAlertContext } from '../sanitize-alert-context.js';

// `getLogger` is memoized on `core/config.ts` parse. Sanitiser itself
// doesn't log, but `core/errors.ts` (transitively imported via the
// transport schema in the sibling use-case test) needs JWT_SECRET to
// resolve. Set defensively so adjacent tests in the same vitest run
// don't trip env validation.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

const KNOWN_TOKEN = '0x1d6C140204F21835F1AF2A0615826A333827d946'; // USYC

describe('sanitizeAlertContext — whitelist', () => {
  it('reads err.name + err.shortMessage; ignores cause/data/metaMessages/stack', () => {
    const err = {
      name: 'ZeroRateError',
      shortMessage: 'rate floored to 0',
      message: 'rate floored to 0',
      cause: { sensitive: '0xdeadbeef'.repeat(8) }, // 64-hex blob — must not leak
      data: '0x' + 'a'.repeat(40), // 40-hex address-shaped — must not leak
      metaMessages: ['raw revert: 0x' + 'b'.repeat(64)],
      stack: 'Error: ZeroRateError\n    at someFn (/secret/path/to/file.ts:123)',
    };
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('ZeroRateError');
    expect(payload.shortMessage).toBe('rate floored to 0');
    expect(payload.shortMessage).not.toContain('deadbeef');
    expect(payload.shortMessage).not.toContain('cause');
    expect(payload.shortMessage).not.toContain('metaMessages');
    expect(payload.shortMessage).not.toContain('stack');
    expect(payload.shortMessage).not.toContain('/secret/path/');
  });

  it('falls back to err.message when shortMessage is absent', () => {
    const err = new Error('plain error here');
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('Error');
    expect(payload.shortMessage).toBe('plain error here');
  });

  it('falls back to err.name when neither shortMessage nor message is present', () => {
    const err = { name: 'CustomErr' };
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('CustomErr');
    expect(payload.shortMessage).toBe('CustomErr');
  });

  it('handles non-Error thrown values', () => {
    const payload = sanitizeAlertContext({ err: 'naked string', tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('UnknownError');
    expect(payload.shortMessage).toBe('unknown');
  });

  it('handles null thrown value', () => {
    const payload = sanitizeAlertContext({ err: null, tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('UnknownError');
    expect(payload.shortMessage).toBe('unknown');
  });

  it('handles undefined thrown value', () => {
    const payload = sanitizeAlertContext({ err: undefined, tokenSymbol: 'USYC' });
    expect(payload.errorClass).toBe('UnknownError');
    expect(payload.shortMessage).toBe('unknown');
  });
});

describe('sanitizeAlertContext — regex pass 1: tx-hash / FHE handle', () => {
  it('redacts a 64-hex string with 0x prefix', () => {
    const err = new Error(
      'fund tx 0x' + 'a'.repeat(64) + ' reverted on-chain',
    );
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('0x…tx');
    expect(payload.shortMessage).not.toContain('a'.repeat(64));
  });

  it('redacts multiple tx hashes in one message', () => {
    const err = new Error(
      'tx1 0x' + 'a'.repeat(64) + ' tx2 0x' + 'b'.repeat(64),
    );
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).not.toContain('a'.repeat(64));
    expect(payload.shortMessage).not.toContain('b'.repeat(64));
    const matches = payload.shortMessage.match(/0x…tx/g);
    expect(matches?.length).toBe(2);
  });
});

describe('sanitizeAlertContext — regex pass 2: EVM address', () => {
  it('redacts unknown 40-hex addresses', () => {
    const err = new Error('grant to 0x' + 'c'.repeat(40) + ' failed');
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('0x…addr');
    expect(payload.shortMessage).not.toContain('c'.repeat(40));
  });

  it('matches known token address case-blind but emits the canonical form (Reality MED-3)', () => {
    // Input contains lowercase; canonical form is mixed-case checksum.
    // The output MUST be the caller's canonical form, NOT the
    // attacker-controlled case-shape from the input message.
    const err = new Error(`fund failed for token ${KNOWN_TOKEN.toLowerCase()}`);
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN, // canonical (mixed-case checksum)
    });
    expect(payload.shortMessage).toContain(KNOWN_TOKEN);
    // Lowercase form from the input must NOT survive — that's the
    // phishing-primitive bug round 2 surfaced.
    expect(payload.shortMessage).not.toContain(KNOWN_TOKEN.toLowerCase());
    expect(payload.shortMessage).not.toContain('0x…addr');
  });

  it('emits the canonical form even when the input is mid-case', () => {
    // Attacker could try a wrong-checksum case to spoof Etherscan
    // autocorrect to a DIFFERENT address. Sanitiser must overwrite.
    const attackerCase = KNOWN_TOKEN.toUpperCase().replace('0X', '0x');
    const err = new Error(`fund failed for token ${attackerCase}`);
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    expect(payload.shortMessage).toContain(KNOWN_TOKEN);
    expect(payload.shortMessage).not.toContain(attackerCase);
  });

  it('preserves the known token address when it appears alongside other addresses', () => {
    const otherAddr = '0x' + 'd'.repeat(40);
    const err = new Error(
      `fund for ${KNOWN_TOKEN} from operator ${otherAddr} reverted`,
    );
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    expect(payload.shortMessage).toContain(KNOWN_TOKEN);
    expect(payload.shortMessage).not.toContain(otherAddr);
    expect(payload.shortMessage).toContain('0x…addr');
  });

  it('redacts ALL addresses when no known token address is supplied', () => {
    const err = new Error(`fund for ${KNOWN_TOKEN} reverted`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).not.toContain(KNOWN_TOKEN.toLowerCase());
    expect(payload.shortMessage).toContain('0x…addr');
  });
});

describe('sanitizeAlertContext — regex pass 3: base64 opaque blob', () => {
  it('redacts a 40+ char base64-shape string', () => {
    const cipher = 'AbCd' + '1'.repeat(36) + '==';
    const err = new Error(`cofhe encrypt failed at handle ${cipher}`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('[…opaque]');
    expect(payload.shortMessage).not.toContain(cipher);
  });

  it('does NOT redact short base64-shape strings (< 40 chars)', () => {
    const shortish = 'AbCd1234' + 'EfGh5678';
    const err = new Error(`short tag ${shortish} present`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain(shortish);
  });
});

describe('sanitizeAlertContext — pass ordering', () => {
  it('does NOT let the address pass partially-match a tx hash prefix', () => {
    // 64-hex tx hash that happens to start with a valid 40-hex prefix.
    // If the address pass ran first, the prefix would be substituted
    // with `0x…addr` and the trailing 24 hex chars would leak. The
    // 64-hex pass runs FIRST → the whole thing becomes `0x…tx`.
    const hash = '0x' + 'e'.repeat(64);
    const err = new Error(`receipt for ${hash} missing`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('0x…tx');
    expect(payload.shortMessage).not.toContain('0x…addr');
    // No 24-char hex suffix leaked.
    expect(payload.shortMessage).not.toMatch(/[a-fA-F0-9]{24}/);
  });

  it('lets the base64 pass run last so it never over-redacts hex content', () => {
    const err = new Error(
      `mixed: 0x${'1'.repeat(64)} then plain text and a long alphanum ${'A'.repeat(20)}${'1'.repeat(20)}`,
    );
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    // tx hash gone, base64 blob redacted, plain text preserved
    expect(payload.shortMessage).toContain('0x…tx');
    expect(payload.shortMessage).toContain('[…opaque]');
    expect(payload.shortMessage).toContain('plain text');
  });
});

describe('sanitizeAlertContext — length caps', () => {
  it('caps errorClass at 64 chars', () => {
    const err = { name: 'A'.repeat(120), message: 'short' };
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.errorClass.length).toBe(64);
  });

  it('caps shortMessage at 1024 chars AFTER sanitisation', () => {
    // 'a '.repeat(...) avoids the base64 pass's 40-char run threshold
    // (spaces break the [A-Za-z0-9+/] continuity). Pure 'a'.repeat()
    // would otherwise match `[A-Za-z0-9+/]{40,}` and collapse to
    // `[…opaque]` — orthogonal to what we're testing here (length
    // cap).
    const long = 'a '.repeat(1500); // 3000 chars, no base64 run
    const err = new Error(long);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage.length).toBe(1024);
    expect(payload.shortMessage).not.toContain('[…opaque]');
  });

  it('caps shortMessage AFTER regex replacement (post-substitution length)', () => {
    // Construct a message ~1117 chars BEFORE redaction; one tx hash at
    // the START gets substituted to `0x…tx` (5 chars), so post-
    // redaction is ~1056 chars — still over 1024 → capped at 1024. The
    // tx-hash sentinel is at the start so the slice keeps it (proving
    // the cap measures post-substitution length, not pre-cap length).
    // Same 'x '.repeat() trick to dodge the base64 pass.
    const body = '0x' + 'a'.repeat(64) + ' ' + 'x '.repeat(525); // 66+1+1050 = 1117
    const err = new Error(body);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage.length).toBe(1024);
    expect(payload.shortMessage.startsWith('0x…tx')).toBe(true);
  });
});

describe('sanitizeAlertContext — round 1 review HIGH fixes', () => {
  it('preserves ALL occurrences of the known token address (not just the first)', () => {
    // Round-1 Code-Reviewer + Security-Engineer regression: an earlier
    // impl used `String.prototype.replace(literalPlaceholder, ...)`
    // for restoration, which only substitutes the first occurrence.
    // Two consecutive mentions of the same known address left the
    // second as a permanent placeholder in the alert.
    const err = new Error(`fund failed: ${KNOWN_TOKEN} then ${KNOWN_TOKEN}`);
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    // Both occurrences restored.
    const matches = payload.shortMessage.match(
      new RegExp(KNOWN_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    );
    expect(matches?.length).toBe(2);
    // No sentinel or legacy placeholder leaks through.
    expect(payload.shortMessage).not.toContain('__ADDR_PRESERVED_');
    expect(payload.shortMessage).not.toContain('');
  });

  it('strips attacker-injected SOH sentinel chars from the input', () => {
    // Round-1 Code-Reviewer HIGH + Security H-1: if the input contains
    // the sentinel control char, an attacker could (in the prior
    // __ADDR_PRESERVED_<n>__ design) trigger a swap-substitution that
    // moves the real address to where the attacker placed the literal.
    // The fix strips ALL sentinel chars from the input BEFORE
    // substitution so injection becomes impossible by construction.
    const err = new Error(
      `evil prefix A0Z inject and then ${KNOWN_TOKEN} real`,
    );
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    // Sentinel stripped.
    expect(payload.shortMessage).not.toContain('');
    // Real known address still present (preservation logic intact).
    expect(payload.shortMessage).toContain(KNOWN_TOKEN);
  });

  it('strips SOH from the input even when no known token address is configured', () => {
    const err = new Error('error with  control char somewhere');
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).not.toContain('');
    expect(payload.shortMessage).toContain('error with');
  });

  it('preserves UTF-16 surrogate pairs at the length-cap boundary', () => {
    // Round-1 Code-Reviewer MED: `.slice` operates on code units, not
    // code points. A character outside the BMP (e.g. 𝐀 = U+1D400, two
    // UTF-16 units) can be split mid-pair by `.slice(0, 1024)`,
    // producing a lone high surrogate. The cap helper steps back by 1
    // when the boundary char is a high surrogate.
    //
    // Construct: 1023 ASCII chars + '𝐀' (2 code units, total 1025
    // code units). Naive slice would land at index 1024, between the
    // two halves of the surrogate pair. Fixed slice should be 1023
    // (drops the BMP-pair entirely).
    const long = 'x'.repeat(1023) + '𝐀'; // '𝐀'
    const err = new Error(long);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    // Last char must NOT be a lone high surrogate.
    const lastCode = payload.shortMessage.charCodeAt(payload.shortMessage.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it('trims a partial address tail when the length cap would otherwise split mid-address', () => {
    // Round-1 Security H-2: when a restored 42-char address lands at
    // the slice boundary, the `0x[hex]{1,39}` tail looks like an
    // address prefix and leaks. Cap helper detects the trailing
    // partial and trims back to before the `0x`.
    //
    // Construct: 1010 ASCII + ' ' + KNOWN_TOKEN (42 chars). Total
    // 1053 chars. Slice at 1024 lands at offset 1024 — index 1024
    // is at char 13 of the address (`0x1d6c14020`). Fixed slice should
    // walk back to before the `0x` (index 1011).
    const prefix = 'a '.repeat(505); // 1010 chars, no base64 run
    const err = new Error(`${prefix} ${KNOWN_TOKEN}`); // 1010 + 1 + 42 = 1053
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    // No `0x` followed by 1-39 hex chars at the tail.
    expect(payload.shortMessage).not.toMatch(/0x[a-fA-F0-9]{1,39}$/);
    // The full known address (if kept) is fine; what's banned is a
    // PARTIAL prefix.
    expect(payload.shortMessage.length).toBeLessThanOrEqual(1024);
  });
});

describe('sanitizeAlertContext — round 2 Reality H-1 (trailing-hex leak closure)', () => {
  // Round-2 Reality-Checker HIGH-1: non-anchored regexes leaked
  // trailing hex past the 40 / 64 cap. Specifically:
  //   - `0x` + 41 hex → old impl: `0x…addra` (1 hex leak); fixed: `[…opaque]`
  //   - `0x` + 50 hex → old impl: `0x…addr...10 chars...` (10 hex leak)
  //   - `0x` + 63 hex → old impl: `0x…addr...23 chars...` (23 hex leak)
  //   - `0x` + 70 hex → old impl: `0x…tx...6 chars...` (6 hex leak past tx)
  //   - `0x` + 100 hex → old impl: `0x…tx...36 chars...` (36 hex leak)
  //
  // Fix: greedy `{64,}` on TX pass + negative lookahead `(?![hex])` on
  // ADDRESS pass. Hex runs in [41, 63] and [65, 103] now fall through
  // to the base64 pass which catches via `{40,}`.
  it('redacts 0x + 41 hex without leaking the 41st char', () => {
    const err = new Error(`leak prefix 0x${'a'.repeat(41)} suffix`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    // No 0x + 1+ hex tail at all (would mean partial-redaction leaked).
    expect(payload.shortMessage).not.toMatch(/0x[a-fA-F0-9]+/);
    // Caught by base64 pass.
    expect(payload.shortMessage).toContain('[…opaque]');
  });

  it('redacts 0x + 50 hex without leaking the trailing 10 chars', () => {
    const err = new Error(`leak prefix 0x${'a'.repeat(50)} suffix`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).not.toMatch(/0x[a-fA-F0-9]+/);
    expect(payload.shortMessage).not.toContain('a'.repeat(10));
    expect(payload.shortMessage).toContain('[…opaque]');
  });

  it('redacts 0x + 63 hex without leaking the trailing 23 chars', () => {
    const err = new Error(`leak prefix 0x${'a'.repeat(63)} suffix`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).not.toMatch(/0x[a-fA-F0-9]+/);
    expect(payload.shortMessage).not.toContain('a'.repeat(23));
    expect(payload.shortMessage).toContain('[…opaque]');
  });

  it('redacts 0x + 65 hex (1 char past TX cap) as a single 0x…tx', () => {
    const err = new Error(`leak prefix 0x${'a'.repeat(65)} suffix`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    // Greedy {64,} swallows the whole run.
    expect(payload.shortMessage).toContain('0x…tx');
    expect(payload.shortMessage).not.toContain('a'.repeat(2));
    // No trailing hex past `0x…tx`.
    expect(payload.shortMessage).not.toMatch(/0x…tx[a-fA-F0-9]/);
  });

  it('redacts 0x + 100 hex as a single 0x…tx with no 36-char tail', () => {
    const err = new Error(`leak prefix 0x${'a'.repeat(100)} suffix`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('0x…tx');
    expect(payload.shortMessage).not.toContain('a'.repeat(36));
    expect(payload.shortMessage).not.toMatch(/0x…tx[a-fA-F0-9]/);
  });

  it('still redacts a normal address (0x + 40 hex) followed by non-hex correctly', () => {
    const otherAddr = '0x' + 'c'.repeat(40);
    const err = new Error(`grant to ${otherAddr} failed`);
    const payload = sanitizeAlertContext({ err, tokenSymbol: 'USYC' });
    expect(payload.shortMessage).toContain('0x…addr');
    expect(payload.shortMessage).not.toContain('c'.repeat(40));
  });

  it('redacts known-address followed by trailing hex (no partial-leak)', () => {
    // Pre-fix: `<knownAddr><10 hex>` matched the address pass on first
    // 40 chars (leaving 10 hex trailing). With the negative lookahead,
    // the 40-hex match REFUSES (because hex follows). Falls through to
    // base64 pass which catches the whole 50-hex run as `[…opaque]`.
    // The known-address preservation never fires in this branch — that
    // matches the threat model (an attacker concatenating trailing hex
    // is trying to bypass the preserve-then-leak pattern).
    const err = new Error(`fund for ${KNOWN_TOKEN}${'a'.repeat(10)} reverted`);
    const payload = sanitizeAlertContext({
      err,
      tokenSymbol: 'USYC',
      tokenAddress: KNOWN_TOKEN,
    });
    // No partial address leak.
    expect(payload.shortMessage).not.toMatch(/0x[a-fA-F0-9]{1,39}(?:[^a-fA-F0-9]|$)/);
    // Base64 pass collapsed the whole hex blob.
    expect(payload.shortMessage).toContain('[…opaque]');
  });
});

describe('sanitizeAlertContext — pass-through fields', () => {
  it('passes tokenSymbol through unchanged', () => {
    const payload = sanitizeAlertContext({
      err: new Error('x'),
      tokenSymbol: 'syrupUSDC',
    });
    expect(payload.tokenSymbol).toBe('syrupUSDC');
  });

  it('passes epochId through as bigint when supplied', () => {
    const payload = sanitizeAlertContext({
      err: new Error('x'),
      tokenSymbol: 'USYC',
      epochId: 42n,
    });
    expect(payload.epochId).toBe(42n);
  });

  it('omits epochId when not supplied', () => {
    const payload = sanitizeAlertContext({
      err: new Error('x'),
      tokenSymbol: 'USYC',
    });
    expect(payload.epochId).toBeUndefined();
  });

  it('defaults severity to error', () => {
    const payload = sanitizeAlertContext({
      err: new Error('x'),
      tokenSymbol: 'USYC',
    });
    expect(payload.severity).toBe('error');
  });

  it('honors severity override', () => {
    const payload = sanitizeAlertContext({
      err: new Error('x'),
      tokenSymbol: 'USYC',
      severity: 'warn',
    });
    expect(payload.severity).toBe('warn');
  });
});
