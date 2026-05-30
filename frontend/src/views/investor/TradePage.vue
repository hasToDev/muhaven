<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { toast } from 'vue-sonner'
import type { Address } from 'viem'
import { decodeEventLog } from 'viem'
import {
  SubscriptionClient,
  OracleClient,
  IdentityRegistryClient,
  muhavenSubscriptionAbi,
} from '@muhaven/sdk'
import { useMarketplaceStore } from '@/stores/marketplace'
import { usePortfolioStore } from '@/stores/portfolio'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext, buildReadContext, getPublicClient } from '@/services/v35/context'
import { portfolioApi, type TokenResponseDto } from '@/services/api'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { addresses } from '@/contracts/addresses'
import { arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import { isMhUsdcUnknown, isMhUsdcInsufficient } from '@/lib/tradeGate'
import { resolveTokenIdentifier, sanitizePrefillAmount } from '@/lib/prefill'
import MButton from '@/components/ui/MButton.vue'
import { muHavenTokenAbi } from '@/contracts/abis'
import {
  CheckCircle2, Lock, ShieldCheck, EyeOff, TrendingUp, ChevronDown, ArrowRight,
  Loader2, Copy, Check, RefreshCw, AlertTriangle, ShoppingCart, Undo2,
  Eye, Inbox, Zap,
} from 'lucide-vue-next'

// TradePage — Wave 3.5 atomic buy + instant-redeem against
// `MuHavenSubscription`. Mode is a top-level toggle; the form, status rail,
// and success card all swap shape per mode while reusing the same shell.
//
// On the redeem leg, the contract silently escalates to `RedemptionQueue`
// when `shares * NAV > instantCapRemaining` — pre-flight UX warns about
// the escalation before the investor signs, and the post-tx receipt parse
// surfaces the actual outcome (instant vs queued) to the success card.

type Mode = 'buy' | 'sell'

const route = useRoute()
const router = useRouter()
const marketplace = useMarketplaceStore()
const portfolio = usePortfolioStore()
const { address, connected } = useWallet()
const fhe = useFhe()
const { encryptUint128, getEphemeralEOA, decryptUint128ForView, initialize: initFhe } = fhe

const isXl = useMediaQuery('(min-width: 1280px)')

// ── Mode + form state ──────────────────────────────────────────────────

const mode = ref<Mode>('buy')
const selectedToken = ref<string>('')
const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const settledAs = ref<'instant' | 'queued' | null>(null)
const queuedRequestId = ref<bigint | null>(null)
const errMsg = ref<string | null>(null)

// Path C deep-link state surfaced to the template:
//  - `prefillTokenMissError`: set when `?token=X` was provided but X
//    didn't resolve. Renders an inline AlertTriangle banner so the
//    user knows the LLM's proposed token wasn't recognised — NEVER
//    silently snap to `filtered[0]` (Frontend review H-1: silent
//    fallback was actively swapping mismatched proposals to the
//    user's most-traded token).
//  - `marketplaceLoadFailed`: set when marketplace.load() throws.
//    Renders a Retry CTA instead of the half-rendered page state.
const prefillTokenMissError = ref<string | null>(null)
const marketplaceLoadFailed = ref<boolean>(false)

// `?mode=sell` deep-links straight into Sell. Token comes from `?token=`.
function readQueryMode(): Mode {
  return (route.query.mode as string) === 'sell' ? 'sell' : 'buy'
}

// Steps shown only while a tx is in flight (inline above the CTA).
// "Enter Amount" intentionally dropped — by the time the rail is
// visible the user has already entered the amount. Two real steps
// remain per mode: Encrypt (client-side FHE) → Purchase / Redeem
// (the on-chain Subscription call).
const buySteps = [
  { label: 'Encrypt', description: 'Encrypting your buy amount client-side…' },
  { label: 'Purchase', description: 'Submitting atomic purchase to the chain…' },
]
const sellSteps = [
  { label: 'Encrypt', description: 'Encrypting your redeem amount client-side…' },
  { label: 'Redeem', description: 'Submitting redemption (instant or queued)…' },
]
const steps = computed(() => mode.value === 'buy' ? buySteps : sellSteps)

const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

const selectedTokenData = computed<TokenResponseDto | undefined>(() =>
  selectedToken.value ? marketplace.getByAddress(selectedToken.value) : undefined,
)

// Wave 5 zero-burn: tokens in `winding_down` / `paused` / `archived`
// keep their balances on-chain (existing holders can still sell) but
// new buys are gated off — the Buy CTA disables and a deprecation
// banner explains why. Drives both `ctaDisabled` and the banner v-if.
const tokenIsRetired = computed(
  () => selectedTokenData.value?.status !== undefined
    && selectedTokenData.value.status !== 'active',
)
const retirementLabel = computed(() => {
  const s = selectedTokenData.value?.status
  if (s === 'winding_down') return 'Winding down'
  if (s === 'paused') return 'Paused'
  if (s === 'archived') return 'Archived'
  return ''
})

// `maxSharesHint` defaults to 10% above the requested amount per FLOWS.md
// suggestion. Silent-fail protects against over-purchase / over-redeem
// anyway — the hint is about cap accounting, not the actual cap.
const HINT_HEADROOM = 1.1

const navDollars = computed<number>(() => {
  if (nav.value !== null) return Number(nav.value) / 1e6
  const latest = selectedTokenData.value?.latest_nav
  return latest ? parseFloat(latest.nav) : 1
})

const positionUsd = computed(() => numericAmount.value * navDollars.value)

const estimatedYield = computed(() => {
  const apy = selectedTokenData.value?.apy ? parseFloat(selectedTokenData.value.apy) : 4.8
  return (positionUsd.value * apy / 100 / 12).toFixed(2)
})

// ── NAV + freshness readout ─────────────────────────────────────────────

const nav = ref<bigint | null>(null)
const navUpdatedAt = ref<bigint | null>(null)
const isFresh = ref<boolean>(false)
const navLoading = ref(false)

async function refreshNav() {
  if (!selectedToken.value) return
  if (isZeroAddress(v35Addresses.oracle)) return
  navLoading.value = true
  try {
    const ctx = buildReadContext()
    const oracle = new OracleClient(ctx, v35Addresses.oracle)
    const token = selectedToken.value as `0x${string}`
    const [{ nav: navVal, updatedAt }, fresh] = await Promise.all([
      oracle.getNAV(token),
      oracle.isFresh(token),
    ])
    nav.value = navVal
    navUpdatedAt.value = updatedAt
    isFresh.value = fresh
  } catch (e) {
    console.warn('[TradePage] oracle read failed:', e)
  } finally {
    navLoading.value = false
  }
}

// ── KYC gate ────────────────────────────────────────────────────────────

const isVerified = ref<boolean | null>(null)
const devModeActive = ref<boolean | null>(null)

async function refreshKyc() {
  if (!address.value) return
  if (isZeroAddress(v35Addresses.identityRegistry)) return
  try {
    const identity = new IdentityRegistryClient(buildReadContext(), v35Addresses.identityRegistry)
    const [v, dev] = await Promise.all([
      identity.isVerified(address.value as `0x${string}`),
      identity.devMode(),
    ])
    isVerified.value = v
    devModeActive.value = dev
  } catch (e) {
    console.warn('[TradePage] KYC read failed:', e)
  }
}

watch(connected, (val) => { if (val) refreshKyc() })

// ── Sell-mode reads: holding balance + instant cap remaining ───────────

const holdingBalance = ref<bigint | null>(null)
const holdingDecrypting = ref(false)
const instantCapRemaining = ref<bigint | null>(null)
const capLoading = ref(false)

async function refreshHolding() {
  // Reset the decrypted readout — the user opts back in via Reveal so we
  // don't leak a stale plaintext from one token onto another's card.
  holdingBalance.value = null
}

async function decryptHoldingBalance() {
  if (!selectedToken.value || !address.value || holdingDecrypting.value) return
  holdingDecrypting.value = true
  try {
    const handle = (await getPublicClient().readContract({
      address: selectedToken.value as Address,
      abi: muHavenTokenAbi,
      functionName: 'encryptedBalanceOf',
      args: [address.value as Address],
    })) as `0x${string}`
    // Pass the per-RWA-token address so the 403-refresh fallback in
    // `decryptForView` dispatches `refreshDecryptGrant` against the
    // CORRECT contract (TBILL1 / GOLD1 / …). Without this, the fallback
    // defaults to the legacy Wave 3 `MuHavenToken` (which the holding
    // doesn't live on); the refresh tx is a no-op against the actual
    // handle, and the retried decrypt 403s a second time. Symptom:
    // first-time Reveal on /trade Sell with no prior /portfolio visit
    // throws the 403 + a `MuHavenToken.refreshDecryptGrant()` revert.
    holdingBalance.value = await decryptUint128ForView(
      handle,
      selectedToken.value as `0x${string}`,
    )
  } catch (e) {
    toast.error('Reveal balance failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    holdingDecrypting.value = false
  }
}

async function refreshInstantCap() {
  if (!selectedToken.value) {
    instantCapRemaining.value = null
    return
  }
  if (isZeroAddress(v35Addresses.subscription)) return
  capLoading.value = true
  try {
    const sub = new SubscriptionClient(buildReadContext(), v35Addresses.subscription)
    instantCapRemaining.value = await sub.getInstantCapRemaining(selectedToken.value as Address)
  } catch (e) {
    console.warn('[TradePage] instant cap read failed:', e)
    instantCapRemaining.value = null
  } finally {
    capLoading.value = false
  }
}

// `cost = shares * nav` in PUSDC base units. Cap is in PUSDC base units
// too. `nav` is also in PUSDC base units per share, so cost is exactly
// `shares * nav` — no decimal scaling. (See MuHavenSubscription.sol:48-56
// for the matching on-chain math.)
const estimatedCostPusdc = computed<bigint | null>(() => {
  if (numericAmount.value <= 0 || nav.value === null) return null
  const shares = BigInt(Math.floor(numericAmount.value))
  return shares * nav.value
})

const willEscalate = computed<boolean>(() => {
  if (mode.value !== 'sell') return false
  if (instantCapRemaining.value === null || estimatedCostPusdc.value === null) return false
  return estimatedCostPusdc.value > instantCapRemaining.value
})

const exceedsHolding = computed<boolean>(() => {
  if (mode.value !== 'sell' || holdingBalance.value === null) return false
  const shares = BigInt(Math.floor(numericAmount.value || 0))
  return shares > holdingBalance.value
})

// ── Phase 7.5 — mhUSDC pre-flight (buy mode) ───────────────────────────
//
// Buy flow pulls mhUSDC from the investor via Subscription's silent-fail
// pull. If balance < cost, the contract zeros out — investor pays gas
// for nothing. We surface a pre-flight warning + inline "Wrap PUSDC
// first" CTA so the failure mode lands as UI instead of an empty tx.

// Phase 9.A: mhUSDC decrypted balance is shared cross-page state via the
// portfolio store (`pusdcConfidentialBalance` + `decryptPusdc()`). Same
// FHE flow under the hood (initFhe → MuHavenStable.confidentialBalanceOf
// → decryptMhUsdcForView with legacy-PUSDC fallback) — reading from the
// store means the glance-bar value, the CashPage tile, and the Portfolio
// Cash Buffer card all stay in sync after a wrap or trade.

/** Reveal mhUSDC via the portfolio store. Thin wrapper for template binding. */
async function decryptMhUsdcBalance() {
  if (!address.value) return
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

/**
 * Auto-refresh after a successful buy/sell. Called from both
 * handlePurchase + handleRedeem success paths so /portfolio and any
 * mhUSDC surface (CashPage tile, glance bar, Portfolio Cash Buffer)
 * see the post-trade truth without a manual refresh click.
 *
 * - portfolio.load(addr): refresh holdings + USDC + plaintext PUSDC.
 * - portfolio.decryptPusdc(addr): re-decrypt mhUSDC iff the user has
 *   already revealed it. Locked balances stay locked — no surprise
 *   session signature on a value the user never asked to see.
 *
 * Fire-and-forget: failures here mustn't block the success card or
 * mask the trade success itself. We still log via console.warn.
 */
async function refreshAfterTrade() {
  if (!address.value) return
  const addr = address.value as `0x${string}`
  const wasRevealed = portfolio.pusdcConfidentialBalance !== null
  try {
    await portfolio.load(addr)
  } catch (e) {
    console.warn('[TradePage] portfolio.load post-trade failed', e)
  }
  if (wasRevealed) {
    try {
      await portfolio.decryptPusdc(addr)
    } catch (e) {
      console.warn('[TradePage] mhUSDC re-decrypt post-trade failed', e)
    }
  }
}

// Buy affordability gate (pure logic in `@/lib/tradeGate`). Two states matter
// in buy mode:
//   - `mhUsdcUnknown`: balance still encrypted (null) + a cost typed → we
//     CANNOT know affordability without the owner's own permit-decrypt (FHE
//     law — an on-chain reject is impossible; see tradeGate.ts). Block the CTA
//     and prompt a Reveal first. This also prevents the phantom-row foot-gun:
//     an under-funded buy is never submitted, so no zero-share `Purchased`.
//   - `insufficientMhUsdc`: balance revealed + < cost → block (the tx would
//     silent-fail via `FHE.select` and burn gas for 0 shares).
const insufficientMhUsdc = computed<boolean>(() =>
  isMhUsdcInsufficient({
    mode: mode.value,
    mhUsdcBalance: portfolio.pusdcConfidentialBalance,
    estimatedCost: estimatedCostPusdc.value,
  }),
)

const mhUsdcUnknown = computed<boolean>(() =>
  isMhUsdcUnknown({
    mode: mode.value,
    mhUsdcBalance: portfolio.pusdcConfidentialBalance,
    estimatedCost: estimatedCostPusdc.value,
  }),
)

watch(selectedToken, () => {
  refreshNav()
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

watch(mode, (m) => {
  // Switching mode resets in-flight error/success and refetches sell-only
  // reads. Form values stay so the user can flip without retyping.
  errMsg.value = null
  showSuccess.value = false
  settledAs.value = null
  queuedRequestId.value = null
  currentStep.value = 0
  if (m === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

// ── Operator approval (mhUSDC → Subscription) ──────────────────────────
//
// Subscription.purchase pulls mhUSDC from the kernel via
// `MuHavenStable.transferFrom(investor, treasury, amount, ...)`. The
// stable wrapper rejects with `NotOperator()` (selector 0x7c214f04)
// unless the investor has previously granted operator status to the
// Subscription address. Mirrors CashPage's `LegacyPusdcService.setOperator`
// pattern: long expiry, granted once per (kernel, subscription) pair.
//
// `null` = unknown (not yet read), `false` = read + missing (will grant
// before purchase), `true` = read + granted.
const subOperatorSet = ref<boolean | null>(null)
const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60

async function refreshSubOperatorStatus(): Promise<void> {
  if (!address.value || isZeroAddress(v35Addresses.subscription)) {
    subOperatorSet.value = null
    return
  }
  try {
    subOperatorSet.value = await MuHavenStableService.isOperator(
      address.value as `0x${string}`,
      v35Addresses.subscription,
    )
  } catch (e) {
    console.warn('[TradePage] mhUSDC operator status read failed', e)
    subOperatorSet.value = null
  }
}

// ── Wallet aside ────────────────────────────────────────────────────────

const copied = ref(false)
const balancesLoading = ref(false)
const usdcBalance = ref<bigint | null>(null)

async function loadBalances() {
  if (!address.value) return
  balancesLoading.value = true
  try {
    usdcBalance.value = await Erc20Service.balanceOf(
      addresses.usdc, address.value as `0x${string}`,
    )
  } catch {
    usdcBalance.value = null
  } finally {
    balancesLoading.value = false
  }
}

async function copyAddress() {
  if (!address.value) return
  await navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

watch(connected, (val) => {
  if (val) {
    loadBalances()
    refreshSubOperatorStatus()
  }
})

onMounted(async () => {
  if (connected.value) {
    loadBalances()
    refreshKyc()
    refreshSubOperatorStatus()
  }
  // Surface marketplace.load() failures (Frontend H-2). Without this
  // try/catch, a backend hiccup leaves the page half-rendered with no
  // error state and no retry path — the user sees a blank token picker
  // and thinks the deep-link broke.
  if (!marketplace.loaded) {
    try {
      await marketplace.load()
    } catch (err) {
      console.warn('[TradePage] marketplace.load failed:', err)
      marketplaceLoadFailed.value = true
      // Continue — we can still render the mode toggle + an error banner.
    }
  }

  mode.value = readQueryMode()

  // Token can be either a 0x-address OR a symbol (e.g. "TBILL1") so MCP
  // deep-links from `@muhaven/mcp position.buy({ token: 'TBILL1' })` can
  // pre-fill without forcing the LLM to look up the contract address
  // first. Symbol match is case-insensitive (operator may type lowercase).
  // Frontend H-1 fix: when the query token doesn't resolve, render an
  // inline banner ("Couldn't find token X — pick one below") and DO NOT
  // snap selectedToken to filtered[0]. The previous silent fallback was
  // actively swapping mismatched LLM proposals (LLM says "GOLD1", user's
  // most-traded TBILL1 silently fills in) → user taps Buy on wrong asset.
  const queryToken = route.query.token as string | undefined
  const matched = resolveTokenIdentifier(queryToken, marketplace.tokens)
  if (queryToken && !matched) {
    prefillTokenMissError.value = queryToken.trim().slice(0, 32)
    // Leave selectedToken empty — user must explicitly pick from the
    // dropdown. The banner makes the failure mode visible.
  } else if (matched) {
    selectedToken.value = matched.address
  } else if (marketplace.filtered.length > 0) {
    // No queryToken AND we have a list — default to first as before.
    // This path is the "direct nav to /trade" UX, NOT the deep-link path.
    selectedToken.value = marketplace.filtered[0].address
  }

  // Amount pre-fill via the shared sanitizer:
  //  - sell mode: integer-only (fhERC-20 shares have no decimals;
  //    fractional input would silently floor on the on-chain submit).
  //  - buy mode: decimal allowed up to 6 dp (matches mhUSDC base-unit
  //    floor; longer fractional parts are rejected so the est-cost
  //    preview can't diverge from the actual on-chain submit).
  // Path C contract: silent reject is better than surfacing an
  // incorrect pre-fill the user might tap through.
  if (mode.value === 'sell') {
    const cleaned = sanitizePrefillAmount(route.query.shares as string | undefined, {
      allowDecimals: false,
    })
    if (cleaned !== null) amount.value = cleaned
  } else {
    const cleaned = sanitizePrefillAmount(route.query.amount as string | undefined, {
      allowDecimals: true,
      maxDp: 6,
    })
    if (cleaned !== null) amount.value = cleaned
  }

  // Trigger sell-mode reads if we deep-linked into ?mode=sell
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
})

async function retryMarketplaceLoad(): Promise<void> {
  marketplaceLoadFailed.value = false
  try {
    await marketplace.load()
    // On success, re-attempt the deep-link token resolution if there was
    // a pending one — keeps the post-retry UX consistent with onMounted.
    if (!selectedToken.value && !prefillTokenMissError.value && marketplace.filtered.length > 0) {
      selectedToken.value = marketplace.filtered[0].address
    }
  } catch (err) {
    console.warn('[TradePage] marketplace.load retry failed:', err)
    marketplaceLoadFailed.value = true
  }
}

// ── Mode switcher (URL sync) ────────────────────────────────────────────

function setMode(next: Mode) {
  if (mode.value === next) return
  mode.value = next
  router.replace({
    query: { ...route.query, mode: next === 'buy' ? undefined : 'sell' },
  })
}

function goCash() {
  router.push('/cash')
}

// ── Submit handler ──────────────────────────────────────────────────────

async function handleSubmit() {
  if (mode.value === 'buy') return handlePurchase()
  return handleRedeem()
}

async function handlePurchase() {
  if (!amount.value || isProcessing.value || !address.value || !selectedToken.value) return
  // Defense-in-depth: the disabled CTA is the primary affordability gate, but
  // re-assert it here so any future programmatic caller can't tap through to a
  // buy that's unknown (balance still encrypted) or known-underfunded — both
  // would silent-fail on-chain (0 shares) and burn gas for nothing. No funds
  // or privacy are at risk either way (FHE.select backstop), but this keeps
  // the foot-gun closed if a second entry path is ever added.
  if (mhUsdcUnknown.value || insufficientMhUsdc.value) return
  if (isZeroAddress(v35Addresses.subscription)) {
    errMsg.value =
      'Subscription contract not configured for this build. '
      + 'Set VITE_SUBSCRIPTION_ADDRESS in your env.'
    return
  }

  isProcessing.value = true
  errMsg.value = null

  try {
    currentStep.value = 0

    // Pre-flight: ensure Subscription is an operator on the investor's
    // mhUSDC. Without this, the wrapper's `transferFrom(investor, treasury)`
    // call inside `Subscription.purchase` reverts `NotOperator()` (selector
    // 0x7c214f04). Grant once per (kernel, subscription) with a long
    // expiry — subsequent purchases skip this entirely. Mirrors the
    // PUSDC.setOperator step in CashPage.handleCashWrap.
    if (subOperatorSet.value !== true) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
      await MuHavenStableService.setOperator(v35Addresses.subscription, expiry)
      subOperatorSet.value = true
      toast.info('mhUSDC approved', {
        description: 'Subscription contract can now pull your mhUSDC',
      })
    }

    // Shares are raw integer units per Wave 3.5 contract convention:
    // `FHE.mul(shares, nav)` produces PUSDC base units (6-decimal). See
    // MuHavenSubscription.sol L48-56 + ADR-031 cleartext guard.
    const shares = BigInt(Math.floor(numericAmount.value))
    const maxSharesHint = BigInt(Math.ceil(numericAmount.value * HINT_HEADROOM))

    const ctx = await buildWriteContext()
    const sub = new SubscriptionClient(ctx, v35Addresses.subscription)
    const ephemeralEOA = getEphemeralEOA()

    // Step 1 = Purchase. The encrypt step (0) finished above when the SDK
    // built the encrypted inputs inside sub.purchase()'s prep phase; we
    // bump on the onProgress 'purchase' stage so the rail reflects the
    // chain submission moment.
    const hash = await sub.purchase(
      selectedToken.value as `0x${string}`,
      shares,
      maxSharesHint,
      ephemeralEOA,
      {
        onProgress: (e) => {
          if (e.stage === 'purchase') currentStep.value = 1
        },
      },
    )

    txHash.value = hash
    showSuccess.value = true
    toast.success('Purchase confirmed', {
      description: 'Atomic subscription purchase — mhUSDC pulled + shares minted',
    })

    if (selectedTokenData.value) {
      // MUST be awaited before `refreshAfterTrade()` below — the backend
      // persists the new position via this POST, and `refreshAfterTrade`
      // immediately re-reads `GET /portfolio`. Fire-and-forget loses the
      // race on a fast network, so /portfolio shows the pre-trade list
      // until the user manually refreshes (which re-mounts Pinia and
      // re-fetches by which time the POST has long since landed). Errors
      // are still swallowed — a failed addPosition mustn't mask the
      // on-chain success card.
      try {
        await portfolioApi.addPosition(
          selectedTokenData.value.address,
          selectedTokenData.value.symbol,
        )
      } catch (e) {
        console.warn('[TradePage] addPosition post-trade failed', e)
      }
    }

    // Auto-refresh holdings + mhUSDC (iff revealed) so /portfolio
    // and the glance-bar show post-trade truth without a manual
    // refresh. Awaited so the freshness lands while the success
    // card is still on screen — not blocking, just queued.
    await refreshAfterTrade()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Purchase failed'
    toast.error('Purchase failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

async function handleRedeem() {
  if (!amount.value || isProcessing.value || !address.value || !selectedToken.value) return
  if (isZeroAddress(v35Addresses.subscription)) {
    errMsg.value =
      'Subscription contract not configured for this build. '
      + 'Set VITE_SUBSCRIPTION_ADDRESS in your env.'
    return
  }

  isProcessing.value = true
  errMsg.value = null
  settledAs.value = null
  queuedRequestId.value = null

  try {
    currentStep.value = 0

    const shares = BigInt(Math.floor(numericAmount.value))
    const maxSharesHint = BigInt(Math.ceil(numericAmount.value * HINT_HEADROOM))

    const ctx = await buildWriteContext()
    const sub = new SubscriptionClient(ctx, v35Addresses.subscription)
    const ephemeralEOA = getEphemeralEOA()

    // Step 1 = Redeem. The encrypt step (0) finished when the SDK built
    // the encrypted inputs inside sub.redeem()'s prep phase; we bump on
    // the onProgress 'redeemInstant' stage to mark the chain submission.
    const hash = await sub.redeem(
      selectedToken.value as `0x${string}`,
      shares,
      maxSharesHint,
      ephemeralEOA,
      {
        onProgress: (e) => {
          if (e.stage === 'redeemInstant') currentStep.value = 1
        },
      },
    )

    txHash.value = hash

    // Parse the receipt to determine instant vs escalated. The contract
    // emits `Redeemed(escalated)` always, plus `EscalatedToQueue(...,
    // requestId)` on the escalate branch. Pre-flight UX shows "will
    // escalate" already; this confirms what actually happened.
    try {
      const receipt = await getPublicClient().getTransactionReceipt({ hash })
      const escalateLog = receipt.logs.find((log) => {
        try {
          const parsed = decodeEventLog({
            abi: muhavenSubscriptionAbi,
            data: log.data,
            topics: log.topics,
            strict: false,
          })
          return parsed.eventName === 'EscalatedToQueue'
        } catch {
          return false
        }
      })
      if (escalateLog) {
        const parsed = decodeEventLog({
          abi: muhavenSubscriptionAbi,
          data: escalateLog.data,
          topics: escalateLog.topics,
        }) as { eventName: 'EscalatedToQueue'; args: { requestId: bigint } }
        settledAs.value = 'queued'
        queuedRequestId.value = parsed.args.requestId
      } else {
        settledAs.value = 'instant'
      }
    } catch {
      // If receipt parsing fails we still got a confirmed tx hash; fall
      // back to whatever pre-flight predicted, defaulting to instant.
      settledAs.value = willEscalate.value ? 'queued' : 'instant'
    }

    showSuccess.value = true
    if (settledAs.value === 'queued') {
      toast.info('Redemption queued', {
        description: 'Cap was full this epoch — your shares are in the queue, claim when settled',
      })
    } else {
      toast.success('Redemption confirmed', {
        description: 'Shares burned + mhUSDC paid out atomically',
      })
    }

    // Auto-refresh holdings + mhUSDC (iff revealed) — same call as
    // the buy path. For queued redemptions the shares + PUSDC haven't
    // moved yet (RedemptionQueue holds them until epoch processing),
    // but the call is idempotent and keeps the post-trade contract
    // consistent across both legs.
    await refreshAfterTrade()
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Redeem failed'
    toast.error('Redeem failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

function resetForm() {
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
  settledAs.value = null
  queuedRequestId.value = null
  if (mode.value === 'sell') {
    refreshHolding()
    refreshInstantCap()
  }
}

// Pre-fill helpers for Sell mode — render only when the holding is
// decrypted so we know the upper bound is real.
function fillHalf() {
  if (holdingBalance.value === null || holdingBalance.value === 0n) return
  amount.value = (holdingBalance.value / 2n).toString()
}

function fillMax() {
  if (holdingBalance.value === null || holdingBalance.value === 0n) return
  amount.value = holdingBalance.value.toString()
}

// CTA copy + states swap by mode. Dynamic ticker grounds the action in
// the asset the user just picked and matches every trading UI they've
// seen elsewhere ("Buy TBILL1" reads cleaner than "Encrypt & Purchase").
// Privacy framing moves to the FHE microcopy line below the CTA + the
// inline step rail's "Encrypt" step (added in the aside redesign).
const ctaLabel = computed(() => {
  const sym = selectedTokenData.value?.symbol ?? 'shares'
  if (isProcessing.value) {
    if (mode.value === 'buy') return `Purchasing ${sym}…`
    return willEscalate.value ? 'Queueing redemption…' : `Selling ${sym}…`
  }
  if (mode.value === 'buy') return `Buy ${sym}`
  return willEscalate.value ? `Sell ${sym} (queued)` : `Sell ${sym}`
})

const ctaDisabled = computed(() => {
  if (isProcessing.value) return true
  if (!amount.value.trim() || numericAmount.value <= 0) return true
  if (isVerified.value === false && devModeActive.value !== true) return true
  if (mode.value === 'sell' && exceedsHolding.value) return true
  // Buy mode: block the silent-fail click path. Two cases:
  //  • `mhUsdcUnknown` — balance still encrypted + a cost typed. We can't
  //    know affordability without the owner's own permit-decrypt (an
  //    on-chain reject is impossible by FHE law). Block + prompt a Reveal
  //    via the in-form reveal gate below the CTA. Without this, the Buy
  //    button was live against an unknown balance: an under-funded buy
  //    silent-failed on-chain (0 shares) but still emitted a phantom row.
  //  • `insufficientMhUsdc` — balance revealed and below the typed cost; the
  //    contract would zero-out the pull and burn gas for nothing. The
  //    glance bar shows the "short $Z" warning + a loud Top-up-cash CTA.
  if (mode.value === 'buy' && (mhUsdcUnknown.value || insufficientMhUsdc.value)) return true
  // Wave 5 zero-burn: retired tokens (winding_down / paused / archived)
  // cannot be bought; existing holders can still sell on-chain. The
  // deprecation banner above the form explains the gate so users
  // aren't left wondering why the CTA is dead.
  if (mode.value === 'buy' && tokenIsRetired.value) return true
  return false
})

// Single prominence rule for the right-aside cash link. Both buy-block
// states resolve to the same destination, so we collapse them under
// one boolean and let the link carry the visual emphasis only when a
// buy is actually blocked on cash.
const cashLinkLoud = computed(() =>
  mode.value === 'buy'
  && (usdcBalance.value === 0n || insufficientMhUsdc.value),
)

// Reason the Buy CTA is disabled, surfaced to assistive tech via
// `aria-describedby`. A disabled <button> isn't focusable so an SR user
// can't land on it directly — but the reveal gate (when mhUsdcUnknown) holds
// its own focusable Reveal button + a `role="status"` announcement, so the
// reason is reachable either way. Retired takes precedence (reveal won't
// help a retired token); the reveal gate is the next reason.
const ctaDescribedBy = computed<string | undefined>(() => {
  if (mode.value !== 'buy') return undefined
  if (tokenIsRetired.value) return 'trade-retired-banner'
  if (mhUsdcUnknown.value) return 'trade-mhusdc-reveal-gate'
  return undefined
})
</script>

<template>
  <div>
    <div class="xl:mr-80">
      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520 } }"
        class="relative max-w-2xl mx-auto rounded-2xl overflow-hidden border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div
          aria-hidden="true"
          class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent"
        />
        <div
          aria-hidden="true"
          class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none"
          :class="mode === 'buy' ? 'bg-gold/8 dark:bg-signal/8' : 'bg-compute/8 dark:bg-signal/6'"
        />

        <div class="p-8 md:p-10 relative">
          <!-- Path C deep-link error states. Both banners render BEFORE
               the form so the user sees the failure mode before any
               pre-fill state. Closes Frontend H-1 (silent token swap)
               and H-2 (silent half-rendered marketplace.load failure). -->
          <div
            v-if="marketplaceLoadFailed"
            data-testid="trade-marketplace-load-failed"
            role="alert"
            class="flex items-start gap-3 px-4 py-3 mb-6 rounded-xl
                   bg-negative/10 border border-negative/25"
          >
            <AlertTriangle :size="16" :stroke-width="1.8" class="text-negative flex-shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <p class="font-sans text-sm font-semibold text-negative">
                Couldn't load the token catalog.
              </p>
              <p class="font-sans text-xs text-cool mt-1 mb-2">
                A network blip or backend hiccup blocked the load. Retry to populate the token picker.
              </p>
              <button
                type="button"
                @click="retryMarketplaceLoad"
                data-testid="trade-marketplace-retry"
                class="font-sans text-xs font-semibold uppercase tracking-[0.18em]
                       text-compute dark:text-signal hover:underline cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>

          <div
            v-if="prefillTokenMissError"
            data-testid="trade-prefill-token-miss"
            role="alert"
            class="flex items-start gap-3 px-4 py-3 mb-6 rounded-xl
                   bg-gold/8 dark:bg-signal/8 border border-gold/25 dark:border-signal/25"
          >
            <AlertTriangle :size="16" :stroke-width="1.8" class="text-compute dark:text-signal flex-shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                Couldn't find token <span class="font-mono">{{ prefillTokenMissError }}</span> in your catalog.
              </p>
              <p class="font-sans text-xs text-cool mt-1">
                The link from your assistant referenced a token we don't recognise. Pick one from the dropdown below — no token has been pre-selected.
              </p>
            </div>
          </div>

          <!-- Wave 5 zero-burn: surfaces when the selected token has been
               retired (TBILL1/GOLD1 → winding_down). Existing holders
               keep their balances and can still sell; the Buy CTA is
               separately disabled by `ctaDisabled` so this banner just
               explains why. Lives ABOVE the mode toggle so the user sees
               the retirement context before deciding buy vs sell. -->
          <div
            v-if="tokenIsRetired && !showSuccess && !errMsg"
            id="trade-retired-banner"
            data-testid="trade-token-retired"
            role="status"
            class="flex items-start gap-3 px-4 py-3 mb-6 rounded-xl
                   bg-gold/8 dark:bg-signal/8 border border-gold/25 dark:border-signal/25"
          >
            <AlertTriangle :size="16" :stroke-width="1.8" aria-hidden="true" class="text-gold dark:text-signal flex-shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <p class="font-sans text-sm font-semibold text-midnight dark:text-white">
                {{ selectedTokenData?.symbol ?? 'This token' }} is {{ retirementLabel.toLowerCase() }}.
              </p>
              <!-- Mode-agnostic: in buy mode the disabled CTA above
                   does the work; in sell mode the user just reads
                   "you can still sell" as a confirmation. -->
              <p class="font-sans text-xs text-cool mt-1">
                New purchases are disabled. Existing holders can still sell their position.
              </p>
            </div>
          </div>

          <!-- Mode toggle — segmented pill, hidden on success/error so
               the resolved card stays the focal point -->
          <div
            v-if="!showSuccess && !errMsg"
            data-testid="trade-mode-toggle"
            class="relative inline-flex items-center gap-1 mb-8
                   rounded-full border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#1c1b1b]/80 p-1
                   shadow-[inset_0_1px_2px_rgba(63,46,12,0.04)]
                   dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          >
            <!-- Active pill (slides between segments via transform). -->
            <div
              aria-hidden="true"
              class="absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full
                     bg-gradient-to-r transition-all duration-300 ease-out
                     shadow-[0_2px_10px_-2px_rgba(255,186,32,0.45)]
                     dark:shadow-[0_2px_14px_-2px_rgba(255,220,161,0.35)]"
              :class="[
                mode === 'buy'
                  ? 'left-1 from-gold to-gold/90 dark:from-signal dark:to-signal/85'
                  : 'left-[calc(50%+0.05rem)] from-compute to-gold dark:from-signal dark:to-signal/70',
              ]"
            />
            <button
              type="button"
              @click="setMode('buy')"
              :disabled="isProcessing"
              data-testid="trade-mode-buy"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[110px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'buy'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <ShoppingCart :size="13" :stroke-width="2" />
              Buy
            </button>
            <button
              type="button"
              @click="setMode('sell')"
              :disabled="isProcessing"
              data-testid="trade-mode-sell"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[110px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'sell'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Undo2 :size="13" :stroke-width="2" />
              Sell
            </button>
          </div>

          <!-- ── Success states ─────────────────────────────────────── -->
          <div
            v-if="showSuccess && mode === 'buy'"
            data-testid="buy-success-card"
            class="flex flex-col items-center gap-5 py-6"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Purchase confirmed
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                mhUSDC was pulled and shares minted atomically — the exact amount was never in cleartext on-chain.
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">Make another purchase</MButton>
          </div>

          <!-- Sell — instant -->
          <div
            v-else-if="showSuccess && mode === 'sell' && settledAs === 'instant'"
            data-testid="redeem-instant-success-card"
            class="flex flex-col items-center gap-5 py-6"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <Zap :size="30" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Redemption confirmed
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                Shares burned and mhUSDC paid out in a single tx — your new balance is encrypted to this session.
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">Redeem more</MButton>
          </div>

          <!-- Sell — queued -->
          <div
            v-else-if="showSuccess && mode === 'sell' && settledAs === 'queued'"
            data-testid="redeem-queued-success-card"
            class="flex flex-col items-center gap-5 py-6"
          >
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-gold/15 border border-gold/30 dark:bg-signal/15 dark:border-signal/30 flex items-center justify-center"
            >
              <Inbox :size="30" :stroke-width="1.8" class="text-gold dark:text-signal" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Added to redemption queue
              </p>
              <p class="font-sans text-sm text-cool max-w-md">
                Instant cap was already used this epoch — your shares moved to the queue and will settle next round.
              </p>
              <p v-if="queuedRequestId !== null" class="font-mono text-[11px] text-cool pt-2">
                request id:
                <span class="text-midnight dark:text-white tabular-nums">#{{ queuedRequestId.toString() }}</span>
              </p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a
                :href="arbiscanTx(txHash)"
                target="_blank"
                rel="noopener"
                class="text-compute dark:text-signal hover:underline"
              >
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <div class="flex gap-3">
              <MButton variant="outline" @click="resetForm">Redeem more</MButton>
              <MButton @click="router.push('/redemptions')">Track in Redemptions</MButton>
            </div>
          </div>

          <!-- Error state -->
          <div
            v-else-if="errMsg"
            :data-testid="mode === 'buy' ? 'buy-error-card' : 'redeem-error-card'"
            class="flex flex-col items-center gap-5 py-8"
          >
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">
              Something went wrong
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <!-- Form -->
          <div v-else class="flex flex-col gap-8">
            <!-- KYC status row -->
            <div
              v-if="isVerified === false && devModeActive !== true"
              class="rounded-lg p-4 border border-negative/30 bg-negative/5 flex items-start gap-3"
              :data-testid="mode === 'buy' ? 'buy-kyc-blocked' : 'redeem-kyc-blocked'"
            >
              <AlertTriangle :size="18" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
              <div>
                <p class="font-sans text-sm font-semibold text-negative">KYC required</p>
                <p class="font-sans text-xs text-cool mt-0.5 leading-relaxed">
                  Your account is not whitelisted on the IdentityRegistry. Contact the issuer
                  to be added, or ask an admin to enable dev-mode for demo access.
                </p>
              </div>
            </div>

            <!-- Token selector -->
            <div v-if="marketplace.filtered.length > 0" class="flex flex-col gap-3">
              <label
                :for="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium"
              >
                {{ mode === 'buy' ? 'Select Asset' : 'Redeem From' }}
              </label>
              <div class="relative">
                <select
                  :id="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                  v-model="selectedToken"
                  :disabled="isProcessing"
                  :data-testid="mode === 'buy' ? 'buy-token-select' : 'sell-token-select'"
                  class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                         text-midnight dark:text-white font-sans text-sm md:text-base py-3 pl-1 pr-10
                         focus:outline-none focus:border-gold dark:focus:border-signal
                         transition-colors appearance-none cursor-pointer disabled:opacity-50"
                >
                  <option v-for="t in marketplace.filtered" :key="t.address" :value="t.address">
                    {{ t.name }} ({{ t.symbol }}) — {{ t.apy ? `${t.apy}% APY` : 'N/A' }}
                  </option>
                </select>
                <ChevronDown :size="16" :stroke-width="1.6" class="absolute right-2 top-1/2 -translate-y-1/2 text-cool pointer-events-none" />
              </div>

              <!-- NAV freshness banner -->
              <div
                v-if="nav !== null"
                class="flex items-center justify-between text-[11px] font-sans text-cool tabular-nums"
                :data-testid="mode === 'buy' ? 'buy-nav-readout' : 'sell-nav-readout'"
              >
                <span class="inline-flex items-center gap-1.5">
                  <span
                    :class="[
                      'w-1.5 h-1.5 rounded-full',
                      isFresh ? 'bg-positive' : 'bg-negative',
                    ]"
                  />
                  {{ isFresh ? 'NAV fresh' : 'NAV stale — ' + (mode === 'buy' ? 'purchase' : 'redeem') + ' will revert' }}
                </span>
                <span>
                  NAV: <span class="text-midnight dark:text-white">${{ (Number(nav) / 1e6).toFixed(4) }}</span>
                  <span v-if="navUpdatedAt" class="ml-2">
                    ({{ Math.max(0, Math.floor((Date.now() / 1000 - Number(navUpdatedAt)) / 60)) }}m ago)
                  </span>
                </span>
              </div>
            </div>

            <!-- ── Sell-only: holdings + cap readout ───────────── -->
            <div v-if="mode === 'sell' && selectedToken" class="flex flex-col gap-3">
              <div
                class="rounded-lg p-4 border border-haze dark:border-white/8
                       bg-mist/30 dark:bg-[#1c1b1b]/60 flex flex-col gap-3"
                data-testid="sell-holding-card"
              >
                <div class="flex items-center justify-between">
                  <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-medium">
                    Your holding
                  </span>
                  <button
                    v-if="holdingBalance === null"
                    type="button"
                    @click="decryptHoldingBalance"
                    :disabled="holdingDecrypting"
                    data-testid="sell-reveal-balance"
                    class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium
                           text-compute dark:text-signal hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-50"
                  >
                    <Loader2 v-if="holdingDecrypting" :size="11" class="animate-spin" />
                    <Eye v-else :size="11" />
                    Reveal
                  </button>
                </div>
                <div class="flex items-end justify-between gap-3">
                  <span
                    class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tabular-nums tracking-tight"
                    data-testid="sell-holding-readout"
                  >
                    <template v-if="holdingBalance !== null">
                      {{ holdingBalance.toString() }}
                    </template>
                    <template v-else>
                      <span class="text-cool/50 font-sans not-italic text-base">— shares (encrypted)</span>
                    </template>
                  </span>
                  <div v-if="holdingBalance !== null && holdingBalance > 0n" class="flex gap-2">
                    <button
                      type="button"
                      @click="fillHalf"
                      :disabled="isProcessing"
                      data-testid="sell-fill-half"
                      class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                             bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                             text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                             border border-haze dark:border-white/10
                             px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                    >
                      Half
                    </button>
                    <button
                      type="button"
                      @click="fillMax"
                      :disabled="isProcessing"
                      data-testid="sell-fill-max"
                      class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                             bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                             text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                             border border-haze dark:border-white/10
                             px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                    >
                      Max
                    </button>
                  </div>
                </div>
                <div class="flex items-center justify-between text-[11px] font-sans text-cool tabular-nums pt-1 border-t border-haze/60 dark:border-white/5">
                  <span class="inline-flex items-center gap-1.5">
                    <Zap :size="11" :stroke-width="2" class="text-cool" />
                    Instant cap left
                  </span>
                  <span data-testid="sell-instant-cap">
                    <template v-if="capLoading">
                      <Loader2 :size="10" class="animate-spin inline" />
                    </template>
                    <template v-else-if="instantCapRemaining !== null">
                      <span class="text-midnight dark:text-white">
                        {{ formatUSD(Number(instantCapRemaining) / 1e6) }}
                      </span>
                    </template>
                    <template v-else>—</template>
                  </span>
                </div>
              </div>

              <!-- Will-escalate amber banner -->
              <div
                v-if="willEscalate"
                data-testid="sell-escalate-warning"
                class="rounded-lg p-3.5 border border-gold/30 dark:border-signal/30
                       bg-gold/8 dark:bg-signal/8 flex items-start gap-3"
              >
                <Inbox :size="15" :stroke-width="1.8" class="text-gold dark:text-signal mt-0.5 flex-shrink-0" />
                <p class="font-sans text-[11px] text-cool leading-relaxed">
                  This redemption exceeds the instant cap. Subscription will silently escalate to the redemption queue —
                  you'll claim mhUSDC after the next epoch settles.
                </p>
              </div>

              <!-- Exceeds-holding revert warning -->
              <div
                v-if="exceedsHolding"
                data-testid="sell-exceeds-holding"
                class="rounded-lg p-3.5 border border-negative/30 bg-negative/5 flex items-start gap-3"
              >
                <AlertTriangle :size="15" :stroke-width="1.8" class="text-negative mt-0.5 flex-shrink-0" />
                <p class="font-sans text-[11px] text-cool leading-relaxed">
                  Amount exceeds your decrypted holding. The contract would silent-fail — bring the amount down.
                </p>
              </div>
            </div>

            <!-- Amount input -->
            <div class="flex flex-col gap-3">
              <label
                :for="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium"
              >
                {{ mode === 'buy' ? 'Shares (18 decimals)' : 'Shares to redeem' }}
              </label>
              <div
                class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2
                       transition-colors focus-within:border-gold dark:focus-within:border-signal"
              >
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">#</span>
                <input
                  :id="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Share amount"
                  :disabled="isProcessing"
                  :data-testid="mode === 'buy' ? 'buy-amount-input' : 'sell-amount-input'"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
                <!-- Buy: quick amounts. Sell: covered by Half/Max above. -->
                <div v-if="mode === 'buy'" class="flex gap-2">
                  <button
                    v-for="qa in quickAmounts"
                    :key="qa"
                    type="button"
                    @click="amount = qa"
                    :disabled="isProcessing"
                    :data-testid="`buy-quick-${qa}`"
                    class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                           bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                           text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                           border border-haze dark:border-white/10
                           px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                  >
                    {{ Number(qa).toLocaleString() }}
                  </button>
                </div>
                <span v-else aria-hidden="true" />

                <span
                  v-if="numericAmount > 0"
                  class="flex items-center gap-1.5 font-sans text-xs text-compute dark:text-signal tabular-nums"
                >
                  <TrendingUp :size="13" :stroke-width="1.8" />
                  <span class="text-cool">{{ mode === 'buy' ? 'Est. position:' : 'Est. payout:' }}</span>
                  <span class="font-medium">${{ positionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}</span>
                  <span v-if="mode === 'buy'" class="text-cool">· mo. yield ${{ estimatedYield }}</span>
                </span>
              </div>
              <p class="font-sans text-[10px] text-cool/80 leading-relaxed">
                Silent-fail bounded by <span class="font-mono">maxSharesHint = shares × {{ HINT_HEADROOM.toFixed(2) }}</span>.
                Over-commit is safe — the contract zeros out above the hint.
              </p>
            </div>

            <!-- Inline progress rail — visible only while a tx is in
                 flight. Two pill steps (Encrypt → Purchase / Redeem)
                 with active / done states. Mirrors the /cash pattern
                 (commit 0923d74); replaces the static "Current Step"
                 section that lived in the right-aside. -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="isProcessing"
                data-testid="trade-inline-rail"
                class="rounded-lg p-4 border border-gold/25 dark:border-signal/20
                       bg-gold/6 dark:bg-signal/5 flex flex-col gap-3"
              >
                <div class="flex items-center gap-3">
                  <div
                    v-for="(s, i) in steps"
                    :key="s.label"
                    class="flex-1 flex items-center gap-2 min-w-0"
                  >
                    <div
                      :class="[
                        'w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center transition-all',
                        i < currentStep
                          ? 'bg-gold dark:bg-signal'
                          : i === currentStep
                            ? 'bg-gold dark:bg-signal ring-4 ring-gold/15 dark:ring-signal/20'
                            : 'bg-mist/60 dark:bg-[#1c1b1b] border border-haze dark:border-white/15',
                      ]"
                    >
                      <Check v-if="i < currentStep" :size="11" :stroke-width="2.5" class="text-white dark:text-midnight" />
                      <Loader2 v-else-if="i === currentStep" :size="11" class="animate-spin text-white dark:text-midnight" />
                    </div>
                    <span
                      :class="[
                        'font-sans text-[10px] uppercase tracking-[0.18em] font-semibold truncate',
                        i <= currentStep ? 'text-compute dark:text-signal' : 'text-cool',
                      ]"
                    >
                      {{ s.label }}
                    </span>
                    <div
                      v-if="i < steps.length - 1"
                      :class="[
                        'flex-shrink-0 h-px w-3 transition-colors',
                        i < currentStep ? 'bg-gold dark:bg-signal' : 'bg-haze dark:bg-white/10',
                      ]"
                      aria-hidden="true"
                    />
                  </div>
                </div>
                <p
                  v-if="steps[currentStep]"
                  class="font-sans text-[11px] text-cool leading-tight pl-7"
                >
                  {{ steps[currentStep].description }}
                </p>
              </div>
            </transition>

            <!-- Reveal-to-continue gate (buy mode). By FHE law the
                 affordability check CANNOT run on an encrypted balance: the
                 EVM can't branch on the `ebool` from `balance >= cost`, and
                 publishing it would leak the buyer's hidden balance. So when
                 mhUSDC is still encrypted and a buy cost is typed, the CTA is
                 disabled and we ask the user to decrypt their OWN balance —
                 a permit-based off-chain decrypt (zero tx, zero leak). After
                 reveal, the cleartext `insufficientMhUsdc` check takes over.
                 `role="status"` announces the gate when it appears; the inner
                 Reveal button is the focusable affordance for keyboard/SR
                 users (the disabled CTA itself isn't focusable). -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="mhUsdcUnknown && !tokenIsRetired"
                id="trade-mhusdc-reveal-gate"
                data-testid="trade-mhusdc-reveal-gate"
                role="status"
                class="rounded-lg p-4 border border-compute/25 dark:border-signal/20
                       bg-compute/5 dark:bg-signal/5 flex items-start gap-3"
              >
                <Lock :size="16" :stroke-width="1.8" class="text-compute dark:text-signal mt-0.5 flex-shrink-0" aria-hidden="true" />
                <div class="flex-1 min-w-0">
                  <p class="font-sans text-[11px] text-cool leading-relaxed">
                    Your mhUSDC balance is encrypted. Reveal it to confirm this
                    purchase is covered — we can't check an encrypted balance,
                    and it never leaves your browser.
                  </p>
                  <button
                    type="button"
                    @click="decryptMhUsdcBalance"
                    :disabled="portfolio.pusdcDecrypting || !address"
                    data-testid="trade-mhusdc-reveal-cta"
                    :aria-label="portfolio.pusdcDecrypting ? 'Revealing mhUSDC balance' : 'Reveal mhUSDC balance to continue'"
                    class="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded
                           font-sans text-[10px] uppercase tracking-[0.18em] font-semibold
                           border border-compute/40 dark:border-signal/40
                           text-compute dark:text-signal cursor-pointer
                           hover:bg-compute hover:text-white dark:hover:bg-signal dark:hover:text-[#412d00]
                           transition-colors duration-200
                           disabled:opacity-60 disabled:cursor-wait"
                  >
                    <Loader2 v-if="portfolio.pusdcDecrypting" :size="11" class="animate-spin" />
                    <Eye v-else :size="11" :stroke-width="2" />
                    Reveal mhUSDC to continue
                  </button>
                  <!-- Fresh-reveal failure lands here (where the user just
                       clicked) instead of only in the right-aside glance bar.
                       The Reveal button above doubles as the retry. -->
                  <p
                    v-if="portfolio.pusdcError"
                    data-testid="trade-mhusdc-reveal-error"
                    role="alert"
                    class="mt-2 font-sans text-[10px] text-gold dark:text-signal leading-tight"
                  >
                    Couldn't reveal your balance — please try again.
                  </p>
                </div>
              </div>
            </transition>

            <!-- CTA. `aria-describedby` ties the disabled state to a reason
                 an SR user can act on — the retirement banner (token winding
                 down) or the reveal gate (encrypted balance must be revealed
                 first). Cleared when the token is active + balance known so
                 the dropdown's prior-traverse announcement isn't repeated for
                 a healthy, buyable token. -->
            <button
              type="button"
              @click="handleSubmit"
              :disabled="ctaDisabled"
              :aria-describedby="ctaDescribedBy"
              :data-testid="mode === 'buy' ? 'buy-cta' : 'redeem-cta'"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <ShieldCheck v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">{{ ctaLabel }}</span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>

            <!-- Privacy microcopy — replaces the lost on-screen FHE
                 signal that "Encrypt &" prefix used to carry. Always
                 visible under the CTA so the privacy story is on
                 screen even when the button is just "Buy TBILL1". -->
            <p
              data-testid="trade-fhe-microcopy"
              class="flex items-center justify-center gap-1.5 -mt-1
                     font-sans text-[10px] uppercase tracking-[0.22em] text-cool/80"
            >
              <Lock :size="11" :stroke-width="1.8" class="text-compute/80 dark:text-signal/80" />
              FHE-encrypted client-side
            </p>

            <!-- Form area below CTA is now FHE microcopy only. The
                 in-form pre-flight Reveal section, the insufficient-
                 mhUSDC warning block, and the quiet cash link all moved
                 into the right-aside glance bar (mhUSDC row owns the
                 reveal/decrypted/warning lifecycle; the cash link
                 escalates prominence on insufficientMhUsdc). The CTA
                 itself disables on insufficientMhUsdc to prevent the
                 silent-fail click path. -->
          </div>
        </div>
      </section>
    </div>

    <!-- Aside: balances + progress rail -->
    <Teleport to="body" :disabled="!isXl">
      <aside
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
        class="mt-10 xl:mt-0 flex flex-col gap-8 w-full
               xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
               xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
      >
        <!-- ── Glance bar ──────────────────────────────────────────────
             Compact "do I have funds?" answer at a glance. /cash is the
             canonical balances home (commits 8f513c9 + 0923d74); the
             trade page no longer duplicates the wallet card / tile
             stack / step rail / refresh button. The in-form mhUSDC
             pre-flight Reveal section below the CTA still owns the
             "is the buy about to silent-fail?" check.
             -->
        <div>
          <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">
            Account
          </h2>
          <div
            class="rounded-xl border border-haze dark:border-white/8
                   bg-white dark:bg-[#1c1b1b]/80
                   flex flex-col divide-y divide-haze/70 dark:divide-white/5"
          >
            <!-- Address row -->
            <div class="px-4 py-3 flex items-center justify-between gap-2">
              <div class="flex flex-col min-w-0">
                <span class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80">Wallet</span>
                <span class="font-mono text-[11px] text-compute dark:text-signal truncate">
                  {{ address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—' }}
                </span>
              </div>
              <button
                type="button"
                @click="copyAddress"
                :disabled="!address"
                data-testid="trade-glance-copy-address"
                :aria-label="copied ? 'Address copied' : 'Copy smart account address'"
                class="text-cool hover:text-compute dark:hover:text-signal transition-colors flex-shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check v-if="copied" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>

            <!-- USDC row -->
            <div class="px-4 py-3 flex items-center justify-between gap-2">
              <span class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80">USDC</span>
              <span
                class="font-accent italic text-base text-midnight dark:text-white tabular-nums"
                data-testid="trade-glance-usdc"
              >
                {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}
              </span>
            </div>

            <!-- mhUSDC row — four states (locked / decrypting / decrypted /
                 warning). Reveal action lives here, not in the form, so
                 the row owns the full balance lifecycle for the trade
                 page. The warning state is the only pre-CTA signal that
                 survived the form-area cleanup; it earns the extra
                 height when `insufficientMhUsdc` flips true. -->
            <div
              data-testid="trade-glance-mhusdc"
              :class="[
                'px-4 flex flex-col gap-1 transition-colors duration-200',
                insufficientMhUsdc
                  ? 'py-3 bg-gold/8 dark:bg-signal/6'
                  : 'py-3',
              ]"
              :data-warning="insufficientMhUsdc ? 'true' : undefined"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80">mhUSDC</span>

                <!-- Decrypted: value + small refresh icon -->
                <template v-if="portfolio.pusdcConfidentialBalance !== null">
                  <span class="inline-flex items-center gap-2">
                    <AlertTriangle
                      v-if="insufficientMhUsdc"
                      :size="12"
                      :stroke-width="2"
                      class="text-gold dark:text-signal flex-shrink-0"
                    />
                    <span
                      class="font-accent italic text-base text-midnight dark:text-white tabular-nums"
                      data-testid="trade-glance-mhusdc-balance"
                    >
                      {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
                    </span>
                    <button
                      type="button"
                      @click="decryptMhUsdcBalance"
                      :disabled="portfolio.pusdcDecrypting"
                      data-testid="trade-glance-mhusdc-refresh"
                      :title="portfolio.pusdcDecrypting ? 'Refreshing…' : 'Refresh mhUSDC'"
                      :aria-label="portfolio.pusdcDecrypting ? 'Refreshing mhUSDC balance' : 'Refresh mhUSDC balance'"
                      class="text-cool/60 hover:text-compute dark:hover:text-signal transition-colors flex-shrink-0 cursor-pointer disabled:cursor-wait disabled:opacity-50"
                    >
                      <Loader2 v-if="portfolio.pusdcDecrypting" :size="12" class="animate-spin" />
                      <RefreshCw v-else :size="12" />
                    </button>
                  </span>
                </template>

                <!-- Locked: blurred placeholder + Reveal button. Border
                     alpha bumps when the user has typed an amount so the
                     "you might want to check this" nudge is visible
                     without forcing a session signature. -->
                <template v-else>
                  <span class="inline-flex items-center gap-2">
                    <span
                      class="font-accent italic text-sm text-cool/40 dark:text-body-dark/30 tabular-nums select-none blur-[1.5px] tracking-[0.05em]"
                      aria-hidden="true"
                    >
                      $••••.••
                    </span>
                    <button
                      type="button"
                      @click="decryptMhUsdcBalance"
                      :disabled="portfolio.pusdcDecrypting || !address"
                      data-testid="trade-glance-mhusdc-reveal"
                      :aria-label="'Reveal mhUSDC balance'"
                      :class="[
                        'inline-flex items-center gap-1 px-2 py-1 rounded font-sans text-[10px] uppercase tracking-[0.18em] font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-wait transition-all duration-200',
                        'text-compute dark:text-signal hover:text-white dark:hover:text-[#412d00]',
                        'hover:bg-compute dark:hover:bg-signal',
                        amount.trim() && numericAmount > 0
                          ? 'border border-compute/60 dark:border-signal/55'
                          : 'border border-compute/30 dark:border-signal/30',
                      ]"
                    >
                      <Loader2 v-if="portfolio.pusdcDecrypting" :size="11" class="animate-spin" />
                      <Eye v-else :size="11" :stroke-width="2" />
                      <span class="hidden sm:inline">Reveal</span>
                    </button>
                  </span>
                </template>
              </div>

              <!-- Warning sub-line: appears only when the decrypted balance
                   can't cover the typed amount. "Need $Y · short $Z" frames
                   the gap so the user knows exactly how much to top up. -->
              <p
                v-if="insufficientMhUsdc && estimatedCostPusdc !== null && portfolio.pusdcConfidentialBalance !== null"
                data-testid="trade-glance-mhusdc-warning"
                class="font-sans text-[10px] text-cool/80 leading-tight tabular-nums"
              >
                Need
                <span class="text-midnight dark:text-white">{{ formatUSD(Number(estimatedCostPusdc) / 1e6) }}</span>
                · short
                <span class="text-gold dark:text-signal font-semibold">{{ formatUSD(Number(estimatedCostPusdc - portfolio.pusdcConfidentialBalance) / 1e6) }}</span>
              </p>
            </div>
          </div>

          <!-- Top-up cash link — single prominence rule: loud
               (`btn-gold-sweep`) whenever a buy is currently blocked on
               cash, quiet hover-text otherwise. Two block conditions in
               buy mode collapse to the same destination (`/cash` covers
               both the deposit-USDC and wrap-to-mhUSDC flows):
                 • usdcBalance === 0n   — no fuel to wrap
                 • insufficientMhUsdc   — wrapped fuel below this buy's cost
          -->
          <button
            type="button"
            @click="goCash"
            data-testid="trade-glance-cash-link"
            :class="[
              'mt-3 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg',
              'font-sans text-[10px] uppercase tracking-[0.22em] font-semibold',
              'transition-all duration-200 cursor-pointer',
              cashLinkLoud
                ? 'btn-gold-sweep text-midnight'
                : 'text-cool hover:text-compute dark:hover:text-signal',
            ]"
          >
            {{ cashLinkLoud ? 'Top up cash' : 'Manage cash' }}
            <ArrowRight :size="11" :stroke-width="2" />
          </button>
        </div>

        <!-- Security Notice — privacy framing, always visible. The right-
             aside step rail moved inline above the CTA so it's only on
             screen while a tx is actually running. -->
        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">
            Security Notice
          </h3>
          <div class="rounded-lg p-4 border border-compute/20 dark:border-signal/20 bg-compute/5 dark:bg-signal/5 flex items-start gap-3">
            <EyeOff :size="16" :stroke-width="1.8" class="text-compute dark:text-signal mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              {{ mode === 'buy'
                ? 'Shares are encrypted client-side via Fhenix FHE. An ephemeral EOA is granted permit-decrypt rights so only this browser session can read the new balance.'
                : 'Burn amount + payout are encrypted client-side via Fhenix FHE. The same ephemeral EOA decrypts your post-burn balance — only this browser session can see it.' }}
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
