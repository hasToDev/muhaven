/**
 * Lightweight read-coalescing + TTL memoization for read-only fetches
 * (RPC `eth_call`s + static backend GETs). Two mechanisms:
 *
 *  - `dedupe(key, fetcher)` — in-flight coalescing. If an identical fetch is
 *    already running, return ITS promise instead of firing a second one. No
 *    staleness window: the entry is dropped the instant the promise settles,
 *    so the next call re-fetches. Pure RPC-volume reduction — safe for any
 *    read because two concurrent identical reads would return the same value
 *    anyway.
 *
 *  - `cachedFetch(key, ttlMs, fetcher)` — dedupe PLUS a short stale window. A
 *    still-fresh cached value resolves immediately; once the TTL lapses the
 *    next call re-fetches. Use ONLY for data that tolerates a few seconds of
 *    staleness (e.g. token metadata) — NOT balances/positions, whose
 *    cross-account freshness the portfolio store deliberately preserves.
 *
 * Rapid Cash<->Portfolio navigation used to re-fire the same reads back to
 * back against the rate-limited public Arb Sepolia RPC -> HTTP 429. These
 * collapse that burst. See development/DEV_WAVE_5/PERF_RPC_ROUTEGUARD_PLAN.md
 * WS-1.
 */

const inflight = new Map<string, Promise<unknown>>()
const ttlCache = new Map<string, { value: unknown; expiresAt: number }>()

/**
 * Coalesce concurrent identical reads onto a single in-flight promise.
 * `fetcher` is invoked SYNCHRONOUSLY on a cache miss so viem's multicall
 * batcher (which collects calls fired in the same tick) still sees the call.
 */
export function dedupe<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  let p: Promise<T>
  try {
    p = Promise.resolve(fetcher())
  } catch (e) {
    p = Promise.reject(e)
  }
  p = p.finally(() => {
    inflight.delete(key)
  }) as Promise<T>
  inflight.set(key, p)
  return p
}

/**
 * `dedupe` + a TTL stale window. A fresh hit resolves without touching the
 * network; a miss (or stale entry) re-fetches and re-stamps. Errors are NOT
 * cached — a rejected fetch leaves the stale entry (if any) untouched and is
 * re-attempted on the next call.
 */
export function cachedFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = ttlCache.get(key)
  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T)
  }
  return dedupe(key, async () => {
    const value = await fetcher()
    ttlCache.set(key, { value, expiresAt: Date.now() + ttlMs })
    return value
  })
}

/**
 * Drop cached + in-flight entries. With no predicate, clears everything
 * (call after a write so the next read is fresh). With a predicate, drops
 * only matching keys.
 */
export function invalidateReadCache(predicate?: (key: string) => boolean): void {
  if (!predicate) {
    ttlCache.clear()
    inflight.clear()
    return
  }
  for (const k of [...ttlCache.keys()]) if (predicate(k)) ttlCache.delete(k)
  for (const k of [...inflight.keys()]) if (predicate(k)) inflight.delete(k)
}

/**
 * Stable cache key for a contract read. Serializes `bigint` args (which
 * `JSON.stringify` would throw on) and lowercases the address so checksum
 * skew doesn't fragment the key.
 */
export function contractReadKey(address: string, fn: string, args: readonly unknown[]): string {
  const a = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
  return `${address.toLowerCase()}:${fn}:${a}`
}
