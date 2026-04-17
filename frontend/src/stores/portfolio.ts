import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { portfolioApi, tokensApi, type PortfolioPositionDto, type TokenResponseDto } from '@/services/api'
import * as TokenService from '@/services/contracts/TokenService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import { addresses } from '@/contracts/addresses'

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
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  const totalDecryptedValue = computed(() => {
    let total = 0
    for (const h of holdings.value) {
      if (h.decryptedBalance !== null) {
        // Assume 18 decimals for fhERC-20, fallback NAV $1 if not yet fetched
        total += Number(h.decryptedBalance) / 1e18 * (h.nav ?? 1)
      }
    }
    // Add USDC (6 decimals, NAV = $1)
    if (usdcBalance.value !== null) {
      total += Number(usdcBalance.value) / 1e6
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

      holdings.value = portfolioRes.positions.map((pos) => {
        const token = tokenMap.get(pos.token_address.toLowerCase())
        return {
          tokenAddress: pos.token_address as `0x${string}`,
          symbol: pos.token_symbol,
          name: token?.name ?? pos.token_symbol,
          apy: token?.apy ? parseFloat(token.apy) : null,
          assetClass: token?.asset_class ?? 'other',
          encryptedBalance: null,
          decryptedBalance: null,
          decrypting: false,
          nav: token?.latest_nav ? parseFloat(token.latest_nav.nav) : null,
        }
      })

      // Load USDC balance (non-encrypted, standard ERC-20)
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
      // Get encrypted balance handle from on-chain
      const ctHash = await TokenService.encryptedBalanceOf(accountAddress)

      // Decrypt client-side via CoFHE SDK (permit-based, no tx needed)
      const { useFhe } = await import('@/composables/useFhe')
      const fhe = useFhe()
      await fhe.initialize()
      holding.decryptedBalance = await fhe.decryptUint128ForView(ctHash)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Decrypt failed'
    } finally {
      holding.decrypting = false
    }
  }

  function reset() {
    holdings.value = []
    usdcBalance.value = null
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    holdings,
    usdcBalance,
    loading,
    error,
    loaded,
    totalDecryptedValue,
    allDecrypted,
    load,
    decryptHolding,
    reset,
  }
})
