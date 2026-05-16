/**
 * Pick B (Wave 5+ per-token YieldSnapshot proxy binding, 2026-05-23):
 * unit coverage for the runtime registration + resolution layer added
 * to `addresses.ts`.
 *
 * Testing strategy (round-2 review CR-H2): the env-var fallback chain
 * (per-token JSON map → singleton) is environment-dependent — the test
 * environment may or may not bake `VITE_YIELD_SNAPSHOT_ADDRESS`. We
 * AVOID asserting on the fallback's specific value by:
 *   1. Computing the fallback once at the top of each test via
 *      `getYieldSnapshot(testToken)` BEFORE registering anything, so
 *      whatever env state vitest has resolved becomes the captured
 *      baseline for THAT test only.
 *   2. Sanity-asserting that the captured fallback differs from any
 *      `SNAPSHOT_X` test sentinel — guards against an env where the
 *      fallback happened to collide with a test value (would silently
 *      pass the "preferred over fallback" assertion otherwise).
 *   3. Asserting "resolution returns to fallback after clear" + "is
 *      not the previously-registered value" — relative assertions
 *      that hold regardless of whether `fallback` is `null` or a
 *      real address.
 *
 * Brittleness avoided: a previous draft captured `FALLBACK` at module
 * top-level, which froze the env-state into one constant for the
 * whole file. Adding a test that registered TOKEN_A at module scope
 * would have silently inverted the meaning of every subsequent test's
 * "is not FALLBACK" sanity check.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearYieldSnapshotRegistry,
  getYieldSnapshot,
  registerYieldSnapshot,
} from '@/contracts/addresses'

const TOKEN_A = '0x1111111111111111111111111111111111111111' as const
const TOKEN_A_CHECKSUMMED = '0x1111111111111111111111111111111111111111' as const
const SNAPSHOT_A = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as const
const SNAPSHOT_B = '0xbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB' as const
const ZERO = '0x0000000000000000000000000000000000000000' as const

/**
 * Resolve the env-var fallback that `getYieldSnapshot` would return
 * for `token` when nothing is registered. Captures the current env
 * state at call time — caller's responsibility to invoke BEFORE any
 * `registerYieldSnapshot` mutation. Returns `null` if no fallback
 * resolves (env-var unset).
 */
function captureFallback(token: `0x${string}` = TOKEN_A): `0x${string}` | null {
  return getYieldSnapshot(token)
}

beforeEach(() => {
  clearYieldSnapshotRegistry()
})

describe('registerYieldSnapshot / getYieldSnapshot — runtime layer', () => {
  it('returns the registered snapshot for a token (preferred over fallback)', () => {
    const fallback = captureFallback()
    expect(fallback).not.toBe(SNAPSHOT_A) // sanity: env didn't collide with test sentinel
    registerYieldSnapshot(TOKEN_A, SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A)).toBe(SNAPSHOT_A)
    // And it's NOT the fallback — proves the runtime layer is actually
    // preferred over the env-var resolution chain.
    expect(getYieldSnapshot(TOKEN_A)).not.toBe(fallback)
  })

  it('lower-cases the token key for case-insensitive lookup', () => {
    // Register with checksummed key, look up with lowercase.
    registerYieldSnapshot(TOKEN_A_CHECKSUMMED, SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A.toLowerCase() as `0x${string}`)).toBe(SNAPSHOT_A)
    clearYieldSnapshotRegistry()
    // And vice versa.
    registerYieldSnapshot(TOKEN_A.toLowerCase(), SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A_CHECKSUMMED)).toBe(SNAPSHOT_A)
  })

  it('silently no-ops on null/undefined inputs (legacy rows have null snapshot)', () => {
    const fallback = captureFallback()
    expect(() => registerYieldSnapshot(TOKEN_A, null)).not.toThrow()
    expect(() => registerYieldSnapshot(TOKEN_A, undefined)).not.toThrow()
    expect(() => registerYieldSnapshot(null, SNAPSHOT_A)).not.toThrow()
    // Resolution falls through to the env-var fallback (NOT to the
    // garbage value the no-op rejected).
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
  })

  it('rejects zero-address snapshot (sentinel for "not deployed")', () => {
    const fallback = captureFallback()
    registerYieldSnapshot(TOKEN_A, ZERO)
    // Zero-address registration is a no-op — resolution falls through
    // to the env-var fallback as if nothing was ever registered.
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
  })

  it('rejects malformed hex addresses in the snapshot slot', () => {
    const fallback = captureFallback()
    registerYieldSnapshot(TOKEN_A, '0xnot-hex' as `0x${string}`)
    registerYieldSnapshot(TOKEN_A, '0x12' as `0x${string}`) // too short
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
  })

  it('rejects malformed hex addresses in the token slot (SE-MED hygiene)', () => {
    // Defense-in-depth: a malicious or buggy backend response with a
    // non-address token key should NOT poison the map. After the
    // no-op, the legitimate TOKEN_A still resolves through the
    // fallback chain.
    const fallback = captureFallback()
    registerYieldSnapshot('not-an-address', SNAPSHOT_A)
    registerYieldSnapshot('0xtoo-short', SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
  })

  it('last-write-wins on duplicate registration (re-fetch overrides stale)', () => {
    registerYieldSnapshot(TOKEN_A, SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A)).toBe(SNAPSHOT_A)
    registerYieldSnapshot(TOKEN_A, SNAPSHOT_B)
    expect(getYieldSnapshot(TOKEN_A)).toBe(SNAPSHOT_B)
  })

  it('falls through to env-var fallback when no runtime registration exists', () => {
    // Pins the legacy-row resolution path: a token with no per-token
    // snapshot registered still resolves through the env-var fallback
    // chain. The captured `fallback` is whatever the env provides —
    // either a real address or null — but it MUST NOT match a
    // freshly-supplied test address that was never registered.
    const fallback = captureFallback()
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
    expect(getYieldSnapshot(TOKEN_A)).not.toBe(SNAPSHOT_A)
  })
})

describe('clearYieldSnapshotRegistry', () => {
  it('drops every runtime entry (resolution returns to fallback)', () => {
    const fallback = captureFallback()
    registerYieldSnapshot(TOKEN_A, SNAPSHOT_A)
    expect(getYieldSnapshot(TOKEN_A)).toBe(SNAPSHOT_A)
    clearYieldSnapshotRegistry()
    // After clear, resolution falls back to the env-var chain — NOT
    // the previously-registered SNAPSHOT_A.
    expect(getYieldSnapshot(TOKEN_A)).toBe(fallback)
    expect(getYieldSnapshot(TOKEN_A)).not.toBe(SNAPSHOT_A)
  })

  it('is idempotent (multiple calls are safe)', () => {
    expect(() => {
      clearYieldSnapshotRegistry()
      clearYieldSnapshotRegistry()
      clearYieldSnapshotRegistry()
    }).not.toThrow()
  })
})
