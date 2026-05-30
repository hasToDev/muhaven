/** Unit tests for the rebalance-targets store + its pure validator. */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useRebalanceTargetsStore,
  validateRebalanceTargets,
  DEFAULT_TOLERANCE_BPS,
} from '@/stores/rebalanceTargets'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const WALLET = '0x' + '1'.repeat(40)

describe('validateRebalanceTargets', () => {
  it('accepts a 100%-summing set with a valid tolerance', () => {
    expect(validateRebalanceTargets({ [A]: 6000, [B]: 4000 }, 500)).toBeNull()
  })
  it('rejects an empty target set', () => {
    expect(validateRebalanceTargets({}, 500)).toMatch(/at least one/i)
  })
  it('rejects a set that does not sum to 100%', () => {
    expect(validateRebalanceTargets({ [A]: 6000, [B]: 3000 }, 500)).toMatch(/sum to 100/i)
  })
  it('rejects an invalid token address', () => {
    expect(validateRebalanceTargets({ '0xnope': 10000 }, 500)).toMatch(/Invalid token address/i)
  })
  it('rejects out-of-range tolerance', () => {
    expect(validateRebalanceTargets({ [A]: 10000 }, 1)).toMatch(/tolerance/i) // < 0.5%
    expect(validateRebalanceTargets({ [A]: 10000 }, 9000)).toMatch(/tolerance/i) // > 50%
  })
  it('rejects a non-integer / out-of-range bps', () => {
    expect(validateRebalanceTargets({ [A]: 10001 }, 500)).toMatch(/0–100%/)
  })
})

describe('useRebalanceTargetsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('starts unconfigured with the default tolerance', () => {
    const store = useRebalanceTargetsStore()
    store.load(WALLET)
    expect(store.isConfigured).toBe(false)
    expect(store.toleranceBps).toBe(DEFAULT_TOLERANCE_BPS)
  })

  it('persists + reloads targets per wallet (localStorage round-trip)', () => {
    const store = useRebalanceTargetsStore()
    store.save(WALLET, { [A]: 7000, [B]: 3000 }, 800)
    expect(store.isConfigured).toBe(true)
    expect(store.getTargetBps(A)).toBe(7000)
    expect(store.toleranceBps).toBe(800)

    // Fresh store instance + reload reads it back from localStorage.
    setActivePinia(createPinia())
    const store2 = useRebalanceTargetsStore()
    store2.load(WALLET)
    expect(store2.getTargetBps(A.toUpperCase())).toBe(7000) // case-insensitive
    expect(store2.getTargetBps(B)).toBe(3000)
    expect(store2.toleranceBps).toBe(800)
  })

  it('refuses to save a non-100% set', () => {
    const store = useRebalanceTargetsStore()
    expect(() => store.save(WALLET, { [A]: 6000 }, 500)).toThrow(/sum to 100/i)
  })

  it('clears targets', () => {
    const store = useRebalanceTargetsStore()
    store.save(WALLET, { [A]: 10000 }, 500)
    expect(store.isConfigured).toBe(true)
    store.clear(WALLET)
    expect(store.isConfigured).toBe(false)
    expect(store.getTargetBps(A)).toBe(0)
  })

  it('isolates targets per wallet', () => {
    const store = useRebalanceTargetsStore()
    const OTHER = '0x' + '2'.repeat(40)
    store.save(WALLET, { [A]: 10000 }, 500)
    store.load(OTHER)
    expect(store.isConfigured).toBe(false)
  })
})
