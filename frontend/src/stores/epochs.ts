import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Address } from 'viem'
import { YieldSnapshotClient, type EpochView } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress, getYieldSnapshot } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'
import { useMarketplaceStore } from '@/stores/marketplace'

export interface EpochEntry {
  snapshotAddress: Address
  tokenAddress: Address
  tokenSymbol: string
  tokenName: string
  epochId: bigint
  epoch: EpochView
  /** Encrypted per-investor snapshot balance; non-zero implies inclusion. */
  encSnapshotBalance: `0x${string}`
  claimed: boolean
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Wave 3.5 pull-based epoch state, hoisted out of YieldsPage local refs so
 * sidebar/topbar surfaces can read claimable counts without remounting the
 * page. Loader walks each YieldSnapshot proxy's epoch range exactly once
 * and resolves token metadata from the on-chain `epoch.token` (NOT from
 * the iteration key — proxies may host multiple tokens, the snapshot id
 * is global per-proxy).
 */
export const useEpochsStore = defineStore('epochs', () => {
  const items = ref<EpochEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)
  /** Address state was last loaded for; used to invalidate on account swap. */
  const lastLoadedFor = ref<Address | null>(null)

  const unclaimedCount = computed(() =>
    items.value.filter(e => !e.claimed && e.epoch.funded).length,
  )

  const claimedCount = computed(() =>
    items.value.filter(e => e.claimed).length,
  )

  const tokensTracked = computed(() => {
    const set = new Set<string>()
    for (const e of items.value) set.add(e.tokenAddress.toLowerCase())
    return set.size
  })

  /** Tokens for which the user has at least one non-zero snapshot. */
  const tokensWithEpochs = computed<Array<{
    address: Address
    symbol: string
    name: string
  }>>(() => {
    const seen = new Map<string, { address: Address; symbol: string; name: string }>()
    for (const e of items.value) {
      const key = e.tokenAddress.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, {
          address: e.tokenAddress,
          symbol: e.tokenSymbol,
          name: e.tokenName,
        })
      }
    }
    return Array.from(seen.values())
  })

  async function load(user: Address) {
    // In-flight guard — onMounted + the address watcher in YieldsPage can
    // both fire `load()` if the wallet attaches mid-mount. Without this
    // guard concurrent loads would clobber each other's `items` write.
    if (loading.value) return
    loading.value = true
    error.value = null
    try {
      const marketplace = useMarketplaceStore()
      if (!marketplace.loaded) await marketplace.load()

      // Group tokens by their YieldSnapshot proxy. Multiple tokens may share
      // the same proxy (staging maps both TBILL1 + GOLD1 to one proxy), and
      // the contract assigns epoch ids globally per-proxy. Walking per-token
      // and trusting the iteration key would mis-attribute one token's epoch
      // as belonging to another whenever the investor was snapshotted in
      // both. Instead: walk each proxy's full id range exactly once, fetch
      // `getEpoch(i)` to discover the actual `epoch.token`, then resolve
      // metadata from that.
      //
      // Wave 5+ per-token YieldSnapshot binding (2026-05-23): resolve each
      // marketplace token's proxy via `getYieldSnapshot(t.address)`. The
      // resolver consults (in order) the runtime registration map
      // (populated by marketplace.load() above via
      // `registerYieldSnapshot`), the env-var per-token map, and the
      // singleton fallback. Wizard-deployed tokens route to their OWN
      // per-token proxy; legacy tokens route to the env-map / singleton.
      // The grouping reduces duplicates naturally — staging's
      // multi-token-per-singleton bucket stays one walk.
      const byProxy = new Map<Address, Address[]>()
      for (const t of marketplace.tokens) {
        const proxy = getYieldSnapshot(t.address as `0x${string}`)
        if (!proxy || isZeroAddress(proxy)) continue
        const list = byProxy.get(proxy) ?? []
        list.push(t.address.toLowerCase() as Address)
        byProxy.set(proxy, list)
      }
      // Defensive: also walk the static env-var map for any token that
      // marketplace happened to omit (e.g. legacy active-token catalog
      // out of sync). This is the legacy-coverage backstop only; in the
      // common case `marketplace.tokens` is the authoritative list.
      for (const [tokenAddrLower, snapshotAddr] of Object.entries(v35Addresses.yieldSnapshots)) {
        if (!snapshotAddr || isZeroAddress(snapshotAddr)) continue
        const list = byProxy.get(snapshotAddr) ?? []
        if (!list.some((a) => a.toLowerCase() === tokenAddrLower.toLowerCase())) {
          list.push(tokenAddrLower as Address)
          byProxy.set(snapshotAddr, list)
        }
      }
      if (byProxy.size === 0) {
        items.value = []
        loaded.value = true
        lastLoadedFor.value = user
        return
      }

      const readCtx = buildReadContext()
      const collected: EpochEntry[] = []

      for (const [snapshotAddr, tokensOnProxy] of byProxy) {
        const snapshot = new YieldSnapshotClient(readCtx, snapshotAddr)

        // Upper bound: max(currentEpoch[t]) across every token we know maps
        // to this proxy. Equals the proxy's `nextEpochId` modulo tokens we
        // don't have addresses for (those would be unrenderable anyway).
        const epochCeilings = await Promise.all(
          tokensOnProxy.map(t => snapshot.getCurrentEpoch(t)),
        )
        const maxEpoch = epochCeilings.reduce(
          (m, e) => (e > m ? e : m),
          0n,
        )
        if (maxEpoch === 0n) continue

        // Epoch 0 is unused. If the walk grows past a few dozen per proxy,
        // switch to event-indexing.
        for (let i = 1n; i <= maxEpoch; i++) {
          const encSnapshotBalance = await snapshot.getSnapshotBalance(i, user)
          if (encSnapshotBalance === ZERO_BYTES32) continue

          const [epoch, claimed] = await Promise.all([
            snapshot.getEpoch(i),
            snapshot.hasClaimed(i, user),
          ])

          const tokenMeta = marketplace.getByAddress(epoch.token)
          const tokenSymbol = tokenMeta?.symbol ?? epoch.token.slice(0, 8)
          const tokenName = tokenMeta?.name ?? 'Unknown token'

          collected.push({
            snapshotAddress: snapshotAddr,
            tokenAddress: epoch.token,
            tokenSymbol,
            tokenName,
            epochId: i,
            epoch,
            encSnapshotBalance,
            claimed,
          })
        }
      }
      collected.sort((a, b) => (b.epochId > a.epochId ? 1 : -1))
      items.value = collected
      loaded.value = true
      lastLoadedFor.value = user
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load epochs'
    } finally {
      loading.value = false
    }
  }

  function reset() {
    items.value = []
    loading.value = false
    error.value = null
    loaded.value = false
    lastLoadedFor.value = null
  }

  return {
    items,
    loading,
    error,
    loaded,
    lastLoadedFor,
    unclaimedCount,
    claimedCount,
    tokensTracked,
    tokensWithEpochs,
    load,
    reset,
  }
})
