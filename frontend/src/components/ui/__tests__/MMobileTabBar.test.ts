/**
 * MMobileTabBar — primary tabs + "More" overflow sheet (Wave 6 Polish round 3).
 *
 * The bar shows a curated primary set (4 tabs) plus a "More" button that opens
 * a bottom sheet with every remaining route, so the full nav is reachable on
 * mobile (previously 4 investor routes were silently dropped). Asserts the
 * primary set, the More button, and that the overflow routes (e.g. Autonomy,
 * Marketplace) live in the sheet and navigate on tap. Stores + vue-router are
 * mocked so the bar mounts without a full app boot.
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

describe('MMobileTabBar — primary tabs + More sheet', () => {
  beforeEach(() => {
    state.role = 'investor'
    state.issuerStatus = 'approved'
    state.routePath = '/cash'
    state.push.mockReset()
    // Teleported sheet content lands on document.body — clear between tests.
    document.body.innerHTML = ''
  })

  it('shows the primary investor tabs + a More button', () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-cash"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-portfolio"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-trade"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-agent"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-more"]').exists()).toBe(true)
  })

  it('shows the primary issuer tabs + a More button', () => {
    state.role = 'issuer'
    state.issuerStatus = 'approved'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-cash"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-tokens"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-distribute"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-more"]').exists()).toBe(true)
  })

  it('surfaces overflow routes (Autonomy, Marketplace) in the More sheet', async () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    // Sheet is closed until More is tapped.
    expect(document.querySelector('[data-testid="tabbar-more-autonomy"]')).toBeNull()
    await w.find('[data-testid="tabbar-nav-more"]').trigger('click')
    expect(document.querySelector('[data-testid="tabbar-more-autonomy"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="tabbar-more-marketplace"]')).not.toBeNull()
  })

  it('routes to the autonomy (policy) page from the More sheet', async () => {
    state.role = 'investor'
    const w = mount(MMobileTabBar)
    await w.find('[data-testid="tabbar-nav-more"]').trigger('click')
    const autonomy = document.querySelector(
      '[data-testid="tabbar-more-autonomy"]',
    ) as HTMLElement
    autonomy.click()
    expect(state.push).toHaveBeenCalledWith('/agent/policy/transition')
  })

  it('omits the More button for an unapproved issuer (minimal onboarding set)', () => {
    state.role = 'issuer'
    state.issuerStatus = 'pending'
    const w = mount(MMobileTabBar)
    expect(w.find('[data-testid="tabbar-nav-more"]').exists()).toBe(false)
    // Onboarding set still carries Apply + Cash + Agent.
    expect(w.find('[data-testid="tabbar-nav-apply"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-cash"]').exists()).toBe(true)
    expect(w.find('[data-testid="tabbar-nav-agent"]').exists()).toBe(true)
  })
})
