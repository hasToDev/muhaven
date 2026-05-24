/**
 * Wave 5 Option D · C4 — component test for the PolicyTransitionPage REVOKE
 * flow (the security-critical kill-switch). The three review passes flagged
 * this 520-line page as having zero component coverage; this exercises the
 * load-bearing path: active session → revoke zone → alertdialog → 3s-hold
 * dual-tap gate → DELETE → zone gone.
 *
 * Stores / router / api / sonner are mocked; the real `useScopedSession`
 * singleton + `useModalA11y` run. The revoke dialog is teleported to
 * <body>, so dialog elements are queried via `document`, page elements via
 * the wrapper. Fake timers drive the 3s hold deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  getState: vi.fn(),
  getActiveScopedSession: vi.fn(),
  revokeScopedSession: vi.fn(),
  // unused by the revoke path but referenced by the page module
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

const SESSION_ID = 'sess-revoke-1'

function activeSession() {
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
    validUntilSec: Math.floor(Date.now() / 1000) + 3600,
    mintedAtSec: Math.floor(Date.now() / 1000) - 60,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: new Date().toISOString(),
    revokedAt: null,
    expiredAt: null,
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

async function mountWithActiveSession() {
  api.getState.mockResolvedValue({ surfaces: [mcpScopedState()] })
  api.getActiveScopedSession.mockResolvedValue({ session: activeSession() })
  const w = mount(PolicyTransitionPage, {
    attachTo: document.body,
    global: { stubs: STUBS },
  })
  await flushPromises() // drain onMounted (getState + refreshScopedSession)
  return w
}

describe('PolicyTransitionPage — revoke flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(api).forEach((fn) => fn.mockReset())
    useScopedSession().reset()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('renders the revoke zone when an active Scoped session exists', async () => {
    const w = await mountWithActiveSession()
    expect(w.find('[data-testid="policy-revoke-zone"]').exists()).toBe(true)
    expect(w.find('[data-testid="policy-revoke-now"]').exists()).toBe(true)
  })

  it('opens an alertdialog with the confirm button hold-disabled (aria-disabled) for 3s', async () => {
    const w = await mountWithActiveSession()
    await w.find('[data-testid="policy-revoke-now"]').trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-testid="policy-revoke-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('alertdialog')

    const confirm = document.querySelector('[data-testid="policy-revoke-confirm"]')!
    // Hold active → aria-disabled true, but NOT natively disabled (stays
    // focusable + Tab-order-stable per the a11y fix).
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    expect(confirm.hasAttribute('disabled')).toBe(false)

    vi.advanceTimersByTime(3000)
    await flushPromises()
    expect(confirm.getAttribute('aria-disabled')).toBe('false')
  })

  it('ignores a confirm tap during the hold (no DELETE), then revokes after the hold', async () => {
    const w = await mountWithActiveSession()
    await w.find('[data-testid="policy-revoke-now"]').trigger('click')
    await flushPromises()

    const confirm = document.querySelector('[data-testid="policy-revoke-confirm"]') as HTMLElement
    // Tap during hold — guarded no-op.
    confirm.click()
    await flushPromises()
    expect(api.revokeScopedSession).not.toHaveBeenCalled()

    // After the 3s hold, the tap revokes.
    api.revokeScopedSession.mockResolvedValue({
      session: { ...activeSession(), status: 'revoked', revokedAt: new Date().toISOString() },
    })
    // Revoke auto-steps the MCP tier back to Advisory (so re-arming is a
    // clean re-pick of Scoped, not a manual step-down dance).
    api.requestTransition.mockResolvedValue({
      requiresConfirmation: false,
      state: { ...mcpScopedState(), tier: 'advisory' },
    })
    vi.advanceTimersByTime(3000)
    await flushPromises()
    confirm.click()
    await flushPromises()

    expect(api.revokeScopedSession).toHaveBeenCalledWith({ sessionId: SESSION_ID })
    // Auto step-down to Advisory on the MCP surface.
    expect(api.requestTransition).toHaveBeenCalledWith({ surface: 'mcp', targetTier: 'advisory' })
    // Dialog closed + revoke zone gone (session cleared) + purge reminder armed.
    expect(document.querySelector('[data-testid="policy-revoke-dialog"]')).toBeNull()
    expect(w.find('[data-testid="policy-revoke-zone"]').exists()).toBe(false)
    expect(useScopedSession().pendingBrokerPurge.value?.sessionId).toBe(SESSION_ID)
  })

  it('cancel closes the dialog without revoking', async () => {
    const w = await mountWithActiveSession()
    await w.find('[data-testid="policy-revoke-now"]').trigger('click')
    await flushPromises()

    const cancel = document.querySelector('[data-testid="policy-revoke-cancel"]') as HTMLElement
    cancel.click()
    await flushPromises()

    expect(api.revokeScopedSession).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="policy-revoke-dialog"]')).toBeNull()
    // Session still active — zone remains.
    expect(w.find('[data-testid="policy-revoke-zone"]').exists()).toBe(true)
  })

  it('surfaces the API error inline and keeps the dialog open on a failed revoke', async () => {
    const w = await mountWithActiveSession()
    await w.find('[data-testid="policy-revoke-now"]').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(3000)
    await flushPromises()

    const { ApiError } = await import('@/services/api')
    api.revokeScopedSession.mockRejectedValue(new ApiError(409, { message: 'already inactive' }))
    const confirm = document.querySelector('[data-testid="policy-revoke-confirm"]') as HTMLElement
    confirm.click()
    await flushPromises()

    // Dialog stays open with the error surfaced; zone still present.
    expect(document.querySelector('[data-testid="policy-revoke-dialog"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="policy-revoke-dialog-error"]')?.textContent)
      .toContain('already inactive')
    expect(w.find('[data-testid="policy-revoke-zone"]').exists()).toBe(true)
  })
})
