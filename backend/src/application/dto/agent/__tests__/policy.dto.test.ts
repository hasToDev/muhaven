import { describe, it, expect } from 'vitest';
import {
  GetScopedSessionQuerySchema,
  MintScopedSessionDtoSchema,
  RevokeScopedSessionParamsSchema,
  ScopedSelectorCapSchema,
} from '../policy.dto.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A — focused Zod coverage for the
 * scoped-session wire schemas. Per memory
 * `feedback_sql_bugs_need_real_pg_integration_test`: the same heuristic
 * one layer up — DTO refinements not covered by direct schema tests can
 * silently regress when someone touches the schema next.
 *
 * The use-case tests exercise the happy path (`makeDto()` produces a
 * well-formed value). This file exercises the REFUSAL surface: every
 * branch of the Zod gate that should bounce a malformed input.
 */

const VALID_SELECTOR = '0xdeadbeef';
const VALID_ADDR = '0xaaaa000000000000000000000000000000000001';
const VALID_SUBSCRIPTION = '0xbbbb000000000000000000000000000000000002';
const VALID_HASH32 = '0x' + 'a'.repeat(64);
const VALID_PERMISSION_ID = '0xdeadbeef';

function validSnapshot(): Record<string, unknown> {
  return {
    sessionId: 'session-abc-123',
    mode: 'scoped',
    signerAddress: VALID_ADDR,
    targetContracts: [VALID_SUBSCRIPTION],
    selectorCaps: [
      { selector: VALID_SELECTOR, capArgIndex: 2, maxAmount: '1000000' },
    ],
    validUntilSec: 2_000_000_000,
    mintedAtSec: 1_000_000_000,
  };
}

function validBody(): Record<string, unknown> {
  return {
    surface: 'mcp',
    maxPerOpUsd6: '100000000',
    snapshot: validSnapshot(),
  };
}

describe('ScopedSelectorCapSchema', () => {
  it('accepts a 4-byte hex selector with paired capArgIndex + maxAmount', () => {
    const parsed = ScopedSelectorCapSchema.parse({
      selector: VALID_SELECTOR,
      capArgIndex: 2,
      maxAmount: '1000000',
    });
    expect(parsed.selector).toBe(VALID_SELECTOR);
  });

  it('accepts both-null capArgIndex+maxAmount (nullary-selector future case)', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: null,
        maxAmount: null,
      }),
    ).not.toThrow();
  });

  it('REJECTS capArgIndex null with maxAmount non-null (paired-nullness)', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: null,
        maxAmount: '1',
      }),
    ).toThrow();
  });

  it('REJECTS capArgIndex non-null with maxAmount null (paired-nullness)', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: 0,
        maxAmount: null,
      }),
    ).toThrow();
  });

  it('REJECTS capArgIndex > 31 (out of ABI-word range)', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: 32,
        maxAmount: '1',
      }),
    ).toThrow();
  });

  it('REJECTS capArgIndex < 0', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: -1,
        maxAmount: '1',
      }),
    ).toThrow();
  });

  it('REJECTS malformed selector (not 0x-prefixed 4-byte hex)', () => {
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: 'deadbeef',
        capArgIndex: 0,
        maxAmount: '1',
      }),
    ).toThrow();
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: '0xdead',
        capArgIndex: 0,
        maxAmount: '1',
      }),
    ).toThrow();
  });

  it('REJECTS maxAmount that decimal-overflows uint256 max (2^256 - 1)', () => {
    const overflow = '1' + '0'.repeat(78); // 10^78 > 2^256 - 1
    expect(() =>
      ScopedSelectorCapSchema.parse({
        selector: VALID_SELECTOR,
        capArgIndex: 0,
        maxAmount: overflow,
      }),
    ).toThrow();
  });
});

describe('MintScopedSessionDtoSchema', () => {
  it('accepts a well-formed body', () => {
    expect(() => MintScopedSessionDtoSchema.parse(validBody())).not.toThrow();
  });

  it('accepts a body with optional consent hashes + permissionId', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).consentActionHash = VALID_HASH32;
    (body.snapshot as Record<string, unknown>).consentTextSha256 = VALID_HASH32;
    (body.snapshot as Record<string, unknown>).permissionId = VALID_PERMISSION_ID;
    expect(() => MintScopedSessionDtoSchema.parse(body)).not.toThrow();
  });

  it('REJECTS duplicate selectors in selectorCaps', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).selectorCaps = [
      { selector: VALID_SELECTOR, capArgIndex: 0, maxAmount: '1' },
      { selector: VALID_SELECTOR, capArgIndex: 2, maxAmount: '2' },
    ];
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS duplicate selectors even with mixed case (lowercased dedup)', () => {
    // The refinement lowercases for dedup; mixed-case duplicates fail.
    const body = validBody();
    (body.snapshot as Record<string, unknown>).selectorCaps = [
      { selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '1' },
      { selector: '0xDEADBEEF', capArgIndex: 2, maxAmount: '2' },
    ];
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS empty targetContracts array', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).targetContracts = [];
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS empty selectorCaps array', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).selectorCaps = [];
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS more than 32 targetContracts (sanity bound)', () => {
    const body = validBody();
    const tooMany = Array.from(
      { length: 33 },
      (_, i) => `0x${i.toString(16).padStart(40, '0')}`,
    );
    (body.snapshot as Record<string, unknown>).targetContracts = tooMany;
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS mode !== "scoped" (Slice 4 wildcard not shipped here)', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).mode = 'wildcard';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS missing mode field (regression catcher for a future .optional() drift)', () => {
    // The schema enforces `z.literal('scoped')` as a required field. A
    // future relaxation to `.optional()` would silently accept the
    // omission — this test pins the contract.
    const body = validBody();
    delete (body.snapshot as Record<string, unknown>).mode;
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS malformed signerAddress (not 0x + 40 hex)', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).signerAddress = '0xshort';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS validUntilSec <= 0', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).validUntilSec = 0;
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS mintedAtSec <= 0', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).mintedAtSec = -1;
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS maxPerOpUsd6 that overflows uint256', () => {
    const body = validBody();
    body.maxPerOpUsd6 = '1' + '0'.repeat(78);
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS negative maxPerOpUsd6 (regex disallows leading minus)', () => {
    const body = validBody();
    body.maxPerOpUsd6 = '-1';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS unknown extra fields on snapshot (strict)', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).bogus = 'field';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS malformed permissionId when provided (must be 4-byte hex)', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).permissionId = '0xdead';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });

  it('REJECTS malformed consentActionHash when provided', () => {
    const body = validBody();
    (body.snapshot as Record<string, unknown>).consentActionHash = '0xshort';
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow();
  });
});

describe('RevokeScopedSessionParamsSchema', () => {
  it('accepts a well-formed sessionId', () => {
    expect(
      RevokeScopedSessionParamsSchema.parse({ sessionId: 'session-abc-123' }),
    ).toEqual({ sessionId: 'session-abc-123' });
  });

  it('REJECTS a sessionId with disallowed characters', () => {
    expect(() =>
      RevokeScopedSessionParamsSchema.parse({ sessionId: 'has spaces' }),
    ).toThrow();
    expect(() =>
      RevokeScopedSessionParamsSchema.parse({ sessionId: 'a/b' }),
    ).toThrow();
    expect(() =>
      RevokeScopedSessionParamsSchema.parse({ sessionId: 'a.b' }),
    ).toThrow();
  });

  it('REJECTS empty string', () => {
    expect(() => RevokeScopedSessionParamsSchema.parse({ sessionId: '' })).toThrow();
  });

  it('REJECTS sessionId > 128 chars (path-traversal guard upper bound)', () => {
    expect(() =>
      RevokeScopedSessionParamsSchema.parse({ sessionId: 'a'.repeat(129) }),
    ).toThrow();
  });
});

describe('GetScopedSessionQuerySchema', () => {
  it('accepts a known surface', () => {
    expect(GetScopedSessionQuerySchema.parse({ surface: 'mcp' })).toEqual({
      surface: 'mcp',
    });
  });

  it('REJECTS unknown surface', () => {
    expect(() =>
      GetScopedSessionQuerySchema.parse({ surface: 'unknown' }),
    ).toThrow();
  });

  it('REJECTS missing surface (required field)', () => {
    expect(() => GetScopedSessionQuerySchema.parse({})).toThrow();
  });
});
