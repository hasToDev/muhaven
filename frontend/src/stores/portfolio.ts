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

export const usePortfolioStore = defineStore('portfolio', () => {
  const holdings = ref<PortfolioHolding[]>([])
  const usdcBalance = ref<bigint | null>(null)
  // PUSDC has two surfaces: `balanceOf` returns only the plaintext portion,
  // while `confidentialBalanceOf` returns an encrypted euint64 handle. The
  // total balance = public + confidential, but the confidential portion needs
  // FHE decrypt (opt-in, costs a passkey for the self-permit first time).
  const pusdcPublicBalance = ref<bigint | null>(null)
  const pusdcConfidentialBalance = ref<bigint | null>(null)
  const pusdcDecrypting = ref(false)
  // Scoped to the PUSDC card. Writing to the shared `error` ref instead
  // would flip PortfolioPage.vue into its full-page error state (it has a
  // top-level `v-else-if="portfolio.error"` branch that replaces the
  // dashboard with a Retry button), wiping every other loaded card for a
  // localized PUSDC failure. Keep this local.
  const pusdcError = ref<string | null>(null)
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
   * Load portfolio positions from backend + token metadata.
   * Does NOT decrypt balances — user opts in per-holding or all-at-once.
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

      // Read on-chain NAV per holding from `IssuerControlledOracle` —
      // truth source for purchase/redeem cost calculations. Convert from
      // "PUSDC base units per share unit" to "USD per whole share" so the
      // display math is `raw_share_count * usd_nav`. Falls back to the
      // backend's `latest_nav.nav` when the oracle is unconfigured for the
      // build (Wave 3 / pre-cutover envs) or the per-token read fails.
      const oracleConfigured = !isZeroAddress(v35Addresses.oracle)
      const readCtx = oracleConfigured ? buildReadContext() : null
      const oracleClient = readCtx ? new OracleClient(readCtx, v35Addresses.oracle) : null

      const holdingsWithMeta = await Promise.all(
        portfolioRes.positions.map(async (pos) => {
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
          return {
            tokenAddress: tokenAddr,
            symbol: pos.token_symbol,
            name: token?.name ?? pos.token_symbol,
            apy: token?.apy ? parseFloat(token.apy) : null,
            assetClass: token?.asset_class ?? 'other',
            encryptedBalance: null as `0x${string}` | null,
            decryptedBalance: null as bigint | null,
            decrypting: false,
            nav: onChainNav ?? backendNav,
          }
        }),
      )
      holdings.value = holdingsWithMeta

      // Load USDC balance (non-encrypted, standard ERC-20) + the plaintext
      // portion of legacy PUSDC in parallel. The confidential portion stays
      // null until the user clicks "Decrypt" — same opt-in pattern as
      // fhERC-20 holdings.
      //
      // Phase 7.5: PUSDC public surface still comes from the legacy
      // contract (mhUSDC has no plaintext shadow — it's confidential-only).
      // The "decrypted PUSDC" card on PortfolioPage reads mhUSDC when the
      // wrapper is configured, falling back to legacy PUSDC otherwise.
      const [usdc, pusdcPublic] = await Promise.all([
        Erc20Service.balanceOf(addresses.usdc, walletAddress),
        LegacyPusdcService.balanceOf(walletAddress),
      ])
      usdcBalance.value = usdc
      pusdcPublicBalance.value = pusdcPublic

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
  async function decryptPusdc(walletAddress: `0x${string}`) {
    if (pusdcDecrypting.value) return
    pusdcDecrypting.value = true
    pusdcConfidentialBalance.value = null
    pusdcError.value = null
    try {
      const { useFhe } = await import('@/composables/useFhe')
      const fhe = useFhe()
      await fhe.initialize()

      if (MuHavenStableService.isAvailable()) {
        const ctHash = await MuHavenStableService.confidentialBalanceOf(walletAddress)
        pusdcConfidentialBalance.value = await fhe.decryptMhUsdcForView(ctHash)
      } else {
        const ctHash = await LegacyPusdcService.confidentialBalanceOf(walletAddress)
        pusdcConfidentialBalance.value = await fhe.decryptUint64ForView(ctHash)
      }
    } catch (e) {
      pusdcError.value = e instanceof Error ? e.message : 'PUSDC decrypt failed'
    } finally {
      pusdcDecrypting.value = false
    }
  }

  function reset() {
    holdings.value = []
    usdcBalance.value = null
    pusdcPublicBalance.value = null
    pusdcConfidentialBalance.value = null
    pusdcDecrypting.value = false
    pusdcError.value = null
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    holdings,
    usdcBalance,
    pusdcPublicBalance,
    pusdcConfidentialBalance,
    pusdcDecrypting,
    pusdcError,
    loading,
    error,
    loaded,
    totalDecryptedValue,
    allDecrypted,
    load,
    decryptHolding,
    decryptPusdc,
    reset,
  }
})
