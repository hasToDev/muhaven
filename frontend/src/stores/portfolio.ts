import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { OracleClient } from '@muhaven/sdk'
import { portfolioApi, tokensApi, type PortfolioPositionDto, type TokenResponseDto } from '@/services/api'
import * as TokenService from '@/services/contracts/TokenService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as LegacyPusdcService from '@/services/contracts/LegacyPusdcService'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'

export interface PortfolioHolding {
  tokenAddress: `0x${string}`
  symbol: string
  name: string
  apy: number | null
  assetClass: string
  /** Encrypted handle — null if not yet loaded */
  encryptedBalance: `0x${string}` | null
  /** Decrypted balance — null until user opts in */
  decryptedBalance: bigint | null
  /** Whether a decrypt request is in flight */
  decrypting: boolean
  /** Latest NAV per token (USD) */
  nav: number | null
}

/**
 * Allocation slice for the donut + legend on /portfolio.
 * Single source of truth — the chart and legend both consume this.
 */
export interface AllocationSlice {
  /** Stable identity: `cash:usdc`, `cash:mhusdc`, or `<tokenAddress>` (lowercased). */
  key: string
  name: string
  /** USD value. Locked entries report 0. */
  value: number
  /** Percentage of `totalDecryptedValue`. Locked entries report 0. */
  pct: number
  /** Hex color from the Golden Hour Midnight palette. */
  color: string
  /** True for cash slices (USDC + mhUSDC) — drives cluster ordering + theming. */
  isCash: boolean
  /** True when value is unknown (encrypted handle, user hasn't decrypted). */
  isLocked: boolean
}

/**
 * Slice palette. Cash uses neutral/warm-tertiary tokens so RWAs own the
 * precious gold/amber accents. Hex pulled from `tailwind.css` @theme:
 * `--color-cool` / `--color-cipher` / `--color-gold` / `--color-signal` /
 * `--color-compute`. The 4th RWA slot derives a warm-bronze that's not
 * in the @theme but harmonises with the cluster.
 */
const ALLOCATION_PALETTE = {
  cashUsdc: '#9E8F78',
  cashMhusdc: '#D3C4B5',
  rwa: ['#FFBA20', '#FFDCA1', '#B8860B', '#D4914A'],
} as const

export const usePortfolioStore = defineStore('portfolio', () => {
  const holdings = ref<PortfolioHolding[]>([])
  const usdcBalance = ref<bigint | null>(null)
  // Wave 3.5 cash: `confidentialBalanceOf` returns an encrypted euint64 handle
  // (mhUSDC) that needs FHE decrypt — opt-in, costs a passkey on the
  // first-session self-permit. Pre-cutover (legacy PUSDC) had a plaintext
  // half too, but Phase 9.A dropped the read + UI: mhUSDC is confidential-
  // only and the "public portion" was dead surface.
  const pusdcConfidentialBalance = ref<bigint | null>(null)
  const pusdcDecrypting = ref(false)
  // Scoped to the PUSDC card. Writing to the shared `error` ref instead
  // would flip PortfolioPage.vue into its full-page error state (it has a
  // top-level `v-else-if="portfolio.error"` branch that replaces the
  // dashboard with a Retry button), wiping every other loaded card for a
  // localized PUSDC failure. Keep this local.
  const pusdcError = ref<string | null>(null)
  /**
   * `true` when the most-recent PASSIVE re-decrypt failed but a previously-
   * revealed value is still cached. UI surfaces this via a "Last refresh
   * failed · retry" sub-line so the user knows the cached value isn't
   * fresh — closes the auto-hide-after-time bug where transient cofhe TN
   * sealOutput failures (~1-5% per call per the documented chain-length
   * pathology) on the 30s safety poll silently wiped the revealed value.
   * Cleared on the next successful decrypt (passive or interactive).
   */
  const pusdcStale = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  const totalDecryptedValue = computed(() => {
    let total = 0
    for (const h of holdings.value) {
      if (h.decryptedBalance !== null) {
        // Wave 3.5: shares are raw-integer per `MuHavenSubscription.purchase`
        // natspec, and `nav` here is USD-per-whole-share derived from the
        // on-chain `IssuerControlledOracle` (PUSDC base units / 1e6) — see
        // `load()` for the read. USD value = raw_share_count * usd_nav.
        // (Backend `latest_nav.nav` from nav-cron writes par=1.0 for every
        // token by default and is NOT a faithful mirror of on-chain NAV
        // for testnet stages — using it gives 100*1=$100 for a token whose
        // real on-chain NAV is $0.01/share. We pull from the oracle to
        // sidestep that mismatch.)
        total += Number(h.decryptedBalance) * (h.nav ?? 1)
      }
    }
    // Add USDC (6 decimals, NAV = $1)
    if (usdcBalance.value !== null) {
      total += Number(usdcBalance.value) / 1e6
    }
    // Add decrypted mhUSDC (6 decimals, NAV = $1). The Cash Buffer card has
    // its own opt-in Decrypt button; when revealed, it must contribute to
    // the dashboard's total alongside the holdings + USDC.
    if (pusdcConfidentialBalance.value !== null) {
      total += Number(pusdcConfidentialBalance.value) / 1e6
    }
    return total
  })

  const allDecrypted = computed(() =>
    holdings.value.length > 0 && holdings.value.every(h => h.decryptedBalance !== null),
  )

  /**
   * Donut + legend on /portfolio's Allocation tab consume this. Rules:
   * - USDC: emit only when value > 0 (USDC is plaintext, no locked state).
   * - mhUSDC: ALWAYS emit when MuHavenStable is configured (so users see
   *   "mhUSDC ?" in the legend even before they reveal). Locked when
   *   `pusdcConfidentialBalance === null`. Revealed-zero is omitted to
   *   keep the legend tight.
   * - RWAs: emit each holding. Locked (`decryptedBalance === null`) keeps a
   *   placeholder slot. Revealed > 0 contributes a real arc. Revealed-zero
   *   is omitted.
   * - Sort: cash first (USDC then mhUSDC), then revealed RWAs by value
   *   descending, then locked RWAs at the end.
   */
  const allocationSlices = computed<AllocationSlice[]>(() => {
    const total = totalDecryptedValue.value
    const out: AllocationSlice[] = []

    // USDC
    if (usdcBalance.value !== null && usdcBalance.value > 0n) {
      const value = Number(usdcBalance.value) / 1e6
      out.push({
        key: 'cash:usdc',
        name: 'USDC',
        value,
        pct: total > 0 ? (value / total) * 100 : 0,
        color: ALLOCATION_PALETTE.cashUsdc,
        isCash: true,
        isLocked: false,
      })
    }

    // mhUSDC. Always present in the slice list so users see the encrypted
    // cash row even before they reveal. Revealed-zero omitted (consistent
    // with USDC=0 and revealed-RWA=0).
    if (pusdcConfidentialBalance.value === null) {
      out.push({
        key: 'cash:mhusdc',
        name: 'mhUSDC',
        value: 0,
        pct: 0,
        color: ALLOCATION_PALETTE.cashMhusdc,
        isCash: true,
        isLocked: true,
      })
    } else if (pusdcConfidentialBalance.value > 0n) {
      const value = Number(pusdcConfidentialBalance.value) / 1e6
      out.push({
        key: 'cash:mhusdc',
        name: 'mhUSDC',
        value,
        pct: total > 0 ? (value / total) * 100 : 0,
        color: ALLOCATION_PALETTE.cashMhusdc,
        isCash: true,
        isLocked: false,
      })
    }

    // RWA holdings. Two passes — revealed (sorted by value desc) then locked.
    const revealedRwa: AllocationSlice[] = []
    const lockedRwa: AllocationSlice[] = []
    holdings.value.forEach((h, i) => {
      const color = ALLOCATION_PALETTE.rwa[i % ALLOCATION_PALETTE.rwa.length]
      const key = h.tokenAddress.toLowerCase()
      if (h.decryptedBalance === null) {
        lockedRwa.push({
          key, name: h.name, value: 0, pct: 0, color,
          isCash: false, isLocked: true,
        })
        return
      }
      const value = Number(h.decryptedBalance) * (h.nav ?? 1)
      if (value <= 0) return
      revealedRwa.push({
        key, name: h.name, value,
        pct: total > 0 ? (value / total) * 100 : 0,
        color, isCash: false, isLocked: false,
      })
    })
    revealedRwa.sort((a, b) => b.value - a.value)

    return [...out, ...revealedRwa, ...lockedRwa]
  })

  /**
   * Load portfolio positions from backend + token metadata.
   * Does NOT decrypt balances — user opts in per-holding or all-at-once.
   *
   * Auto-discovers holdings the backend doesn't know about: the sender's
   * /trade Buy success path calls `portfolioApi.addPosition()` so the
   * backend tracks every Buy. P2P transfers (and any other path that
   * gets shares to a wallet without going through TradePage) bypass that
   * registration — the recipient lands on /portfolio with a backend that
   * has no record of the new token. We close the gap by walking the
   * marketplace's token list, calling `encryptedBalanceOf` for any token
   * NOT already in the backend's position list, and adopting any token
   * with a non-zero balance handle.
   */
  async function load(walletAddress: `0x${string}`) {
    loading.value = true
    error.value = null

    try {
      const [portfolioRes, tokensRes] = await Promise.all([
        portfolioApi.get(),
        tokensApi.getAll(),
      ])

      const tokenMap = new Map<string, TokenResponseDto>()
      for (const t of tokensRes.tokens) {
        tokenMap.set(t.address.toLowerCase(), t)
      }

      // Auto-discover positions for marketplace tokens NOT in the backend's
      // tracked list. `encryptedBalanceOf` returns the bytes32(0) sentinel
      // when the user has never interacted with the token contract;
      // anything else means the user has SOME (possibly zero-after-
      // silent-fail) on-chain balance handle and the holding card should
      // be discoverable. Persist via `addPosition` so subsequent visits
      // resolve through the backend's normal portfolio query — no re-walk.
      // Failures are best-effort; the merged position list still surfaces
      // the discovered token even if the backend persist fails.
      const ZERO_HANDLE =
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      const knownPositions = new Set(
        portfolioRes.positions.map((p) => p.token_address.toLowerCase()),
      )
      const candidates = tokensRes.tokens.filter(
        (t) => !knownPositions.has(t.address.toLowerCase()),
      )
      const probed = await Promise.allSettled(
        candidates.map(async (t) => {
          const handle = await TokenService.encryptedBalanceOf(
            walletAddress,
            t.address as `0x${string}`,
          )
          return handle.toLowerCase() === ZERO_HANDLE ? null : t
        }),
      )
      const discovered: TokenResponseDto[] = []
      for (const r of probed) {
        if (r.status !== 'fulfilled' || r.value === null) continue
        discovered.push(r.value)
      }
      // Fire-and-forget the backend persist so /portfolio renders without
      // waiting on the round-trip. Subsequent visits read these via
      // `portfolioApi.get()` and skip the auto-discover walk for them.
      for (const t of discovered) {
        portfolioApi.addPosition(t.address, t.symbol).catch((e) => {
          console.warn('[portfolio] auto-discover addPosition failed', e)
        })
      }

      // Read on-chain NAV per holding from `IssuerControlledOracle` —
      // truth source for purchase/redeem cost calculations. Convert from
      // "PUSDC base units per share unit" to "USD per whole share" so the
      // display math is `raw_share_count * usd_nav`. Falls back to the
      // backend's `latest_nav.nav` when the oracle is unconfigured for the
      // build (Wave 3 / pre-cutover envs) or the per-token read fails.
      const oracleConfigured = !isZeroAddress(v35Addresses.oracle)
      const readCtx = oracleConfigured ? buildReadContext() : null
      const oracleClient = readCtx ? new OracleClient(readCtx, v35Addresses.oracle) : null

      const allPositions: { token_address: string; token_symbol: string }[] = [
        ...portfolioRes.positions,
        ...discovered.map((t) => ({
          token_address: t.address,
          token_symbol: t.symbol,
        })),
      ]

      // Preserve previously-decrypted balances across the rebuild. Without
      // this, every safety-poll-triggered `load()` (every 30s on /portfolio)
      // would wipe `decryptedBalance` for every holding — RWA cards would
      // flicker back to locked just as the mhUSDC tile bug does. Watcher +
      // post-action paths (handleHoldingInbound, refreshAfterTrade, etc.)
      // remain the authoritative invalidators when on-chain state for a
      // specific token actually changes; they re-decrypt explicitly.
      // Lookup keyed by lowercased address (memory:
      // `feedback_address_case_at_repo_boundary`).
      const prevBalanceByAddress = new Map<string, bigint | null>()
      for (const h of holdings.value) {
        if (h.decryptedBalance !== null) {
          prevBalanceByAddress.set(h.tokenAddress.toLowerCase(), h.decryptedBalance)
        }
      }
      const holdingsWithMeta = await Promise.all(
        allPositions.map(async (pos) => {
          const tokenAddr = pos.token_address as `0x${string}`
          const token = tokenMap.get(tokenAddr.toLowerCase())
          const backendNav = token?.latest_nav ? parseFloat(token.latest_nav.nav) : null
          let onChainNav: number | null = null
          if (oracleClient) {
            try {
              const { nav } = await oracleClient.getNAV(tokenAddr)
              if (nav > 0n) onChainNav = Number(nav) / 1e6
            } catch (e) {
              console.warn(`[portfolio] on-chain NAV read failed for ${pos.token_symbol}`, e)
            }
          }
          const preservedBalance = prevBalanceByAddress.get(tokenAddr.toLowerCase()) ?? null
          return {
            tokenAddress: tokenAddr,
            symbol: pos.token_symbol,
            name: token?.name ?? pos.token_symbol,
            apy: token?.apy ? parseFloat(token.apy) : null,
            assetClass: token?.asset_class ?? 'other',
            encryptedBalance: null as `0x${string}` | null,
            decryptedBalance: preservedBalance as bigint | null,
            decrypting: false,
            nav: onChainNav ?? backendNav,
          }
        }),
      )
      holdings.value = holdingsWithMeta

      // Load USDC balance (non-encrypted, standard ERC-20). The mhUSDC
      // confidential balance stays null until the user clicks "Decrypt" —
      // same opt-in pattern as fhERC-20 holdings.
      usdcBalance.value = await Erc20Service.balanceOf(addresses.usdc, walletAddress)

      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load portfolio'
    } finally {
      loading.value = false
    }
  }

  /**
   * Decrypt a single holding's balance. Privacy-first: user explicitly opts in.
   * Uses client-side decryptForView (CoFHE SDK) — no on-chain transaction needed.
   */
  async function decryptHolding(index: number, accountAddress: `0x${string}`) {
    const holding = holdings.value[index]
    if (!holding || holding.decrypting) return

    holding.decrypting = true
    holding.decryptedBalance = null

    try {
      // Read the encrypted balance handle from THIS holding's token
      // contract. Wave 3.5 onboards each RWA as its own fhERC-20 (TBILL1,
      // GOLD1, …); the legacy `addresses.muHavenToken` is the Wave 3
      // single token and holds zero of TBILL1 / GOLD1 by construction.
      // Defaulting to that address — which the older code did — surfaced
      // every Wave 3.5 holding as "decrypted balance == 0".
      const ctHash = await TokenService.encryptedBalanceOf(
        accountAddress,
        holding.tokenAddress,
      )

      // Decrypt client-side via CoFHE SDK (permit-based, no tx needed).
      // Pass `holding.tokenAddress` so the 403 refresh fallback dispatches
      // `refreshDecryptGrant` against the correct per-token contract.
      const { useFhe } = await import('@/composables/useFhe')
      const fhe = useFhe()
      await fhe.initialize()
      holding.decryptedBalance = await fhe.decryptUint128ForView(
        ctHash,
        holding.tokenAddress,
      )
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Decrypt failed'
    } finally {
      holding.decrypting = false
    }
  }

  /**
   * Decrypt the caller's confidential stablecoin balance for UI display.
   * Uses cofhe SDK's decryptForView — permit-based, no on-chain tx.
   * Idempotent: re-clicking refreshes the handle + decrypts again.
   *
   * Phase 7.5 (`MHUSD_WRAPPER_PLAN.md` + ADR-041): when the
   * `MuHavenStable` wrapper is configured we read its `euint64` handle
   * and decrypt with the auto-refresh path (`decryptMhUsdcForView`) so
   * fresh sessions don't 403 on the kernel-only ACL grant. Pre-cutover
   * builds fall back to legacy PUSDC reads which can still 403 — that's
   * the gap the wrapper closes.
   */
  /**
   * Decrypt the caller's confidential mhUSDC balance for the UI.
   *
   * Failure semantics auto-derive from the cached state at call time:
   *   - **Cached value exists** (refresh/passive-poll path): preserve the
   *     cached value, set `pusdcStale = true`, log warn. The UI can swap
   *     its sub-line copy to "Last refresh failed · retry" while keeping
   *     the value visible. This closes the auto-hide-after-time bug
   *     where transient cofhe TN sealOutput failures (~1-5% per call per
   *     `project_cofhe_tn_chain_length_cap`) on the 30s safety poll
   *     silently nulled the revealed value.
   *   - **No cached value** (fresh reveal click): null + set
   *     `pusdcError` for the locked-tile error path.
   */
  async function decryptPusdc(walletAddress: `0x${string}`) {
    if (pusdcDecrypting.value) return
    pusdcDecrypting.value = true
    pusdcError.value = null
    try {
      const { useFhe } = await import('@/composables/useFhe')
      const fhe = useFhe()
      await fhe.initialize()

      // Decrypt then assign — keep the old revealed value visible while the
      // refresh is in flight so the UI doesn't flicker into the locked
      // (Decrypt CTA) layout.
      let next: bigint
      if (MuHavenStableService.isAvailable()) {
        const ctHash = await MuHavenStableService.confidentialBalanceOf(walletAddress)
        next = await fhe.decryptMhUsdcForView(ctHash)
      } else {
        const ctHash = await LegacyPusdcService.confidentialBalanceOf(walletAddress)
        next = await fhe.decryptUint64ForView(ctHash)
      }
      pusdcConfidentialBalance.value = next
      pusdcStale.value = false
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'PUSDC decrypt failed'
      if (pusdcConfidentialBalance.value !== null) {
        // Refresh-shape failure with a cached value — preserve it +
        // mark stale + log. Do NOT set `pusdcError` (that surface is
        // for the locked-tile-with-error state; setting it here would
        // bleed the failure into the locked layout even though we're
        // staying revealed).
        pusdcStale.value = true
        console.warn('[portfolio] mhUSDC re-decrypt failed; keeping cached value', e)
      } else {
        // Fresh-reveal failure — locked tile + scoped error message.
        pusdcError.value = msg
      }
    } finally {
      pusdcDecrypting.value = false
    }
  }

  function reset() {
    holdings.value = []
    usdcBalance.value = null
    pusdcConfidentialBalance.value = null
    pusdcDecrypting.value = false
    pusdcError.value = null
    pusdcStale.value = false
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    holdings,
    usdcBalance,
    pusdcConfidentialBalance,
    pusdcDecrypting,
    pusdcError,
    pusdcStale,
    loading,
    error,
    loaded,
    totalDecryptedValue,
    allDecrypted,
    allocationSlices,
    load,
    decryptHolding,
    decryptPusdc,
    reset,
  }
})
