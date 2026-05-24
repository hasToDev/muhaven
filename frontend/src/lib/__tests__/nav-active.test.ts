/**
 * Wave 5 Option D · Commit 4 — `resolveActiveNavPath` longest-prefix-wins.
 *
 * The load-bearing case: the `Policy` entry (`/agent/policy/transition`)
 * is a sub-route of `Agent` (`/agent`), so a naive prefix-match lit both.
 */
import { describe, it, expect } from 'vitest'
import { resolveActiveNavPath } from '../nav-active'

const INVESTOR_NAV = [
  '/cash',
  '/portfolio',
  '/marketplace',
  '/trade',
  '/transfer',
  '/yields',
  '/redemptions',
  '/activity',
  '/agent/policy/transition',
  '/agent',
]

describe('resolveActiveNavPath', () => {
  it('exact match wins', () => {
    expect(resolveActiveNavPath(INVESTOR_NAV, '/portfolio')).toBe('/portfolio')
  })

  it('Policy page resolves to /agent/policy/transition, NOT /agent', () => {
    expect(resolveActiveNavPath(INVESTOR_NAV, '/agent/policy/transition')).toBe(
      '/agent/policy/transition',
    )
  })

  it('Agent page resolves to /agent (Policy path does not prefix-match it)', () => {
    expect(resolveActiveNavPath(INVESTOR_NAV, '/agent')).toBe('/agent')
  })

  it('a deeper /agent sub-route still resolves to /agent (no more-specific item)', () => {
    expect(resolveActiveNavPath(INVESTOR_NAV, '/agent/onboarding')).toBe('/agent')
  })

  it('a sub-route of a single-segment nav item keeps that item active', () => {
    const nav = ['/checkout', '/agent']
    expect(resolveActiveNavPath(nav, '/checkout/abc123')).toBe('/checkout')
    expect(resolveActiveNavPath(nav, '/checkout/webhooks')).toBe('/checkout')
  })

  it('does NOT match a sibling that shares a string prefix but not a path segment', () => {
    // `/agent` must not match `/agentfoo` (the `+ '/'` guard).
    expect(resolveActiveNavPath(['/agent'], '/agentfoo')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveActiveNavPath(INVESTOR_NAV, '/login')).toBeNull()
  })
})
