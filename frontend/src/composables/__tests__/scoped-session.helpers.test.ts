/**
 * Wave 5 Option D · Commit 4 — unit tests for the pure active-Scoped-
 * session helpers (countdown, address/permission prefixes, mhUSDC base-6
 * formatting, live-session predicate). No Vue mount required.
 */
import { describe, it, expect } from 'vitest'
import type { ScopedSessionResponseDto } from '@/services/api'
import {
  scopedExpiresInSec,
  formatExpiresIn,
  signerPrefix,
  permissionIdPrefix,
  formatMhUsdc6,
  isSessionLive,
} from '../scoped-session.helpers'

const NOW_MS = 1_700_000_000_000 // fixed; NOW_SEC = 1_700_000_000

function fakeSession(over: Partial<ScopedSessionResponseDto> = {}): ScopedSessionResponseDto {
  return {
    sessionId: 's1',
    mode: 'scoped',
    userId: '0xuser',
    surface: 'mcp',
    status: 'active',
    signerAddress: '0x1234567890abcdef1234567890abcdef12345678',
    permissionId: '0xa2500760',
    targetContracts: [],
    selectorCaps: [],
    maxPerOpUsd6: '100000000',
    totalSpentUsd6: '0',
    validUntilSec: 1_700_000_000 + 3600,
    mintedAtSec: 1_700_000_000 - 60,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: '2026-05-24T00:00:00.000Z',
    revokedAt: null,
    expiredAt: null,
    ...over,
  }
}

describe('scopedExpiresInSec', () => {
  it('returns positive seconds when TTL is in the future', () => {
    expect(scopedExpiresInSec(1_700_000_000 + 3600, NOW_MS)).toBe(3600)
  })
  it('floors at 0 when expired', () => {
    expect(scopedExpiresInSec(1_700_000_000 - 10, NOW_MS)).toBe(0)
  })
  it('returns 0 for a non-finite validUntilSec', () => {
    expect(scopedExpiresInSec(Number.NaN, NOW_MS)).toBe(0)
  })
})

describe('formatExpiresIn', () => {
  it('shows h+m above an hour', () => {
    expect(formatExpiresIn(3 * 3600 + 25 * 60 + 10)).toBe('3h 25m')
  })
  it('shows m+s under an hour', () => {
    expect(formatExpiresIn(5 * 60 + 7)).toBe('5m 7s')
  })
  it('shows s only under a minute', () => {
    expect(formatExpiresIn(42)).toBe('42s')
  })
  it("shows 'expired' at or below zero", () => {
    expect(formatExpiresIn(0)).toBe('expired')
    expect(formatExpiresIn(-5)).toBe('expired')
  })
})

describe('signerPrefix', () => {
  it('truncates a full address to 0x1234…5678', () => {
    expect(signerPrefix('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
  })
  it('returns an em-dash for null/empty', () => {
    expect(signerPrefix(null)).toBe('—')
    expect(signerPrefix('')).toBe('—')
    expect(signerPrefix(undefined)).toBe('—')
  })
  it('passes through short input unchanged', () => {
    expect(signerPrefix('0x1234')).toBe('0x1234')
  })
})

describe('permissionIdPrefix', () => {
  it('shows a 4-byte permissionId whole (10 chars)', () => {
    expect(permissionIdPrefix('0xa2500760')).toBe('0xa2500760')
  })
  it('em-dash for null', () => {
    expect(permissionIdPrefix(null)).toBe('—')
  })
  it('ellipsizes an unexpectedly long value', () => {
    expect(permissionIdPrefix('0xa2500760deadbeef')).toBe('0xa2500760…')
  })
})

describe('formatMhUsdc6', () => {
  it('formats a whole-dollar base-6 value', () => {
    expect(formatMhUsdc6('100000000')).toBe('100')
  })
  it('trims trailing zeros on a fractional value', () => {
    expect(formatMhUsdc6('100500000')).toBe('100.5')
  })
  it('keeps full precision when present', () => {
    expect(formatMhUsdc6('123456')).toBe('0.123456')
  })
  it('returns 0 for null/empty', () => {
    expect(formatMhUsdc6(null)).toBe('0')
    expect(formatMhUsdc6('')).toBe('0')
  })
  it('returns the raw input on a parse failure (display-only, never throws)', () => {
    expect(formatMhUsdc6('not-a-number')).toBe('not-a-number')
  })
})

describe('isSessionLive', () => {
  it('true for an active session with TTL in the future', () => {
    expect(isSessionLive(fakeSession(), NOW_MS)).toBe(true)
  })
  it('false for null', () => {
    expect(isSessionLive(null, NOW_MS)).toBe(false)
  })
  it('false when status is not active', () => {
    expect(isSessionLive(fakeSession({ status: 'revoked' }), NOW_MS)).toBe(false)
    expect(isSessionLive(fakeSession({ status: 'expired' }), NOW_MS)).toBe(false)
  })
  it('false when the TTL has lapsed even if status is still active', () => {
    expect(isSessionLive(fakeSession({ validUntilSec: 1_700_000_000 - 1 }), NOW_MS)).toBe(false)
  })
})
