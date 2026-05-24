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

// Option D · Commit 1 (D-3) — TTL ceiling 28_800s enforced server-side.
// Pre-D3 fixture used a 1-billion-second delta which now trips the
// new superRefine. Use a 4h delta (canonical default Scoped TTL).
function validSnapshot(): Record<string, unknown> {
  return {
    sessionId: 'session-abc-123',
    mode: 'scoped',
    signerAddress: VALID_ADDR,
    targetContracts: [VALID_SUBSCRIPTION],
    selectorCaps: [
      { selector: VALID_SELECTOR, capArgIndex: 2, maxAmount: '1000000' },
    ],
    mintedAtSec: 1_000_000_000,
    validUntilSec: 1_000_000_000 + 14_400, // +4h (default Scoped TTL)
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

  it('Option D · D-3 — REJECTS TTL > 28_800s (8h ceiling, SecEng-HIGH-1)', () => {
    const body = validBody();
    const snap = body.snapshot as Record<string, unknown>;
    snap.mintedAtSec = 1_000_000_000;
    // 28_801s — just over the ceiling. Server-side enforcement is
    // load-bearing because non-dashboard clients (MCP, havenbot,
    // etc.) can bypass the frontend's 8h picker.
    snap.validUntilSec = 1_000_000_000 + 28_801;
    expect(() => MintScopedSessionDtoSchema.parse(body)).toThrow(
      /Option D · D-3 ceiling/,
    );
  });

  it('Option D · D-3 — ACCEPTS TTL exactly at the 28_800s ceiling', () => {
    const body = validBody();
    const snap = body.snapshot as Record<string, unknown>;
    snap.mintedAtSec = 1_000_000_000;
    snap.validUntilSec = 1_000_000_000 + 28_800;
    expect(() => MintScopedSessionDtoSchema.parse(body)).not.toThrow();
  });

  it('Option D · D-3 — REJECTS TTL ≤ 0 (validUntilSec <= mintedAtSec)', () => {
    const body = validBody();
    const snap = body.snapshot as Record<string, unknown>;
    snap.mintedAtSec = 1_000_000_000;
    snap.validUntilSec = 1_000_000_000; // delta = 0
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

// ─────────────────────────────────────────────────────────────────────────
// Wave 5 Option D · Commit 2 — install-material wire validation.
// ─────────────────────────────────────────────────────────────────────────

describe('MintScopedSessionDtoSchema — Option D · C2 install material', () => {
  const minimalEnableData = `0x${'cd'.repeat(64)}`; // 128 hex (well inside 2-8192 bound)
  // SecEng H-3 raised the enableSig lower bound from 128 → 256 hex
  // to reject bare 65-byte ECDSA downgrades.
  const minimalEnableSig = `0x${'ab'.repeat(128)}`; // 256 hex (clears 256-floor)

  function withInstallMaterial(extras: Record<string, unknown>): Record<string, unknown> {
    return {
      ...validBody(),
      snapshot: {
        ...validSnapshot(),
        permissionId: VALID_PERMISSION_ID,
        ...extras,
      },
    };
  }

  it('accepts a snapshot WITHOUT install material (back-compat with pre-C2 clients)', () => {
    // The `.optional()` gate is load-bearing — legacy frontends + hand-
    // curled POSTs continue to mint successfully; the row lands with
    // NULL enable_data / enable_sig + NULL enable_status, and the
    // existing fallback chain degrades to Path C deep-link.
    const body = validBody();
    expect(() => MintScopedSessionDtoSchema.parse(body)).not.toThrow();
  });

  it('accepts a snapshot WITH all three install material fields', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 0,
        }),
      ),
    ).not.toThrow();
  });

  it('REJECTS enableData missing 0x prefix', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableData: 'cd'.repeat(64) }),
      ),
    ).toThrow();
  });

  it('REJECTS enableData with non-hex chars', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableData: `0x${'gg'.repeat(64)}` }),
      ),
    ).toThrow();
  });

  it('REJECTS enableData empty payload (0x with zero hex chars)', () => {
    // Kernel rejects 0-byte validatorData at install — fail fast at
    // the DTO boundary so we don't waste a mirror row + UserOp gas.
    expect(() =>
      MintScopedSessionDtoSchema.parse(withInstallMaterial({ enableData: '0x' })),
    ).toThrow();
  });

  it('REJECTS enableData exceeding the 65536-char cleartext ceiling', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: `0x${'a'.repeat(65537)}`,
          enableSig: minimalEnableSig,
          validatorNonce: 1,
        }),
      ),
    ).toThrow();
  });

  it('accepts enableData at realistic prod size (~30KB hex, ~125 permissions)', () => {
    // Hot-patch 2026-05-23 — the original 8192 ceiling rejected every
    // real prod mint because SCOPED_AUTONOMOUS_PERMISSIONS yields a
    // 30KB hex payload. This case pins the regression — a future
    // tightening of the ceiling that ignores the real policy count
    // would re-introduce the production outage.
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: `0x${'cd'.repeat(15000)}`, // 30000 hex chars
          enableSig: minimalEnableSig,
          validatorNonce: 1,
        }),
      ),
    ).not.toThrow();
  });

  it('accepts enableSig at the lower bound (256 hex chars, WebAuthn-envelope floor)', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 1,
        }),
      ),
    ).not.toThrow();
  });

  it('REJECTS enableSig below the 256-hex floor (downgrade defense)', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableSig: `0x${'ab'.repeat(127)}` }),
      ),
    ).toThrow();
  });

  it('REJECTS bare 65-byte ECDSA-shaped enableSig (SecEng H-3 downgrade defense)', () => {
    // Plain ECDSA (r,s,v) = 65 bytes = 130 hex. Under the C2 invariant
    // the SUDO validator is always passkey-validator → enableSig must
    // be a WebAuthn envelope. Tightened floor bounces this shape at
    // the wire.
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableSig: `0x${'ab'.repeat(65)}` }),
      ),
    ).toThrow();
  });

  it('REJECTS enableSig above the 16384-hex ceiling', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: `0x${'ab'.repeat(8193)}`, // 16386 hex
          validatorNonce: 1,
        }),
      ),
    ).toThrow();
  });

  it('accepts validatorNonce at uint32 bounds (0 and 2^32-1)', () => {
    // The all-or-none refine requires enableData + enableSig present
    // alongside any validatorNonce value; bounds check supplies all three.
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 0,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 4_294_967_295,
        }),
      ),
    ).not.toThrow();
  });

  it('REJECTS validatorNonce > uint32 max (with full install material to isolate the range gate)', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 4_294_967_296,
        }),
      ),
    ).toThrow();
  });

  it('REJECTS validatorNonce non-integer or negative (with full install material to isolate the integer gate)', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: 1.5,
        }),
      ),
    ).toThrow();
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
          validatorNonce: -1,
        }),
      ),
    ).toThrow();
  });

  it('REJECTS partial install material (enableSig alone, missing enableData + validatorNonce)', () => {
    // SecEng M-2 + Codex L-3 — the trio must be all-or-none. A partial
    // capture lands a half-broken row C3 can't compose against.
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableSig: minimalEnableSig }),
      ),
    ).toThrow(/install material .* must be all-present or all-absent/i);
  });

  it('REJECTS partial install material (enableData + enableSig, missing validatorNonce)', () => {
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({
          enableData: minimalEnableData,
          enableSig: minimalEnableSig,
        }),
      ),
    ).toThrow(/install material .* must be all-present or all-absent/i);
  });

  it('REJECTS unknown snapshot fields under the strict guard (still strict with C2 additions)', () => {
    // Defense against a future bug where the strict() gate gets lost
    // in a refactor — any extra field that isn't in the schema should
    // bounce, including a typo of one of the install-material fields.
    expect(() =>
      MintScopedSessionDtoSchema.parse(
        withInstallMaterial({ enableDatum: minimalEnableData }),
      ),
    ).toThrow();
  });
});

// GetInstallMaterialQuerySchema removed in the C3 third commit — the
// install-material route moved to user-JWT auth (userId from the JWT
// subject, no query param to validate). Its tests are removed with it.
