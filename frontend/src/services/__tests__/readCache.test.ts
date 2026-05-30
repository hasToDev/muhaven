import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dedupe, cachedFetch, invalidateReadCache, contractReadKey } from '../readCache'

describe('readCache', () => {
  beforeEach(() => {
    invalidateReadCache()
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('dedupe', () => {
    it('coalesces concurrent calls with the same key onto one fetch', async () => {
      const fetcher = vi.fn().mockResolvedValue('v')
      const [a, b, c] = await Promise.all([
        dedupe('k', fetcher),
        dedupe('k', fetcher),
        dedupe('k', fetcher),
      ])
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect([a, b, c]).toEqual(['v', 'v', 'v'])
    })

    it('re-fetches after the in-flight promise settles (no stale window)', async () => {
      const fetcher = vi.fn().mockResolvedValue('v')
      await dedupe('k', fetcher)
      await dedupe('k', fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('does not coalesce different keys', async () => {
      const fetcher = vi.fn().mockResolvedValue('v')
      await Promise.all([dedupe('a', fetcher), dedupe('b', fetcher)])
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('clears the in-flight entry on rejection so the next call retries', async () => {
      const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok')
      await expect(dedupe('k', fetcher)).rejects.toThrow('boom')
      await expect(dedupe('k', fetcher)).resolves.toBe('ok')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('captures a synchronous throw as a rejected promise', async () => {
      const fetcher = vi.fn(() => {
        throw new Error('sync')
      })
      await expect(dedupe('k', fetcher)).rejects.toThrow('sync')
    })
  })

  describe('cachedFetch', () => {
    it('serves a fresh hit without re-fetching', async () => {
      const fetcher = vi.fn().mockResolvedValue('v')
      await cachedFetch('k', 10_000, fetcher)
      await cachedFetch('k', 10_000, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('re-fetches once the TTL lapses', async () => {
      vi.useFakeTimers()
      const fetcher = vi.fn().mockResolvedValue('v')
      await cachedFetch('k', 1_000, fetcher)
      vi.advanceTimersByTime(1_001)
      await cachedFetch('k', 1_000, fetcher)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('does not cache a rejected fetch', async () => {
      const fetcher = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok')
      await expect(cachedFetch('k', 10_000, fetcher)).rejects.toThrow('x')
      await expect(cachedFetch('k', 10_000, fetcher)).resolves.toBe('ok')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })

  describe('invalidateReadCache', () => {
    it('drops matching keys only when a predicate is given', async () => {
      const f = vi.fn().mockResolvedValue('v')
      await cachedFetch('tokens:getAll', 10_000, f)
      await cachedFetch('other:thing', 10_000, f)
      invalidateReadCache((k) => k.startsWith('tokens:'))
      await cachedFetch('tokens:getAll', 10_000, f) // miss -> refetch
      await cachedFetch('other:thing', 10_000, f) // still fresh
      expect(f).toHaveBeenCalledTimes(3)
    })
  })

  describe('contractReadKey', () => {
    it('serializes bigint args and lowercases the address', () => {
      const k = contractReadKey('0xABcD', 'balanceOf', ['0xEE', 123n])
      expect(k).toBe('0xabcd:balanceOf:["0xEE","123n"]')
    })

    it('distinguishes different args', () => {
      expect(contractReadKey('0x1', 'fn', [1n])).not.toBe(contractReadKey('0x1', 'fn', [2n]))
    })
  })
})
