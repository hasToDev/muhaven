/**
 * Wave 5 Option D · Commit 4 — ScopedSessionBanner.
 *
 * Two mutually-exclusive variants: the active-session standing banner and
 * the post-revoke broker-purge reminder. Stores / router / api / toast are
 * mocked; the real `useScopedSession` singleton is driven via its API so
 * the banner's reactive wiring is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const state = vi.hoisted(() => ({
  authed: true,
  routePath: '/portfolio',
  push: vi.fn(),
}))
const api = vi.hoisted(() => ({
  getActiveScopedSession: vi.fn(),
  revokeScopedSession: vi.fn(),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get isAuthenticated() {
      return state.authed
    },
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({
    get path() {
      return state.routePath
    },
  }),
  useRouter: () => ({ push: state.push }),
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/services/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return {
    ApiError,
    agentPolicyApi: {
      getActiveScopedSession: api.getActiveScopedSession,
      revokeScopedSession: api.revokeScopedSession,
    },
  }
})

import ScopedSessionBanner from '../ScopedSessionBanner.vue'
import { useScopedSession } from '@/composables/useScopedSession'

function fakeSession(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    mode: 'scoped',
    surface: 'mcp',
    status: 'active',
    signerAddress: '0x1234567890abcdef1234567890abcdef12345678',
    permissionId: '0xa2500760',
    maxPerOpUsd6: '100000000',
    totalSpentUsd6: '0',
    validUntilSec: Math.floor(Date.now() / 1000) + 3600,
    mintedAtSec: Math.floor(Date.now() / 1000) - 60,
    mintedAt: new Date().toISOString(),
    revokedAt: null,
    expiredAt: null,
    ...over,
  }
}

describe('ScopedSessionBanner', () => {
  beforeEach(() => {
    state.authed = true
    state.routePath = '/portfolio'
    state.push.mockReset()
    api.getActiveScopedSession.mockReset()
    api.revokeScopedSession.mockReset()
    useScopedSession().reset()
  })

  it('renders the active-session banner for an authed user with a live session', async () => {
    api.getActiveScopedSession.mockResolvedValue({ session: fakeSession() })
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(true)
    expect(w.find('[data-testid="active-session-banner-cta"]').text()).toContain('Manage session')
  })

  it('CTA routes to the policy page revoke zone', async () => {
    api.getActiveScopedSession.mockResolvedValue({ session: fakeSession() })
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    await w.find('[data-testid="active-session-banner-cta"]').trigger('click')
    expect(state.push).toHaveBeenCalledWith('/agent/policy/transition?surface=mcp&focus=revoke')
  })

  it('hides the active banner on the policy page itself', async () => {
    state.routePath = '/agent/policy/transition'
    api.getActiveScopedSession.mockResolvedValue({ session: fakeSession() })
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(false)
  })

  it('does not fetch or render when unauthenticated', async () => {
    state.authed = false
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    expect(api.getActiveScopedSession).not.toHaveBeenCalled()
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(false)
  })

  it('shows the broker-purge reminder after a revoke, hiding the active banner', async () => {
    api.getActiveScopedSession.mockResolvedValue({ session: null })
    api.revokeScopedSession.mockResolvedValue({
      session: { ...fakeSession(), status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    // Arm the purge reminder via the shared composable.
    await useScopedSession().revoke('s1')
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    expect(w.find('[data-testid="scoped-session-purge-reminder"]').exists()).toBe(true)
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(false)

    // Dismiss clears it.
    await w.find('[data-testid="scoped-session-purge-dismiss"]').trigger('click')
    expect(w.find('[data-testid="scoped-session-purge-reminder"]').exists()).toBe(false)
  })

  it('purge-reminder Re-arm routes to the policy page pre-set to mint Scoped', async () => {
    api.getActiveScopedSession.mockResolvedValue({ session: null })
    api.revokeScopedSession.mockResolvedValue({
      session: { ...fakeSession(), status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    await useScopedSession().revoke('s1')
    const w = mount(ScopedSessionBanner)
    await flushPromises()

    const rearm = w.find('[data-testid="scoped-session-purge-rearm"]')
    expect(rearm.exists()).toBe(true)
    await rearm.trigger('click')
    // Lands on the tier picker pre-selecting MCP + Scoped — the mint there
    // surfaces the one-paste `muhaven-broker update --session <key>` command.
    expect(state.push).toHaveBeenCalledWith('/agent/policy/transition?surface=mcp&target=scoped')
  })

  it('dismiss × hides the active banner for that session', async () => {
    // Distinct sessionId — the dismiss state is module-level + keyed by
    // sessionId, so using a unique id keeps this test from suppressing the
    // banner in the other ('s1') cases regardless of run order.
    api.getActiveScopedSession.mockResolvedValue({
      session: fakeSession({ sessionId: 's1-dismiss' }),
    })
    const w = mount(ScopedSessionBanner)
    await flushPromises()
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(true)

    await w.find('[data-testid="active-session-banner-dismiss"]').trigger('click')
    expect(w.find('[data-testid="active-session-banner"]').exists()).toBe(false)
  })
})
