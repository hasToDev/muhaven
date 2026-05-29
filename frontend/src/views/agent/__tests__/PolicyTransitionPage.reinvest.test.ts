/**
 * Wave 5 Slice 2c — component test for the PolicyTransitionPage auto-reinvest
 * toggle. Exercises: render when active session exists, reflect the persisted
 * `reinvestEnabled`, optimistic flip + POST on click, error roll-back.
 *
 * Mirrors the revoke test harness (stores / router / api / sonner mocked;
 * the real `useScopedSession` singleton runs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  getState: vi.fn(),
  getActiveScopedSession: vi.fn(),
  revokeScopedSession: vi.fn(),
  setReinvestEnabled: vi.fn(),
  requestTransition: vi.fn(),
  commitTransition: vi.fn(),
  resume: vi.fn(),
  mintScopedSession: vi.fn(),
}))

vi.mock('@/services/api', () => {
  class ApiError extends Error {
    status: number
    body: unknown
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`)
      this.status = status
      this.body = body
    }
  }
  return { ApiError, agentPolicyApi: api }
})
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAuthenticated: true }) }))
vi.mock('@/stores/wallet', () => ({ useWalletStore: () => ({ connected: true }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, fullPath: '/agent/policy/transition' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('vue-sonner', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() })
  return { toast }
})

import PolicyTransitionPage from '../PolicyTransitionPage.vue'
import { useScopedSession } from '@/composables/useScopedSession'

const SESSION_ID = 'sess-reinvest-1'

function activeSession(reinvestEnabled = false) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    sessionId: SESSION_ID,
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
    validUntilSec: nowSec + 3600,
    mintedAtSec: nowSec - 60,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: new Date().toISOString(),
    revokedAt: null,
    expiredAt: null,
    enableStatus: 'enabled',
    reinvestEnabled,
  }
}

function mcpScopedState() {
  return {
    userId: '0xuser',
    surface: 'mcp',
    tier: 'scoped',
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
    enteredAt: new Date().toISOString(),
    validatorAddress: null,
    confirmedActionCount: 0,
    riskQuestionnaireComplete: false,
    updatedAt: new Date().toISOString(),
  }
}

const STUBS = {
  MButton: { template: '<button><slot /></button>' },
  MPageLoader: { template: '<div data-testid="stub-loader" />' },
  SessionKeyRevealModal: { template: '<div data-testid="stub-reveal" />' },
}

async function mountWith(reinvestEnabled = false) {
  api.getState.mockResolvedValue({ surfaces: [mcpScopedState()] })
  api.getActiveScopedSession.mockResolvedValue({ session: activeSession(reinvestEnabled) })
  const w = mount(PolicyTransitionPage, { attachTo: document.body, global: { stubs: STUBS } })
  await flushPromises()
  return w
}

describe('PolicyTransitionPage — auto-reinvest toggle', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset())
    useScopedSession().reset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the toggle (OFF) when an active session has reinvestEnabled=false', async () => {
    const w = await mountWith(false)
    const sw = w.find('[data-testid="policy-reinvest-switch"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('aria-checked')).toBe('false')
  })

  it('reflects a persisted reinvestEnabled=true as ON', async () => {
    const w = await mountWith(true)
    expect(w.find('[data-testid="policy-reinvest-switch"]').attributes('aria-checked')).toBe('true')
  })

  it('flips ON + POSTs { enabled: true } and reflects the committed row', async () => {
    const w = await mountWith(false)
    api.setReinvestEnabled.mockResolvedValue({ session: activeSession(true) })
    await w.find('[data-testid="policy-reinvest-switch"]').trigger('click')
    await flushPromises()
    expect(api.setReinvestEnabled).toHaveBeenCalledWith({ enabled: true })
    expect(w.find('[data-testid="policy-reinvest-switch"]').attributes('aria-checked')).toBe('true')
  })

  it('rolls back + surfaces an error when the POST fails', async () => {
    const w = await mountWith(false)
    api.setReinvestEnabled.mockRejectedValue(new Error('boom'))
    await w.find('[data-testid="policy-reinvest-switch"]').trigger('click')
    await flushPromises()
    // Rolled back to OFF.
    expect(w.find('[data-testid="policy-reinvest-switch"]').attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="policy-reinvest-error"]').exists()).toBe(true)
  })

  it('rolls back (no false success) when the active session changed mid-toggle', async () => {
    const w = await mountWith(false)
    // Backend returns a DIFFERENT session id (a revoke+re-mint landed under us).
    api.setReinvestEnabled.mockResolvedValue({
      session: { ...activeSession(true), sessionId: 'sess-different' },
    })
    await w.find('[data-testid="policy-reinvest-switch"]').trigger('click')
    await flushPromises()
    // The composable throws → page rolls back to OFF + shows an error, NOT a
    // misleading "enabled" state for a toggle that didn't apply to this session.
    expect(w.find('[data-testid="policy-reinvest-switch"]').attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="policy-reinvest-error"]').exists()).toBe(true)
  })
})
