/**
 * Wave 5 Path D Slice 1 Pickup A — pure helpers extracted from
 * `PolicyTransitionPage.vue` so the unit tests can exercise them
 * without mounting the Vue component or stubbing the wallet store.
 *
 * Keep this file PURE — no `vue`, no `vue-router`, no
 * `viem/account-abstraction` imports. The Vue page imports these
 * constants + functions; tests import them directly.
 */

import { toFunctionSelector } from 'viem'

/** Tier literal — mirrors `Tier` from `@/services/api` but kept inline so
 *  helpers stay free of cyclic imports against the API surface. */
type TierLiteral = 'advisory' | 'confirm-per-action' | 'policy-bound' | 'scoped' | 'paused'

/** Scoped tier TTL bounds.
 *
 *  **Wave 5 Option D · Commit 1 (D-3): ceiling tightened from 24h → 8h.**
 *  Rationale (R2 SecEng review): the Scoped envelope is broadened in
 *  the same commit (D-1) to mirror the legacy session-key allowlist
 *  MINUS `muHavenToken.transfer`. With the on-chain CallPolicy now
 *  covering purchase + redeem + queued sell + claim + setOperator +
 *  refresh*, the blast radius under broker compromise grows; the TTL
 *  reduction keeps the time-bounded risk envelope compatible with the
 *  Slice 1 cumulative-cap defense.
 *
 *  The backend `MintScopedSessionDtoSchema` enforces `validUntilSec >
 *  now` + ±5 min `mintedAtSec` skew separately; the 8h ceiling is the
 *  UI-side guard, surfaced before the network hop. */
export const SCOPED_MIN_TTL_SEC = 300        // 5 min
export const SCOPED_MAX_TTL_SEC = 28_800     // 8h Option D ceiling (was 24h pre-D3)
export const SCOPED_DEFAULT_TTL_SEC = 14_400 // 4h

/** `subscription.purchase(address, InEuint128, uint128 maxSharesHint, address)`
 *  4-byte selector. Derived via `toFunctionSelector` at module load so
 *  the value matches the MCP server's own derivation in
 *  `packages/mcp/src/tools/handlers.ts:133`. Lowercased so byte-equal
 *  with `PolicySnapshotWire.selectorCaps[i].selector` after the
 *  broker's normalization in `parseSelectorCap`. */
export const SUBSCRIPTION_PURCHASE_SELECTOR: `0x${string}` = toFunctionSelector({
  name: 'purchase',
  type: 'function',
  // `outputs` + `stateMutability` are not needed for selector derivation
  // (only `name` + `inputs` feed the canonical signature) but viem's
  // `AbiFunction` type requires them — R1 Code Reviewer HIGH-2.
  stateMutability: 'nonpayable',
  outputs: [],
  inputs: [
    { name: 'token', type: 'address' },
    {
      name: 'encShares',
      type: 'tuple',
      components: [
        { name: 'ctHash', type: 'uint256' },
        { name: 'securityZone', type: 'uint8' },
        { name: 'utype', type: 'uint8' },
        { name: 'signature', type: 'bytes' },
      ],
    },
    { name: 'maxSharesHint', type: 'uint128' },
    { name: 'ephemeralEOA', type: 'address' },
  ],
}).toLowerCase() as `0x${string}`

/** 0-based word index of `maxSharesHint` in the ABI-encoded calldata
 *  AFTER the 4-byte selector (per `packages/mcp/src/broker/protocol.ts:
 *  192-201` layout diagram). Static encoding — see RD-6 invariant. */
export const PURCHASE_MAX_SHARES_HINT_WORD_INDEX = 2

/**
 * Parse a user-typed mhUSDC ceiling into a base-6 BigInt.
 *
 * Accepts:
 *  - whole dollars: `"100"` → `100_000_000n`
 *  - decimal with ≤6 fractional digits: `"100.5"` → `100_500_000n`,
 *    `"0.123456"` → `123_456n`
 *
 * Rejects (returns `null`):
 *  - empty / non-string
 *  - non-finite (`"NaN"`, `"Infinity"`, scientific notation)
 *  - more than 6 fractional digits (precision loss)
 *  - leading sign / whitespace mid-token
 *  - parsed value ≤ 0
 *
 * Why a custom parser instead of `Number.parseFloat` + `BigInt`:
 * floats lose precision past ~15 significant digits and a literal
 * like `1234567890.123456` round-trips imprecisely. Regex + BigInt
 * stays exact across the full uint256 range the Zod schema accepts.
 */
export function parseMhUsdcBase6(input: string): bigint | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed)
  if (!match) return null
  const whole = BigInt(match[1])
  const fracRaw = match[2] ?? ''
  const fracPadded = (fracRaw + '000000').slice(0, 6)
  const frac = BigInt(fracPadded)
  const total = whole * 1_000_000n + frac
  return total > 0n ? total : null
}

/**
 * Prefix `0x` onto a bare-hex hash returned by the backend's
 * `confirm-token.service.ts::hashAction` (which calls
 * `createHash('sha256').digest('hex')` — no `0x` prefix).
 *
 * The backend's `MintScopedSessionDtoSchema` validates
 * `consentActionHash` against `HEX_32_BYTE_RE = /^0x[0-9a-fA-F]{64}$/`,
 * so the prefix MUST be added client-side at the populate boundary.
 * Mirrors the backend's own `transition-tier.use-case.ts::
 * toChainAnchorHash` normalization so the audit-row JOIN by stable key
 * works after 2.B emission.
 *
 * Idempotent — passes through an already-prefixed value unchanged.
 *
 * **Throws** when the input doesn't match the 32-byte-hex shape after
 * normalization. R2 fresh-CR M-2 catch — without this guard, a future
 * caller passing a malformed actionHash would silently flake at the
 * server-side Zod 400 instead of failing fast at the populate boundary.
 */
export function prefixConsentActionHash(bareOrPrefixed: string): `0x${string}` {
  const prefixed = bareOrPrefixed.startsWith('0x')
    ? bareOrPrefixed
    : `0x${bareOrPrefixed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error(
      `prefixConsentActionHash: input must be a 32-byte hex (bare or 0x-prefixed); got ${prefixed.length} chars`,
    )
  }
  return prefixed as `0x${string}`
}

/**
 * Generate a sessionId matching the backend's regex
 * `^[A-Za-z0-9_-]{1,128}$`. Prefers `crypto.randomUUID()` (uppercase /
 * lowercase hex + `-`), falls back to a Math.random scheme for hosts
 * without WebCrypto's UUID API (very old Safari, locked-down enterprise
 * browsers). The fallback's entropy is much lower than `randomUUID`;
 * acceptable here because the value is checked server-side for active-
 * dedup (no clash → no security impact). Surface the picker is allowed
 * to assume `crypto.randomUUID` exists in all production targets.
 */
export function newScopedSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const seg = (): string => Math.random().toString(36).slice(2, 10)
  return `${seg()}-${seg()}-${seg()}-${seg()}`
}

/**
 * R1 UX H-4 — format a mhUSDC base-6 BigInt as the user-facing decimal
 * string the input accepted. Trailing-zero trim so `100_500_000n →
 * '100.5'`, NOT `'100.500000'`.
 */
export function formatPendingMhUsdc(base6: bigint): string {
  const whole = base6 / 1_000_000n
  const frac = base6 % 1_000_000n
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole.toString()}.${fracStr}`
}

/**
 * Format a Tier literal as the user-facing label rendered everywhere
 * the page surfaces tier text (current-state strip, pending-confirmation
 * hint, success toast). Extracted from the Vue page (R2 fresh-CR H-1)
 * so unit tests can guard the `'scoped'` branch — a silent fallthrough
 * to "Advisory" or the raw `'scoped'` string after a future "tidy"
 * refactor would mislabel the most autonomous tier at the consent
 * surface.
 *
 * Unknown literals fall through to the raw string (R1 Frontend M-5):
 * surfacing the raw value visibly is safer than mislabelling a future
 * tier (e.g. Slice 4 wildcard) as the LEAST autonomous one.
 */
export function formatTier(t: TierLiteral | null | undefined): string {
  if (!t) return '—'
  if (t === 'advisory') return 'Advisory'
  if (t === 'confirm-per-action') return 'Confirm per action'
  if (t === 'policy-bound') return 'Policy-bound'
  if (t === 'scoped') return 'Scoped autonomy'
  if (t === 'paused') return 'Paused'
  return t
}

/**
 * Map a TTL second value to the matching segmented-control label
 * (e.g. `14400 → '4 hours'`). Falls back to `${sec}s` if the value
 * isn't one of the curated `SCOPED_TTL_CHOICES` — defensive against
 * deep-linked custom values or migrated-away choices. R2 fresh-CR M-3.
 */
export function formatTtlLabel(sec: number): string {
  const opt = SCOPED_TTL_CHOICES.find((c) => c.sec === sec)
  return opt?.label ?? `${sec}s`
}

/** Curated TTL choices the Scoped form's segmented control offers.
 *  Single source of truth — Vue page reads + `formatTtlLabel` resolves
 *  against the SAME array.
 *
 *  Wave 5 Option D · Commit 1 (D-3): dropped 12h + 24h options; added
 *  30 min + 8h. Default remains 4h. See `SCOPED_MAX_TTL_SEC` JSDoc for
 *  the ceiling-reduction rationale. */
export const SCOPED_TTL_CHOICES: ReadonlyArray<{ sec: number; label: string }> = [
  { sec: SCOPED_MIN_TTL_SEC, label: '5 min' },
  { sec: 1_800, label: '30 min' },
  { sec: 3_600, label: '1 hour' },
  { sec: SCOPED_DEFAULT_TTL_SEC, label: '4 hours' },
  { sec: SCOPED_MAX_TTL_SEC, label: '8 hours' },
]

/**
 * Inputs the Vue page collects from the user + the wallet provider
 * before composing the Scoped mint POST body.
 *
 * Kept narrow + serializable so the snapshot builder is unit-testable
 * without mounting a Vue component or stubbing the wallet store.
 */
export interface BuildScopedMintBodyInput {
  sessionId: string
  signerAddress: `0x${string}`
  subscriptionAddress: `0x${string}`
  /** mhUSDC base-6 ceiling (user-intent display). */
  maxPerOpUsd6: bigint
  /** Per-selector cap on `maxSharesHint` — in SHARES (selector-native unit). */
  maxSharesPerOp: bigint
  mintedAtSec: number
  validUntilSec: number
  /** 0x-prefixed 32-byte hex from `prefixConsentActionHash`. */
  consentActionHash: `0x${string}`
  surface: 'havenbot' | 'mcp' | 'openclaw' | 'checkout'
  /**
   * Pickup B — `getPermissionId()` for the installed
   * `@zerodev/permissions` PermissionValidator. 4-byte hex
   * (`keccak256(policyAndSignerData).slice(0, 4)`). The MCP server
   * needs this to compose the Kernel v3.1 24-byte nonce-key composite
   * — without it, the bundler reads the SUDO-validator nonce slot and
   * the UserOp is routed through the wrong validator → AA24
   * InvalidSigner on submit. Slice 1 Pickup A intentionally OMITTED
   * this to land at `no_permission_id_in_snapshot` as the smoke
   * checkpoint; Pickup B threads it through so the smoke advances to
   * `ok:true, path:'D'`. Validated server-side against
   * `^0x[0-9a-f]{8}$` (lowercased + 4-byte).
   */
  permissionId: `0x${string}`
  /**
   * Wave 5 Option D · Commit 2 — install material captured by the
   * frontend mint ceremony. All three fields are passed through
   * verbatim onto `snapshot.enableData` / `snapshot.enableSig` /
   * `snapshot.validatorNonce`. The backend encrypts enableData and
   * enableSig via pgcrypto before persist; the cleartext passes the
   * wire (HTTPS protects in transit). The helper lower-cases the hex
   * values internally + shape-asserts so a malformed value fails fast
   * at the populate boundary.
   */
  enableData: `0x${string}`
  enableSig: `0x${string}`
  validatorNonce: number
}

/**
 * Shape of `MintScopedSessionRequest` minus the `Surface` type import
 * (helpers file stays free of `@/services/api` cyclic deps). The call
 * site uses a type annotation `const body: MintScopedSessionRequest =
 * buildScopedMintBody(...)` so structural compatibility is enforced at
 * compile time; if `MintScopedSessionRequest` ever GAINS a required
 * field this helper doesn't supply, the annotation fails. If it ever
 * gains an OPTIONAL field, the annotation still passes — coordinate
 * `ScopedMintBodyShape` in lockstep with the api.ts wire shape.
 *
 * R2 fresh-CR H-2 — JSDoc accuracy fix; the prior version claimed a
 * `satisfies` assertion that doesn't exist at the call site.
 */
export interface ScopedMintBodyShape {
  snapshot: {
    sessionId: string
    mode: 'scoped'
    signerAddress: `0x${string}`
    targetContracts: readonly `0x${string}`[]
    selectorCaps: readonly {
      selector: `0x${string}`
      capArgIndex: number | null
      maxAmount: string | null
    }[]
    validUntilSec: number
    mintedAtSec: number
    consentActionHash?: `0x${string}`
    consentTextSha256?: `0x${string}`
    permissionId?: `0x${string}`
    /**
     * Wave 5 Option D · Commit 2 — install material on the snapshot.
     * Server-side `MintScopedSessionDtoSchema` validates `^0x[0-9a-fA-F]
     * {2,8192}$` / `^0x[0-9a-fA-F]{128,4096}$` and the uint32 nonce
     * bound. The helper passes through verbatim after lower-casing.
     */
    enableData?: `0x${string}`
    enableSig?: `0x${string}`
    validatorNonce?: number
  }
  maxPerOpUsd6: string
  surface: 'havenbot' | 'mcp' | 'openclaw' | 'checkout'
}

/**
 * Compose the Scoped mint POST body in one place so the wire shape can
 * be unit-tested + reviewed independently of the Vue page flow.
 *
 * **Invariants enforced** (every callout below maps to a backend Zod or
 * MintScopedSessionUseCase pre-condition):
 *   - `mode: 'scoped'` literal — matches `MintScopedSessionDtoSchema:233`.
 *   - `selectorCaps[0]` is the single `subscription.purchase` entry with
 *     `capArgIndex = 2` + `maxAmount` in SHARES.
 *   - `maxPerOpUsd6` serialized as decimal string (uint256 base-6).
 *   - `consentActionHash` is `0x`-prefixed (caller responsibility — the
 *     helper does NOT prefix; verify shape with `prefixConsentActionHash`).
 *   - `permissionId` PRESENT (Pickup B). The helper lowercases the
 *     value internally + validates against `^0x[0-9a-f]{8}$` so a
 *     future call site that forgets to pre-normalize doesn't land a
 *     mixed-case row that fails server-side Zod. Throws on shape
 *     violation rather than silently truncating — fail fast at the
 *     populate boundary. R1 multi-agent review M-3 (Security Engineer +
 *     Frontend Developer) absorbed.
 */
export function buildScopedMintBody(input: BuildScopedMintBodyInput): ScopedMintBodyShape {
  const permissionIdLower = input.permissionId.toLowerCase() as `0x${string}`
  if (!/^0x[0-9a-f]{8}$/.test(permissionIdLower)) {
    throw new Error(
      `buildScopedMintBody: permissionId must be 0x-prefixed 4-byte hex; got ${input.permissionId.length} chars`,
    )
  }
  // Wave 5 Option D · Commit 2 — lowercase + shape-assert install
  // material at the populate boundary. The backend's Zod gate accepts
  // mixed-case 0x-hex, but lowering here keeps the wire shape byte-
  // equal with the encrypted-bytea round-trip (post-decrypt cleartext
  // is whatever the client sent; mixed case would break a future
  // raw-SQL audit JOIN that matches on stable case).
  const enableDataLower = input.enableData.toLowerCase() as `0x${string}`
  if (!/^0x[0-9a-f]{2,8192}$/.test(enableDataLower)) {
    throw new Error(
      `buildScopedMintBody: enableData must be 0x-prefixed hex (2-8192 hex chars); got ${input.enableData.length} chars`,
    )
  }
  const enableSigLower = input.enableSig.toLowerCase() as `0x${string}`
  // Wave 5 Option D · Commit 2 — lower bound 256 hex chars (~128 bytes)
  // is the floor of a real WebAuthn envelope. Tightened from 128 in
  // multi-agent review SecEng H-3 to reject bare-ECDSA downgrade
  // attempts (a 65-byte ECDSA = 130 hex would otherwise slip through).
  if (!/^0x[0-9a-f]{256,4096}$/.test(enableSigLower)) {
    throw new Error(
      `buildScopedMintBody: enableSig must be 0x-prefixed hex (256-4096 hex chars); got ${input.enableSig.length} chars`,
    )
  }
  if (
    !Number.isInteger(input.validatorNonce) ||
    input.validatorNonce < 0 ||
    input.validatorNonce > 4_294_967_295
  ) {
    throw new Error(
      `buildScopedMintBody: validatorNonce must be a uint32 integer; got ${input.validatorNonce}`,
    )
  }
  return {
    snapshot: {
      sessionId: input.sessionId,
      mode: 'scoped',
      signerAddress: input.signerAddress,
      targetContracts: [input.subscriptionAddress],
      selectorCaps: [
        {
          selector: SUBSCRIPTION_PURCHASE_SELECTOR,
          capArgIndex: PURCHASE_MAX_SHARES_HINT_WORD_INDEX,
          maxAmount: input.maxSharesPerOp.toString(),
        },
      ],
      validUntilSec: input.validUntilSec,
      mintedAtSec: input.mintedAtSec,
      consentActionHash: input.consentActionHash,
      permissionId: permissionIdLower,
      enableData: enableDataLower,
      enableSig: enableSigLower,
      validatorNonce: input.validatorNonce,
    },
    maxPerOpUsd6: input.maxPerOpUsd6.toString(),
    surface: input.surface,
  }
}
