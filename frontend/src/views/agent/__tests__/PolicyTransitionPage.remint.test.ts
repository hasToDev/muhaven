/**
 * Wave 5 Option D · C4 re-smoke OPEN-A — component test for the DIRECT
 * Scoped re-mint flow: the operator lands already AT the `scoped` tier with
 * no live session (the prior one expired / was revoked), so the tier picker
 * would only offer "No change". The page must surface a dedicated re-mint
 * panel that mints a fresh broker session WITHOUT a tier transition — the
 * passkey ceremony in `installScopedSessionKey` is the consent, and the
 * snapshot POST carries NO `consentActionHash` (the backend field is
 * optional).
 *
 * Stores / router / api / sonner / addresses are mocked; the real
 * `useScopedSession` singleton + `policy-scoped.helpers` run. The wallet
 * store's `installScopedSessionKey` returns a structurally-valid install
 * result so `buildScopedMintBody` composes a real wire body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  getState: vi.fn(),
  getActiveScopedSession: vi.fn(),
  revokeScopedSession: vi.fn(),
  requestTransition: vi.fn(),
  commitTransition: vi.fn(),
  resume: vi.fn(),
  mintScopedSession: vi.fn(),
}))

const wallet = vi.hoisted(() => ({
  installScopedSessionKey: vi.fn(),
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
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({
    connected: true,
    installScopedSessionKey: wallet.installScopedSessionKey,
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, fullPath: '/agent/policy/transition' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('vue-sonner', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() })
  return { toast }
})
// Non-zero subscription address so the mint guard
// ("Subscription contract address is not configured") passes.
vi.mock('@/contracts/addresses', () => ({
  // `queues` mirrors the real `v35Addresses` shape (a per-token map);
  // `buildScopedMintBody` reads `Object.values(v35Addresses.queues)` for the
  // Wave 5 Slice 1 (MCP sell) queued-submit targets.
  v35Addresses: {
    subscription: '0x1234567890123456789012345678901234567890',
    queues: {
      '0x8d77ccf0a3a56c976a7deae59af1d27f27407b0d':
        '0x435af5af238abe80dd4dc571c38c167f407c4e9c',
    },
  },
}))

import PolicyTransitionPage from '../PolicyTransitionPage.vue'
import { useScopedSession } from '@/composables/useScopedSession'

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

/** A structurally-valid `ScopedSessionInstallResult` — shapes satisfy
 *  `buildScopedMintBody`'s regex gates (signer 20-byte, permissionId
 *  4-byte, enableData ≥ 2 hex, enableSig ≥ 256 hex, uint32 nonce). */
function installResult() {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    signerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    signerPrivateKey: `0x${'11'.repeat(32)}`,
    smartAccountAddress: '0x9999999999999999999999999999999999999999',
    permissionId: '0xdeadbeef',
    enableData: `0x${'cd'.repeat(64)}`,
    enableSig: `0x${'ab'.repeat(192)}`,
    validatorNonce: 1,
    mintedAtSec: nowSec,
    validUntilSec: nowSec + 14_400,
  }
}

const STUBS = {
  MButton: {
    // Forward `disabled` so the test can assert the gate, and pass clicks.
    props: ['disabled'],
    template:
      '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  MPageLoader: { template: '<div data-testid="stub-loader" />' },
  SessionKeyRevealModal: { template: '<div data-testid="stub-reveal" />' },
}

async function mountAtScopedNoSession() {
  api.getState.mockResolvedValue({ surfaces: [mcpScopedState()] })
  // No live session → the re-mint state.
  api.getActiveScopedSession.mockResolvedValue({ session: null })
  const w = mount(PolicyTransitionPage, {
    attachTo: document.body,
    global: { stubs: STUBS },
  })
  await flushPromises()
  return w
}

describe('PolicyTransitionPage — direct re-mint (OPEN-A)', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset())
    wallet.installScopedSessionKey.mockReset()
    useScopedSession().reset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the re-mint panel (not the revoke zone) and collapses the picker', async () => {
    const w = await mountAtScopedNoSession()
    expect(w.find('[data-testid="policy-remint-panel"]').exists()).toBe(true)
    expect(w.find('[data-testid="policy-revoke-zone"]').exists()).toBe(false)
    // Picker collapsed behind the "Change tier" disclosure (v-show:false).
    expect(w.find('[data-testid="policy-change-tier-toggle"]').exists()).toBe(true)
    const picker = w.find('[data-testid="policy-tier-picker"]')
    expect(picker.exists()).toBe(true)
    expect(picker.attributes('style') ?? '').toContain('display: none')
  })

  it('mints directly with NO consentActionHash, then reveals the broker key', async () => {
    wallet.installScopedSessionKey.mockResolvedValue(installResult())
    api.mintScopedSession.mockResolvedValue({ session: { sessionId: 'x' } })
    // After the mint, refreshScopedSession re-reads — return a live session
    // so the reveal modal renders + the panel flips to the revoke zone.
    api.getActiveScopedSession
      .mockResolvedValueOnce({ session: null }) // onMounted
      .mockResolvedValueOnce({
        session: {
          ...mcpScopedState(),
          sessionId: 'fresh',
          mode: 'scoped',
          status: 'active',
          signerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          permissionId: '0xdeadbeef',
          targetContracts: [],
          selectorCaps: [],
          maxPerOpUsd6: '100000000',
          totalSpentUsd6: '0',
          validUntilSec: Math.floor(Date.now() / 1000) + 14_400,
          mintedAtSec: Math.floor(Date.now() / 1000),
          consentActionHash: null,
          consentTextSha256: null,
          mintedAt: new Date().toISOString(),
          revokedAt: null,
          expiredAt: null,
        },
      })
    const w = await mountAtScopedNoSession()

    await w.find('[data-testid="policy-remint-submit"]').trigger('click')
    await flushPromises()

    // The local key mint ran with the cap/TTL from the shared refs.
    expect(wallet.installScopedSessionKey).toHaveBeenCalledTimes(1)
    const installArgs = wallet.installScopedSessionKey.mock.calls[0][0]
    expect(installArgs.maxPerOpUsd6).toBe(100_000_000n) // default $100
    expect(installArgs.maxSharesPerOp).toBe(100n)

    // The snapshot POST landed WITHOUT a consentActionHash (OPEN-A contract).
    expect(api.mintScopedSession).toHaveBeenCalledTimes(1)
    const body = api.mintScopedSession.mock.calls[0][0]
    expect(body.surface).toBe('mcp')
    expect(
      Object.prototype.hasOwnProperty.call(body.snapshot, 'consentActionHash'),
    ).toBe(false)
    expect(body.snapshot.permissionId).toBe('0xdeadbeef')

    // Broker-key reveal modal opened; re-mint panel gone (session now live).
    expect(w.find('[data-testid="stub-reveal"]').exists()).toBe(true)
    expect(w.find('[data-testid="policy-remint-panel"]').exists()).toBe(false)
  })

  it('keeps the panel mounted + picker collapsed while the mint ceremony is in flight', async () => {
    // Multi-agent review MED (Frontend Dev + Code Reviewer): `needsReMint`
    // is gated on `!submitting`, so the panel must stay mounted via the
    // dedicated `submittingDirectReMint` flag for the WebAuthn round-trip —
    // otherwise the "Minting…" spinner never shows + the tier picker flashes
    // in mid-ceremony. Drive a DEFERRED install promise to hold the flight
    // state open.
    let resolveInstall!: (v: unknown) => void
    wallet.installScopedSessionKey.mockReturnValue(
      new Promise((res) => {
        resolveInstall = res
      }),
    )
    api.mintScopedSession.mockResolvedValue({ session: { sessionId: 'x' } })
    const w = await mountAtScopedNoSession()

    await w.find('[data-testid="policy-remint-submit"]').trigger('click')
    await flushPromises()
    // Install promise still pending → panel mounted, picker still collapsed.
    expect(w.find('[data-testid="policy-remint-panel"]').exists()).toBe(true)
    const picker = w.find('[data-testid="policy-tier-picker"]')
    expect(picker.attributes('style') ?? '').toContain('display: none')

    // Resolve → mint POST → reveal modal opens; panel gone EVEN THOUGH the
    // post-mint refresh still returns no session (LOW-1: an open reveal
    // suppresses the panel via the `scopedReveal === null` gate).
    resolveInstall(installResult())
    await flushPromises()
    expect(w.find('[data-testid="stub-reveal"]').exists()).toBe(true)
    expect(w.find('[data-testid="policy-remint-panel"]').exists()).toBe(false)
  })

  it('disables the mint button + shows an error when the cap is below $1', async () => {
    const w = await mountAtScopedNoSession()
    const input = w.find('[data-testid="policy-remint-max-usd"]')
    await input.setValue('0.5') // < $1 floor
    await flushPromises()

    expect(w.find('[data-testid="policy-remint-form-error"]').text()).toContain('at least $1')
    expect(
      w.find('[data-testid="policy-remint-submit"]').attributes('disabled'),
    ).toBeDefined()

    // A click is a guarded no-op (button disabled + onDirectReMint re-checks).
    await w.find('[data-testid="policy-remint-submit"]').trigger('click')
    await flushPromises()
    expect(wallet.installScopedSessionKey).not.toHaveBeenCalled()
    expect(api.mintScopedSession).not.toHaveBeenCalled()
  })
})
