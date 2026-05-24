/**
 * Wave 5 — marketplace icon resolver. Verifies the manifest lookup
 * (case-insensitive, null on miss — no S3 fallback) + the monogram
 * helper. The generated manifest is mocked so the test is deterministic
 * and independent of which icons are currently baked.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/data/tokenIcons.generated', () => ({
  TOKEN_ICON_MANIFEST: {
    USYC: '/token-icons/USYC.png',
    syrupUSDC: '/token-icons/syrupUSDC.png',
  },
}))

import { resolveTokenIconUrl, tokenMonogram } from '@/lib/tokenIcon'

describe('resolveTokenIconUrl', () => {
  it('resolves a baked ticker (exact case)', () => {
    expect(resolveTokenIconUrl('USYC')).toBe('/token-icons/USYC.png')
  })

  it('resolves case-insensitively (matches the store lookup convention)', () => {
    expect(resolveTokenIconUrl('usyc')).toBe('/token-icons/USYC.png')
    expect(resolveTokenIconUrl('SYRUPUSDC')).toBe('/token-icons/syrupUSDC.png')
  })

  it('returns null for an unbaked ticker (caller renders a monogram)', () => {
    expect(resolveTokenIconUrl('NOPE')).toBeNull()
  })

  it('never falls back to a third-party URL — null for nullish input', () => {
    expect(resolveTokenIconUrl(null)).toBeNull()
    expect(resolveTokenIconUrl(undefined)).toBeNull()
    expect(resolveTokenIconUrl('')).toBeNull()
  })
})

describe('tokenMonogram', () => {
  it('uppercases the first character', () => {
    expect(tokenMonogram('usyc')).toBe('U')
    expect(tokenMonogram('syrupUSDC')).toBe('S')
    expect(tokenMonogram('BUIDL')).toBe('B')
  })

  it('falls back to "?" for empty / whitespace / nullish', () => {
    expect(tokenMonogram('')).toBe('?')
    expect(tokenMonogram('   ')).toBe('?')
    expect(tokenMonogram(null)).toBe('?')
    expect(tokenMonogram(undefined)).toBe('?')
  })
})
