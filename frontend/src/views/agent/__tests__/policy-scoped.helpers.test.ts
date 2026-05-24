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
  scopedParamsFailure,
  SCOPED_TTL_CHOICES,
} from '../policy-scoped.helpers'

describe('policy-scoped.helpers — TTL bounds', () => {
  it('bounds match Option D · Commit 1 D-3 (300s..28800s, default 14400s)', () => {
    // Backend Zod schema has no explicit TTL bound — it enforces
    // `validUntilSec > now` only. These UI-side limits surface a
    // structurally-invalid TTL before the network hop. The D-3
    // ceiling reduction (24h → 8h) shipped alongside the D-1 CallPolicy
    // broadening: a broader on-chain envelope is balanced by a
    // shorter time-bound under broker compromise.
    expect(SCOPED_MIN_TTL_SEC).toBe(300)
    expect(SCOPED_MAX_TTL_SEC).toBe(28_800)
    expect(SCOPED_DEFAULT_TTL_SEC).toBe(14_400)
    expect(SCOPED_DEFAULT_TTL_SEC).toBeGreaterThan(SCOPED_MIN_TTL_SEC)
    expect(SCOPED_DEFAULT_TTL_SEC).toBeLessThan(SCOPED_MAX_TTL_SEC)
  })

  it('REGRESSION GUARD — Option D ceiling stays at 8h until the next plan revision', () => {
    // A future contributor "tidying" the constants must not silently
    // restore the 24h ceiling; the threat-model balance with the D-1
    // broadened CallPolicy + Slice 5 cumulative cap was reviewed
    // explicitly at this value. See development/DEV_WAVE_5/DEV_LOG.md
    // Option D · Commit 1 entry.
    expect(SCOPED_MAX_TTL_SEC).not.toBe(86_400)
    expect(SCOPED_MAX_TTL_SEC).toBeLessThanOrEqual(28_800)
  })
})

describe('policy-scoped.helpers — scopedParamsFailure', () => {
  // C4 re-smoke OPEN-A — the shared validity gate for BOTH the tier-
  // transition Scoped form and the direct re-mint panel. Mirrors the
  // backend `MintScopedSessionDtoSchema` structural minimums so the same
  // rules can't drift between the two consent surfaces.
  it('passes a valid cap + default TTL', () => {
    expect(scopedParamsFailure(100_000_000n, SCOPED_DEFAULT_TTL_SEC)).toBeNull()
  })

  it('passes the exact $1 floor + min/max TTL bounds (inclusive)', () => {
    expect(scopedParamsFailure(1_000_000n, SCOPED_MIN_TTL_SEC)).toBeNull()
    expect(scopedParamsFailure(1_000_000n, SCOPED_MAX_TTL_SEC)).toBeNull()
  })

  it('rejects a null (unparseable) cap with a "ceiling" hint', () => {
    expect(scopedParamsFailure(null, SCOPED_DEFAULT_TTL_SEC)).toMatch(/mhUSDC ceiling/)
  })

  it('rejects a sub-$1 cap (would round to 0 shares at $1 NAV)', () => {
    // 999_999n base-6 = $0.999999 < $1 → defeats the per-op cap.
    expect(scopedParamsFailure(999_999n, SCOPED_DEFAULT_TTL_SEC)).toMatch(/at least \$1/)
    expect(scopedParamsFailure(0n, SCOPED_DEFAULT_TTL_SEC)).toMatch(/at least \$1/)
  })

  it('rejects a TTL below the floor or above the 8h ceiling', () => {
    expect(scopedParamsFailure(100_000_000n, SCOPED_MIN_TTL_SEC - 1)).toMatch(/TTL must be/)
    expect(scopedParamsFailure(100_000_000n, SCOPED_MAX_TTL_SEC + 1)).toMatch(/TTL must be/)
  })

  it('rejects a non-finite TTL', () => {
    expect(scopedParamsFailure(100_000_000n, Number.NaN)).toMatch(/TTL must be/)
    expect(scopedParamsFailure(100_000_000n, Number.POSITIVE_INFINITY)).toMatch(/TTL must be/)
  })

  it('checks the cap BEFORE the TTL (cap failure short-circuits)', () => {
    // Both invalid → the cap message wins so the user fixes the more
    // fundamental field first.
    expect(scopedParamsFailure(null, Number.NaN)).toMatch(/mhUSDC ceiling/)
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
  it('exposes the Option D · D-3 curated five-window set (5m / 30m / 1h / 4h / 8h)', () => {
    expect(SCOPED_TTL_CHOICES.map((c) => c.sec)).toEqual([
      300, 1_800, 3_600, 14_400, 28_800,
    ])
  })

  it.each<[number, string]>([
    [300, '5 min'],
    [1_800, '30 min'],
    [3_600, '1 hour'],
    [14_400, '4 hours'],
    [28_800, '8 hours'],
  ])('formats canonical %ss → %s', (sec, expected) => {
    expect(formatTtlLabel(sec)).toBe(expected)
  })

  it('REGRESSION GUARD — 24h + 12h options NOT exposed by the curated set', () => {
    // The Option D · D-3 narrowing dropped 12h + 24h. A future
    // contributor restoring them would silently relax the threat-
    // model bound documented in `SCOPED_MAX_TTL_SEC`. The picker
    // still falls through to `${sec}s` for off-list values, so a
    // direct deep-link with `?ttl=86400` still surfaces the value,
    // but the curated set must not list them as first-class options.
    expect(SCOPED_TTL_CHOICES.find((c) => c.sec === 43_200)).toBeUndefined()
    expect(SCOPED_TTL_CHOICES.find((c) => c.sec === 86_400)).toBeUndefined()
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
  // Wave 5 Option D · Commit 2 — install material now REQUIRED on the
  // input. The legacy test fixtures here pre-date C2; they grow three
  // new required fields (enableData, enableSig, validatorNonce) so the
  // backend Zod gate at the wire also accepts them. Cleartext shapes:
  //   - enableData: `0x` + 2..8192 hex chars
  //   - enableSig:  `0x` + 128..4096 hex chars (WebAuthn envelope)
  //   - validatorNonce: uint32
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
    permissionId: '0xdeadbeef' as `0x${string}`,
    // enableData: 128 hex chars = comfortable inside the 2..8192 bound.
    // enableSig: 384 hex chars = ~192 bytes; clears the tightened
    // 256-hex floor (Option D · C2 multi-agent review SecEng H-3
    // raised the floor from 128 → 256 to reject bare-ECDSA downgrade).
    enableData: `0x${'cd'.repeat(64)}` as `0x${string}`,
    enableSig: `0x${'ab'.repeat(192)}` as `0x${string}`,
    validatorNonce: 1,
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

  it('THREADS permissionId from input into the snapshot (Pickup B advances smoke past no_permission_id_in_snapshot)', () => {
    // Pickup B flips the Slice 1 acceptance state: with the field
    // present, the MCP server's Path D probe gets past the
    // `no_permission_id_in_snapshot` gate and proceeds to compose the
    // Kernel v3.1 24-byte nonce-key composite. Without it the bundler
    // reads the SUDO-validator nonce slot and AA24's every UserOp.
    const body = buildScopedMintBody(baseInput)
    // R2 Reality Checker M-1 — defensive `.toBeDefined()` so a future
    // fixture refactor that lets `baseInput.permissionId` slip to
    // `undefined` would still fail loudly here (the equality check
    // would silently pass with undefined === undefined).
    expect(body.snapshot.permissionId).toBeDefined()
    expect(body.snapshot.permissionId).toBe(baseInput.permissionId)
    expect(body.snapshot.permissionId).toMatch(/^0x[0-9a-f]{8}$/)
  })

  it('lowercases a mixed-case permissionId so the wire round-trips byte-equal with the backend Zod gate', () => {
    // R1 multi-agent review M-3 absorbed — the helper now internally
    // lowercases + shape-asserts, narrowing the call-site contract.
    // Any future call site that constructs BuildScopedMintBodyInput
    // from a different source (e2e, test fixture, future provider)
    // can pass mixed-case safely without needing to remember the
    // wire convention. Backend Zod gate is `^0x[0-9a-f]{8}$` lower.
    const body = buildScopedMintBody({
      ...baseInput,
      permissionId: '0xDeAdBeEf' as `0x${string}`,
    })
    expect(body.snapshot.permissionId).toBe('0xdeadbeef')
  })

  it('throws on a malformed permissionId (wrong length / non-hex / missing 0x)', () => {
    const cases: string[] = [
      '0xdead',                    // too short
      '0xdeadbeef00',              // too long
      'deadbeef',                  // missing 0x
      '0xDEADBEEG',                // non-hex
      '',                          // empty
    ]
    for (const bad of cases) {
      expect(() =>
        buildScopedMintBody({ ...baseInput, permissionId: bad as `0x${string}` }),
      ).toThrow(/permissionId must be 0x-prefixed 4-byte hex/)
    }
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

  it('OMITS consentActionHash entirely when undefined (OPEN-A direct re-mint path)', () => {
    // C4 re-smoke OPEN-A — the direct re-mint (at scoped tier, no live
    // session) has no fresh transition token to anchor to. The backend
    // `MintScopedSessionDtoSchema.consentActionHash` is `.optional()`, so
    // the helper must DROP the key (not emit `consentActionHash: undefined`)
    // — mirroring the `consentTextSha256` omission convention so the wire
    // shape stays minimal + the audit chain falls back to adjacency.
    const { consentActionHash: _drop, ...noConsent } = baseInput
    const body = buildScopedMintBody(noConsent)
    expect(
      Object.prototype.hasOwnProperty.call(body.snapshot, 'consentActionHash'),
    ).toBe(false)
    // The rest of the snapshot is unaffected.
    expect(body.snapshot.mode).toBe('scoped')
    expect(body.snapshot.permissionId).toBe('0xdeadbeef')
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

  // ────────────────────────────────────────────────────────────────────
  // Wave 5 Option D · Commit 2 — install material on the snapshot.
  // ────────────────────────────────────────────────────────────────────

  it('THREADS enableData / enableSig / validatorNonce onto snapshot (Option D · C2)', () => {
    // Without this, C3 MCP-side ENABLE-mode UserOp can't compose +
    // the validator never installs on-chain. Each field is captured
    // by `installScopedSessionKey` at mint time + paid for by one
    // WebAuthn ceremony.
    const body = buildScopedMintBody(baseInput)
    expect(body.snapshot.enableData).toBe(baseInput.enableData.toLowerCase())
    expect(body.snapshot.enableSig).toBe(baseInput.enableSig.toLowerCase())
    expect(body.snapshot.validatorNonce).toBe(baseInput.validatorNonce)
  })

  it('lowercases mixed-case enableData + enableSig (wire byte-equality)', () => {
    // Mirrors the permissionId lowercase contract — keeps any future
    // raw-SQL audit JOIN deterministic across case skew.
    const mixedEnableData = `0x${'CdAbCdAbCdAb'.repeat(11)}cdab` as `0x${string}` // 132 hex
    const mixedEnableSig = `0x${'AbCdAbCd'.repeat(40)}` as `0x${string}` // 320 hex (clears 256-floor)
    const body = buildScopedMintBody({
      ...baseInput,
      enableData: mixedEnableData,
      enableSig: mixedEnableSig,
    })
    expect(body.snapshot.enableData).toBe(mixedEnableData.toLowerCase())
    expect(body.snapshot.enableSig).toBe(mixedEnableSig.toLowerCase())
  })

  it('throws on malformed enableData (too short / non-hex / missing prefix)', () => {
    const cases: string[] = [
      '0x',                                  // empty payload — kernel rejects 0-byte validatorData
      '0xa',                                 // 1 hex char (< 2 minimum after prefix)
      'cdab',                                // missing 0x prefix
      `0x${'g'.repeat(8)}`,                  // non-hex
      `0x${'cd'.repeat(32769)}`,             // exceeds 65536-char cleartext ceiling (hot-patch 2026-05-23)
    ]
    for (const bad of cases) {
      expect(() =>
        buildScopedMintBody({ ...baseInput, enableData: bad as `0x${string}` }),
      ).toThrow(/enableData must be 0x-prefixed hex/)
    }
  })

  it('accepts realistic prod-size enableData (~30KB hex — Option D hot-patch regression guard)', () => {
    // The 2026-05-23 hot-patch raised the cleartext ceiling 8192 →
    // 65536 hex because the real Wave 5 SCOPED_AUTONOMOUS_PERMISSIONS
    // yields a 30KB hex payload. A future tightening that ignores
    // the real policy count would re-introduce the production outage.
    const body = buildScopedMintBody({
      ...baseInput,
      enableData: `0x${'cd'.repeat(15000)}` as `0x${string}`, // 30000 hex
    })
    expect(body.snapshot.enableData?.length).toBe(30002)
  })

  it('throws on malformed enableSig (length out of bounds / non-hex)', () => {
    const cases: string[] = [
      `0x${'ab'.repeat(127)}`,               // 254 hex — under 256-char floor
      `0x${'ab'.repeat(8193)}`,              // 16386 hex — over 16384 ceiling (hot-patch 2026-05-23)
      `0x${'g'.repeat(300)}`,                // non-hex
      'ababab',                              // missing 0x prefix
    ]
    for (const bad of cases) {
      expect(() =>
        buildScopedMintBody({ ...baseInput, enableSig: bad as `0x${string}` }),
      ).toThrow(/enableSig must be 0x-prefixed hex/)
    }
  })

  it('REJECTS bare 65-byte ECDSA-shaped signature (downgrade defense, SecEng H-3)', () => {
    // A naive caller posting a raw ECDSA (r,s,v) = 65 bytes = 130 hex
    // would slip past a permissive lower bound. The 256-hex floor
    // bounces this kind of downgrade before it ever reaches the
    // backend Zod.
    const bareEcdsa = `0x${'ab'.repeat(65)}` as `0x${string}` // 130 hex
    expect(() =>
      buildScopedMintBody({ ...baseInput, enableSig: bareEcdsa }),
    ).toThrow(/enableSig must be 0x-prefixed hex/)
  })

  it('throws on validatorNonce out of uint32 range or non-integer', () => {
    const cases: number[] = [-1, 4_294_967_296, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    for (const bad of cases) {
      expect(() =>
        buildScopedMintBody({ ...baseInput, validatorNonce: bad }),
      ).toThrow(/validatorNonce must be a uint32 integer/)
    }
  })

  it('accepts the upper-bound validatorNonce (uint32 max)', () => {
    const body = buildScopedMintBody({
      ...baseInput,
      validatorNonce: 4_294_967_295,
    })
    expect(body.snapshot.validatorNonce).toBe(4_294_967_295)
  })
})
