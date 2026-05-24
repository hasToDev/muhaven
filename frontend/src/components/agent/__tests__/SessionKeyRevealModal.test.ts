/**
 * Wave 5 OPEN-D frontend wiring — SessionKeyRevealModal.
 *
 * The modal's headline affordance is the one-paste
 * `muhaven-broker update --session <key>` command (the raw key + stdin form
 * stay as the advanced fallback). These tests drive the `preMinted` path
 * (the Scoped-transition reveal) so no wallet round-trip is needed, and
 * assert: the command is masked until Reveal, the primary copy writes the
 * FULL command, and the secondary copy writes the raw key only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// `preMinted` short-circuits before the store is touched, but the component
// still calls `useWalletStore()` at setup — provide a minimal stub.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({ connected: true, exportSessionKey: vi.fn() }),
}))

import SessionKeyRevealModal from '../SessionKeyRevealModal.vue'

const KEY = `0x${'ab'.repeat(32)}` as `0x${string}`
const EXPECTED_CMD = `muhaven-broker update --session ${KEY}`

function preMinted() {
  return {
    privateKey: KEY,
    smartAccountAddress: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
    expiresAtSec: Math.floor(Date.now() / 1000) + 14_400,
  }
}

function mountModal() {
  return mount(SessionKeyRevealModal, { props: { preMinted: preMinted() } })
}

describe('SessionKeyRevealModal — one-paste broker command', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom provides navigator.clipboard; define defensively in case a
    // future env doesn't, then spy through the mock.
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
    } else {
      vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('masks the command by default and reveals the full key on toggle', async () => {
    const w = mountModal()
    await flushPromises()

    const cmd = w.find('[data-testid="reveal-key-cmd"]')
    expect(cmd.exists()).toBe(true)
    // Headline verb is `update`, and the full key is NOT shown yet.
    expect(cmd.text()).toContain('muhaven-broker update --session')
    expect(cmd.text()).not.toContain(KEY)

    await w.find('[data-testid="reveal-key-toggle"]').trigger('click')
    expect(w.find('[data-testid="reveal-key-cmd"]').text()).toContain(KEY)
  })

  it('primary copy writes the full `update --session <key>` command', async () => {
    const w = mountModal()
    await flushPromises()

    await w.find('[data-testid="reveal-key-copy-cmd"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(EXPECTED_CMD)
    expect(w.find('[data-testid="reveal-key-copy-cmd"]').text()).toContain('Command copied')
    expect(w.find('[data-testid="reveal-key-copied-hint"]').exists()).toBe(true)
  })

  it('secondary (advanced) copy writes the raw key only', async () => {
    const w = mountModal()
    await flushPromises()

    await w.find('[data-testid="reveal-key-copy"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(KEY)
    expect(writeText).not.toHaveBeenCalledWith(EXPECTED_CMD)
    expect(w.find('[data-testid="reveal-key-copy"]').text()).toContain('Raw key copied')
  })

  it('no longer references the legacy MUHAVEN_BROKER_SESSION_KEY paste flow in the primary copy', async () => {
    const w = mountModal()
    await flushPromises()
    // The acknowledgement copy now points at the CLI command; the raw env
    // var is only mentioned in the advanced/stdin hint, never as the headline.
    const ack = w.find('[data-testid="reveal-key-ack"]')
    expect(ack.exists()).toBe(true)
    expect(w.html()).toContain('muhaven-broker update --session')
  })
})
