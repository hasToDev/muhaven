/**
 * Wave 5 Option D · Commit 4 — MMobileTabBar nav-entry presence.
 *
 * Asserts the agent-autonomy tab (labelled "Autonomy", route
 * `/agent/policy/transition`) appears for both investor + issuer roles and
 * is suppressed for an unapproved issuer (the minimal onboarding set).
 * Stores + vue-router are mocked so the bar mounts without a full app boot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

const state = vi.hoisted(() => ({
  role: 'investor' as 'investor' | 'issuer',
  issuerStatus: 'approved' as string,
  routePath: '/cash',
  push: vi.fn(),
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    get role() {
      return state.role
    },
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get issuerStatus() {
      return state.issuerStatus
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

import MMobileTabBar from '../MMobileTabBar.vue'

describe('MMobileTabBar — Autonomy entry', () => {
  beforeEach(() => {
    state.role = 'investor'
    state.issuerStatus = 'approved'
    state.routePath = '/cash'
    state.push.mockReset()
  })

  it('shows the Autonomy tab for an investor', () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-autonomy"]').exists()).toBe(true)
  })

  it('shows the Autonomy tab for an approved issuer', () => {
    state.role = 'issuer'
    state.issuerStatus = 'approved'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-autonomy"]').exists()).toBe(true)
  })

  it('Autonomy sits penultimate, just before Agent', () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    const labels = w.findAll('button').map((b) => b.text())
    const policyIdx = labels.indexOf('Autonomy')
    const agentIdx = labels.indexOf('Agent')
    expect(policyIdx).toBeGreaterThanOrEqual(0)
    expect(agentIdx).toBe(policyIdx + 1)
  })

  it('omits Autonomy for an unapproved issuer (minimal onboarding set)', () => {
    state.role = 'issuer'
    state.issuerStatus = 'pending'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-autonomy"]').exists()).toBe(false)
    // Onboarding set still carries Apply + Cash + Agent.
    expect(w.find('[data-testid="tabbar-nav-apply"]').exists()).toBe(true)
  })

  it('routes to the autonomy (policy) page on tap', async () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    await w.find('[data-testid="tabbar-nav-autonomy"]').trigger('click')
    expect(state.push).toHaveBeenCalledWith('/agent/policy/transition')
  })
})
