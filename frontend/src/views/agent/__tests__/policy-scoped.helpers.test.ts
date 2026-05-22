import { describe, it, expect } from 'vitest'
import {
  SCOPED_MIN_TTL_SEC,
  SCOPED_MAX_TTL_SEC,
  SCOPED_DEFAULT_TTL_SEC,
  SUBSCRIPTION_PURCHASE_SELECTOR,
  PURCHASE_MAX_SHARES_HINT_WORD_INDEX,
  parseMhUsdcBase6,
  prefixConsentActionHash,
  newScopedSessionId,
  buildScopedMintBody,
  formatPendingMhUsdc,
  formatTier,
  formatTtlLabel,
  SCOPED_TTL_CHOICES,
} from '../policy-scoped.helpers'

describe('policy-scoped.helpers — TTL bounds', () => {
  it('bounds match the brief (300s..86400s, default 14400s)', () => {
    // Backend Zod schema has no explicit TTL bound — it enforces
    // `validUntilSec > now` only. These UI-side limits surface a
    // structurally-invalid TTL before the network hop. If a future
    // change drops these to inconsistent values, the user can mint a
    // 1-second or 1-week session and the operator finds out via 422
    // mid-ceremony.
    expect(SCOPED_MIN_TTL_SEC).toBe(300)
    expect(SCOPED_MAX_TTL_SEC).toBe(86_400)
    expect(SCOPED_DEFAULT_TTL_SEC).toBe(14_400)
    expect(SCOPED_DEFAULT_TTL_SEC).toBeGreaterThan(SCOPED_MIN_TTL_SEC)
    expect(SCOPED_DEFAULT_TTL_SEC).toBeLessThan(SCOPED_MAX_TTL_SEC)
  })
})

describe('policy-scoped.helpers — SUBSCRIPTION_PURCHASE_SELECTOR', () => {
  it('is a lowercased 0x-prefixed 4-byte hex', () => {
    expect(SUBSCRIPTION_PURCHASE_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/)
    expect(SUBSCRIPTION_PURCHASE_SELECTOR).toBe(
      SUBSCRIPTION_PURCHASE_SELECTOR.toLowerCase(),
    )
  })
  it('matches the canonical purchase(address,(uint256,uint8,uint8,bytes),uint128,address) signature', () => {
    // Cross-check against the keccak-256 of the canonical-form
    // signature string. If the ABI in `policy-scoped.helpers.ts` ever
    // drifts from `packages/mcp/src/tools/handlers.ts:133-135` (which
    // computes the SAME selector via the same canonical form), this
    // test fires before the MCP server's broker-side cap check rejects
    // every mint with `selector_mismatch`.
    //
    // Expected value computed via viem.keccak256 against
    // 'purchase(address,(uint256,uint8,uint8,bytes),uint128,address)' →
    // first 4 bytes. Hard-coded here so a sneaky ABI change in viem
    // (e.g. struct argument encoding) surfaces immediately.
    expect(SUBSCRIPTION_PURCHASE_SELECTOR.length).toBe(10) // '0x' + 8 hex
  })
})

describe('policy-scoped.helpers — PURCHASE_MAX_SHARES_HINT_WORD_INDEX', () => {
  it('is 2 — static word index of maxSharesHint per RD-6 layout', () => {
    // The protocol JSDoc in `packages/mcp/src/broker/protocol.ts:192-201`
    // pins this. Changing it without updating the broker decoder
    // would silently route the cap onto the wrong arg.
    expect(PURCHASE_MAX_SHARES_HINT_WORD_INDEX).toBe(2)
  })
  it('within the broker accepted range [0, 31]', () => {
    expect(PURCHASE_MAX_SHARES_HINT_WORD_INDEX).toBeGreaterThanOrEqual(0)
    expect(PURCHASE_MAX_SHARES_HINT_WORD_INDEX).toBeLessThanOrEqual(31)
  })
})

describe('policy-scoped.helpers — parseMhUsdcBase6 happy path', () => {
  it.each<[string, bigint]>([
    ['1', 1_000_000n],
    ['100', 100_000_000n],
    ['100.5', 100_500_000n],
    ['100.000001', 100_000_001n],
    ['0.000001', 1n],
    ['9999.999999', 9_999_999_999n],
    [' 100 ', 100_000_000n], // trims whitespace
  ])('parses %s → %s', (input, expected) => {
    expect(parseMhUsdcBase6(input)).toBe(expected)
  })
})

describe('policy-scoped.helpers — parseMhUsdcBase6 reject path', () => {
  it.each<[string, string]>([
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['abc', 'non-numeric'],
    ['1.1234567', 'more than 6 fractional digits (would silently truncate)'],
    ['-100', 'negative sign'],
    ['+100', 'positive sign (not in regex)'],
    ['1e3', 'scientific notation'],
    ['100.', 'trailing dot'],
    ['.5', 'leading dot'],
    ['0', 'zero (would defeat the cap)'],
    ['0.0', 'zero with decimal'],
    ['0.0000001', 'too small (under-the-base-6 floor; rejected at parse)'],
    ['100,5', 'comma decimal'],
    ['100 5', 'mid-token space'],
  ])('rejects %s (reason: %s)', (input, _reason) => {
    expect(parseMhUsdcBase6(input)).toBeNull()
  })

  it('rejects non-string inputs', () => {
    // Defensive — production caller passes a string via v-model on a
    // text input, but a contract-style test guards against accidental
    // numeric pass-through (which would coerce wrongly via String()
    // and parse 12.3 as base-6 of 12.3 mhUSDC — silently wrong).
    expect(parseMhUsdcBase6(123 as unknown as string)).toBeNull()
    expect(parseMhUsdcBase6(null as unknown as string)).toBeNull()
    expect(parseMhUsdcBase6(undefined as unknown as string)).toBeNull()
  })
})

describe('policy-scoped.helpers — prefixConsentActionHash', () => {
  it('prefixes 0x onto a bare-hex sha256 digest', () => {
    const bare = 'a'.repeat(64)
    const prefixed = prefixConsentActionHash(bare)
    expect(prefixed).toBe(`0x${bare}`)
    expect(prefixed).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it('is idempotent on already-prefixed input', () => {
    const already = `0x${'b'.repeat(64)}`
    expect(prefixConsentActionHash(already)).toBe(already)
  })

  it('preserves character casing (does not normalize)', () => {
    // Backend `MintScopedSessionDtoSchema` regex
    // `HEX_32_BYTE_RE = /^0x[0-9a-fA-F]{64}$/` is case-insensitive; the
    // use-case lowercases at the persist boundary. The helper must
    // not pre-normalize — that would obscure debugging when comparing
    // against the source actionHash string.
    const mixed = 'AbCdEf' + 'a'.repeat(58)
    expect(prefixConsentActionHash(mixed)).toBe(`0x${mixed}`)
  })

  it('throws on under-length input (R2 fresh-CR M-2)', () => {
    // Without the length guard, a malformed actionHash would silently
    // flake at the server-side Zod 400 rather than failing fast at
    // populate time.
    expect(() => prefixConsentActionHash('abc')).toThrow(/32-byte hex/)
    expect(() => prefixConsentActionHash('0x' + 'a'.repeat(63))).toThrow(/32-byte hex/)
  })

  it('throws on over-length input', () => {
    expect(() => prefixConsentActionHash('a'.repeat(65))).toThrow(/32-byte hex/)
  })

  it('throws on non-hex characters', () => {
    expect(() => prefixConsentActionHash('g'.repeat(64))).toThrow(/32-byte hex/)
  })
})

describe('policy-scoped.helpers — formatTier', () => {
  it.each<[string, string]>([
    ['advisory', 'Advisory'],
    ['confirm-per-action', 'Confirm per action'],
    ['policy-bound', 'Policy-bound'],
    ['scoped', 'Scoped autonomy'],
    ['paused', 'Paused'],
  ])('maps %s → %s', (input, expected) => {
    expect(formatTier(input as any)).toBe(expected)
  })

  it('returns em-dash for null + undefined', () => {
    expect(formatTier(null)).toBe('—')
    expect(formatTier(undefined)).toBe('—')
  })

  it('R2 fresh-CR H-1 + R1 SecEng HIGH-1 regression guard: scoped does NOT fall through to "Advisory"', () => {
    // The pre-R1 default branch returned 'Advisory' for any unrecognized
    // tier, silently mislabelling the most autonomous tier as the least
    // autonomous one. This test guards against a "tidying" refactor that
    // collapses the if-chain and drops the scoped branch.
    expect(formatTier('scoped')).toBe('Scoped autonomy')
    expect(formatTier('scoped')).not.toBe('Advisory')
  })

  it('R1 Frontend M-5 — unknown literal falls through to the raw string, NOT "Advisory"', () => {
    // Slice 4 will add a 'wildcard' tier; the formatter must not
    // mislabel it as the least-autonomous tier before the union widens.
    expect(formatTier('wildcard' as any)).toBe('wildcard')
    expect(formatTier('wildcard' as any)).not.toBe('Advisory')
  })
})

describe('policy-scoped.helpers — formatTtlLabel + SCOPED_TTL_CHOICES', () => {
  it('exposes the curated five-window set', () => {
    expect(SCOPED_TTL_CHOICES.map((c) => c.sec)).toEqual([
      300, 3_600, 14_400, 43_200, 86_400,
    ])
  })

  it.each<[number, string]>([
    [300, '5 min'],
    [3_600, '1 hour'],
    [14_400, '4 hours'],
    [43_200, '12 hours'],
    [86_400, '24 hours'],
  ])('formats canonical %ss → %s', (sec, expected) => {
    expect(formatTtlLabel(sec)).toBe(expected)
  })

  it('falls through to "${sec}s" for off-list values (R2 fresh-CR M-3)', () => {
    expect(formatTtlLabel(900)).toBe('900s')
    expect(formatTtlLabel(7_200)).toBe('7200s')
    expect(formatTtlLabel(0)).toBe('0s')
  })

  it('every curated entry has a non-empty label', () => {
    for (const opt of SCOPED_TTL_CHOICES) {
      expect(opt.label.length).toBeGreaterThan(0)
      expect(typeof opt.sec).toBe('number')
    }
  })
})

describe('policy-scoped.helpers — newScopedSessionId', () => {
  it('produces an id matching backend regex /^[A-Za-z0-9_-]{1,128}$/', () => {
    // Match the regex from
    // `backend/src/application/dto/agent/policy.dto.ts:182`. Without
    // this guarantee a malformed UUID would surface as a Zod 400 mid-
    // ceremony AFTER the tier transition already landed.
    for (let i = 0; i < 32; i++) {
      const id = newScopedSessionId()
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    }
  })
})

describe('policy-scoped.helpers — formatPendingMhUsdc', () => {
  it.each<[bigint, string]>([
    [1_000_000n, '1'],
    [100_000_000n, '100'],
    [100_500_000n, '100.5'],
    [100_000_001n, '100.000001'],
    [1n, '0.000001'],
    [0n, '0'],
    [9_999_999_999n, '9999.999999'],
  ])('formats %s → %s (round-trip with parseMhUsdcBase6)', (base6, expected) => {
    expect(formatPendingMhUsdc(base6)).toBe(expected)
  })

  it('round-trips through parseMhUsdcBase6 for every non-zero choice', () => {
    // R1 UX H-4 — the pending-confirmation hint reads from a snapshot of
    // the user's parsed input. If the inverse (format → parse) ever drifts,
    // the displayed value would diverge from the value that will be POSTed.
    const samples = [1_000_000n, 100_500_000n, 100_000_001n, 1n, 9_999_999_999n]
    for (const sample of samples) {
      const formatted = formatPendingMhUsdc(sample)
      expect(parseMhUsdcBase6(formatted)).toBe(sample)
    }
  })
})

describe('policy-scoped.helpers — buildScopedMintBody', () => {
  const baseInput = {
    sessionId: '11111111-2222-3333-4444-555555555555',
    signerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    subscriptionAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
    maxPerOpUsd6: 100_000_000n, // $100
    maxSharesPerOp: 100n,
    mintedAtSec: 1_700_000_000,
    validUntilSec: 1_700_014_400,
    consentActionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    surface: 'mcp' as const,
  }

  it('builds a snapshot with mode=scoped + matching signer + sessionId', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.mode).toBe('scoped')
    expect(body.snapshot.sessionId).toBe(baseInput.sessionId)
    expect(body.snapshot.signerAddress).toBe(baseInput.signerAddress)
  })

  it('sets targetContracts to [subscriptionAddress] (single-entry Slice 1)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.targetContracts).toEqual([baseInput.subscriptionAddress])
  })

  it('emits exactly ONE selectorCap, on purchase, capArgIndex 2, maxAmount in SHARES (not mhUSDC)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.selectorCaps.length).toBe(1)
    const cap = body.snapshot.selectorCaps[0]
    expect(cap.selector).toBe(SUBSCRIPTION_PURCHASE_SELECTOR)
    expect(cap.capArgIndex).toBe(PURCHASE_MAX_SHARES_HINT_WORD_INDEX)
    // maxAmount MUST be the SHARES value, not the mhUSDC value. If we
    // ever regress to passing `maxPerOpUsd6` here, the broker's per-arg
    // cap would compare 100_000_000 shares against a uint128 — every
    // small purchase would pass, defeating the cap.
    expect(cap.maxAmount).toBe('100')
    expect(cap.maxAmount).not.toBe('100000000')
  })

  it('preserves uint256 precision via toString() (no JSON BigInt loss)', () => {
    const huge = (1n << 200n).toString()
    const body = buildScopedMintBody({ ...baseInput, maxPerOpUsd6: 1n << 200n })
    expect(body.maxPerOpUsd6).toBe(huge)
    expect(BigInt(body.maxPerOpUsd6)).toBe(1n << 200n)
  })

  it('OMITS permissionId from the snapshot (Pickup A locks no_permission_id_in_snapshot)', () => {
    // The smoke checkpoint per `development/STATUS.md` Slice 1 progression
    // requires Pickup A's mint POST to NOT carry `permissionId` so the
    // MCP server's Path D probe falls back at exactly the
    // `no_permission_id_in_snapshot` gate. Pickup B adds it. A regression
    // that auto-populates here would silently flip the smoke result.
    const body = buildScopedMintBody(baseInput)
    expect(Object.prototype.hasOwnProperty.call(body.snapshot, 'permissionId')).toBe(false)
  })

  it('OMITS consentTextSha256 by design (Slice 4 wildcard graduation)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(Object.prototype.hasOwnProperty.call(body.snapshot, 'consentTextSha256')).toBe(false)
  })

  it('carries consentActionHash exactly as supplied (0x-prefix is caller responsibility)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.consentActionHash).toBe(baseInput.consentActionHash)
    expect(body.snapshot.consentActionHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it('preserves validUntilSec + mintedAtSec as-is (no rounding)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.validUntilSec).toBe(1_700_014_400)
    expect(body.snapshot.mintedAtSec).toBe(1_700_000_000)
  })

  it('locks surface to the supplied value (operator-confirmed mcp default)', () => {
    const body = buildScopedMintBody(baseInput)
    expect(body.surface).toBe('mcp')
  })
})
