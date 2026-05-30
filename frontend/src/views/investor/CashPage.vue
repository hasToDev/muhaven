<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount, watch, nextTick } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { StableClient } from '@muhaven/sdk'
import { useWallet } from '@/composables/useWallet'
import { useFhe } from '@/composables/useFhe'
import { useAppStore } from '@/stores/app'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { usePortfolioStore } from '@/stores/portfolio'
import IssuerContextCard from '@/components/cash/IssuerContextCard.vue'
import { buildWriteContext, getPublicClient } from '@/services/v35/context'
import * as VaultService from '@/services/contracts/VaultService'
import * as Erc20Service from '@/services/contracts/Erc20Service'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import * as TaskManagerService from '@/services/contracts/TaskManagerService'
import { isAddress, parseUnits, formatUnits, getAddress } from 'viem'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { erc20Abi } from '@/contracts/abis'
import { muHavenStableAbi } from '@muhaven/sdk'
import { CIRCLE_FAUCET_URL, arbiscanTx } from '@/lib/external'
import { formatUSD } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import MAddressQR from '@/components/ui/MAddressQR.vue'
import {
  CheckCircle2, Lock, Shield, EyeOff, ArrowRight, ArrowDownToLine,
  ArrowUpFromLine, Loader2, Copy, Check, RefreshCw, ExternalLink, Coins,
  Layers, Wallet, Sparkles, Eye, AlertTriangle, Send, ArrowLeft,
} from 'lucide-vue-next'

// CashPage — Phase 9.A first-run cockpit + wrap wizard.
//
//   • "Cash" mode (default; the universal first action for investors):
//       USDC → mhUSDC via a single-step `MuHavenStable.wrapUsdc` (Wave 5 W3
//       Phase 9 — USDC pulled straight into the reserve, no legacy-PUSDC
//       intermediate). This is the post-register landing page; the
//       right-aside doubles as the investor's wallet cockpit (address + QR +
//       balances + faucet).
//
//   • "Asset" mode (issuer-side, hidden):
//       underlying ERC-20 RWA → fhERC-20 RWA via `MuHavenVault.wrap`.
//       Reachable only via `?mode=asset` query param so the toggle stays
//       out of the investor's mental model. Same mechanics as before.
//
// Renamed from WrapPage in Phase 9.A — "Wrap" was jargon for the universal
// first action; "Cash" matches the user's "where's my money" mental model
// and pairs naturally with "Portfolio" as the second nav item.

type Mode = 'cash' | 'asset'
// Wave 5 W3 — direction is orthogonal to mode and only meaningful in Cash:
//   deposit  = USDC → mhUSDC   (single-step direct `wrapUsdc`; Phase 9)
//   withdraw = mhUSDC → USDC   (direct exit; two-phase async claim)
//   send     = USDC → external (plain ERC-20 transfer out of the kernel; the
//              off-ramp tail after a withdraw settles cleartext USDC). NO FHE,
//              no SDK — see `SEND_USDC_PLAN.md`. Human-only (no MCP path).
// `?mode=unwrap` is the MCP deep-link target → cash + withdraw. Send has NO
// URL param / deep-link (deliberately not agent-reachable).
type Direction = 'deposit' | 'withdraw' | 'send'

// Named so App.vue's <keep-alive :include> can target this page (WS-1).
defineOptions({ name: 'CashPage' })

const route = useRoute()
const router = useRouter()
const { address, connected } = useWallet()
const { initialize: initFhe, getEphemeralEOA, decryptForTxWithPermit } = useFhe()

// Phase 9.A: mhUSDC decrypted balance is shared cross-page state — the
// portfolio store already holds the same value (`pusdcConfidentialBalance`
// + `decryptPusdc()` action) for the Cash Buffer card on /portfolio.
// Using one source means a wrap or trade auto-syncs every surface that
// renders the value (CashPage tile, TradePage glance bar, Portfolio
// dashboard) without each page maintaining its own ref.
const portfolio = usePortfolioStore()
const appStore = useAppStore()
const issuerTokens = useIssuerTokensStore()

// Phase 9.A · /cash is dual-role. Issuers see an IssuerContextCard
// above the convert form that surfaces in-flight epochs + a top-up
// affordance. Investor side renders unchanged.
const isIssuer = computed(() => appStore.role === 'issuer')

function handleIssuerAutofill(amountString: string) {
  // The convert form's `amount` v-model expects a string. The card
  // emits a generic top-up suggestion; the issuer can edit before
  // converting.
  amount.value = amountString
}

const isXl = useMediaQuery('(min-width: 1280px)')

const wrapperAvailable = computed(() => MuHavenStableService.isAvailable())

// Asset mode is opt-in via `?mode=asset` so the investor view stays single-
// purpose. When the query param is absent we force cash mode AND hide the
// toggle. Issuer/dev flows that need vault wrap reach it explicitly.
//
// Wave 5 W3 — `?mode=unwrap` is the third value: cash mode with the
// withdraw direction pre-selected. The MCP `cash.unwrap` Path-C deep-link
// lands here; the user just confirms amount + taps Withdraw. Asset and
// unwrap are mutually exclusive (no withdraw flow on the vault path yet).
const assetModeRequested = computed(() => route.query.mode === 'asset')
const unwrapModeRequested = computed(() => route.query.mode === 'unwrap')
const showModeToggle = computed(() =>
  wrapperAvailable.value && assetModeRequested.value,
)

// `?mode=unwrap` is an explicit cash-mode intent (the MCP `cash.unwrap`
// deep-link target). Honor it even when `wrapperAvailable` is initially
// false — otherwise the page would silently land in asset mode while
// `direction` stayed `'withdraw'` (the Direction toggle's `v-if` hides
// the visual mismatch, but the `?amount=` pre-fill below would land in
// an unbound `withdrawAmount` ref instead of the visible deposit input).
// Sequence: assetMode wins (issuer/dev opt-in) → unwrapMode forces cash →
// otherwise fall back to wrapperAvailable. The wrapper-availability check
// itself is async (the `MuHavenStable` proxy resolves lazily); once it
// flips true the user is already in the right mode.
const mode = ref<Mode>(
  assetModeRequested.value ? 'asset'
    : unwrapModeRequested.value ? 'cash'
      : wrapperAvailable.value ? 'cash'
        : 'asset',
)

// Direction is independent of mode but only the Cash mode renders the
// Withdraw flow today (Asset has no inverse — vault unwrap is its own
// fhERC-20 → ERC-20 path, out of W3 scope). The Direction toggle is
// hidden when `mode === 'asset'`.
const direction = ref<Direction>(unwrapModeRequested.value ? 'withdraw' : 'deposit')

/** Update the URL when the user toggles direction. Keeps `?mode=unwrap`
 *  shareable + survives back/forward navigation. Strips the param when
 *  returning to deposit (cleaner URL for the default case).
 *
 *  Refuses when mode !== 'cash' — the Direction toggle's `v-if` hides the
 *  buttons in asset mode, but the function is reachable from any
 *  programmatic caller (deep-link, future MCP path). Without this guard,
 *  `?mode=unwrap` could overwrite an `?mode=asset` URL state and a refresh
 *  would silently flip the user from asset to cash. */
function setDirection(next: Direction) {
  if (mode.value !== 'cash') return
  if (direction.value === next) return
  direction.value = next
  // Reset all three forms when toggling so a stale amount / error doesn't
  // bleed across directions. Pending claims are NOT cleared — they're
  // independent of which form is currently visible.
  amount.value = ''
  withdrawAmount.value = ''
  currentStep.value = 0
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
  withdrawSuccess.value = false
  withdrawTxHash.value = null
  withdrawErrMsg.value = null
  resetSendState()
  const nextQuery = { ...route.query }
  if (next === 'withdraw') {
    nextQuery.mode = 'unwrap'
  } else {
    // Returning to deposit OR switching to send: only drop the `mode` param
    // if it was `unwrap`. Don't clobber `?mode=asset` (different axis entirely
    // — though the toggle should not be visible in that state to begin with).
    // Send has no URL param of its own (it's not a deep-link target), so the
    // `watch(unwrapModeRequested)` guard below ignores `direction === 'send'`
    // to keep this strip-on-send from knocking the user back to deposit.
    if (nextQuery.mode === 'unwrap') delete nextQuery.mode
  }
  void router.replace({ query: nextQuery })
}

const amount = ref('')
const currentStep = ref(0)
const isProcessing = ref(false)
const showSuccess = ref(false)
const txHash = ref<string | null>(null)
const errMsg = ref<string | null>(null)

// ── Send (cleartext USDC → external address) state ──────────────────────
//
// The off-ramp tail: a plain `USDC.transfer(to, amount)` dispatched as one
// UserOp from the kernel. No FHE, no SDK, no async claim — this moves USDC
// that is ALREADY cleartext in the kernel (a settled withdraw, or a faucet
// drip) out to an arbitrary external wallet. Irreversible + leaves MuHaven,
// so the flow has an inline two-step shape (form → confirm) that echoes the
// full recipient + amount before signing. Kept human-only (no MCP/agent tool)
// — sending funds to an arbitrary address is exfiltration-shaped.
const sendRecipient = ref('')
const sendAmount = ref('')
const sendIsProcessing = ref(false)
const sendSuccess = ref(false)
const sendTxHash = ref<string | null>(null)
const sendErrMsg = ref<string | null>(null)
// Inline confirm sub-step (NOT a modal — CashPage is keep-alive cached and a
// new Teleport overlay would risk the cross-page leak class; see
// `feedback_keepalive_teleport_and_watcher_churn`). 'form' → 'confirm'.
const sendStep = ref<'form' | 'confirm'>('form')

// A11y focus targets for the send state transitions (mirror the withdraw refs).
const sendRecipientInputRef = ref<HTMLInputElement | null>(null)
const sendConfirmButtonRef = ref<any>(null)
const sendAgainButtonRef = ref<any>(null)
const sendTryAgainButtonRef = ref<any>(null)

const sendRecipientValid = computed(() => isAddress(sendRecipient.value.trim()))
/** True when the (valid) recipient is the zero address — a guaranteed
 *  burn/loss; reject it. `isAddress('0x000…000')` returns true, so this is a
 *  distinct guard on top of validity. */
const sendIsZeroAddr = computed(() => {
  if (!sendRecipientValid.value) return false
  return isZeroAddress(sendRecipient.value.trim() as `0x${string}`)
})
/** True when the recipient is the user's OWN kernel — a no-op fee waste. */
const sendIsSelf = computed(() => {
  if (!sendRecipientValid.value || !address.value) return false
  try {
    return getAddress(sendRecipient.value.trim()) === getAddress(address.value as `0x${string}`)
  } catch { return false }
})
/** Parse the amount with EXACT 6-decimal precision (USDC is 6-dp). `parseUnits`
 *  throws on malformed input (too many decimals, non-numeric) — we catch and
 *  return null so the submit stays disabled rather than crashing. NOT the wrap
 *  flow's lossy `Math.round(x * 1e6)`. */
const sendAmountUnits = computed<bigint | null>(() => {
  const raw = sendAmount.value.trim()
  if (!raw) return null
  try {
    const u = parseUnits(raw as `${number}`, 6)
    return u >= 0n ? u : null
  } catch {
    return null
  }
})
const sendOverBalance = computed(() =>
  sendAmountUnits.value !== null
  && sendAmountUnits.value > 0n
  && usdcBalance.value !== null
  && sendAmountUnits.value > usdcBalance.value,
)
const sendAmountValid = computed(() =>
  sendAmountUnits.value !== null
  && sendAmountUnits.value > 0n
  && usdcBalance.value !== null
  && sendAmountUnits.value <= usdcBalance.value,
)
const sendCanSubmit = computed(() =>
  !sendIsProcessing.value
  && sendRecipientValid.value
  && !sendIsZeroAddr.value
  && !sendIsSelf.value
  && sendAmountValid.value,
)
/** Human-readable echo of the parsed amount for the confirm step + success
 *  toast. Uses FULL 6-decimal fidelity (via `formatBase6`, max 6 dp) — NOT
 *  the 2-dp `formatUSD` — so the irreversible-send review shows EXACTLY the
 *  amount being signed (`sendAmountUnits`). A user sending 12.345678 USDC must
 *  see "$12.345678", not a rounded "$12.35". Same posture as the withdraw
 *  flow's `formatBase6`. */
const sendAmountDisplay = computed(() =>
  sendAmountUnits.value !== null ? formatBase6(sendAmountUnits.value) : '—',
)
/** The recipient in canonical EIP-55 checksummed form for the confirm echo —
 *  EXACTLY the address `handleSend` passes on-chain (`getAddress`), so what the
 *  user verifies on the confirm card is byte-for-byte what Arbiscan will show.
 *  Falls back to the raw trimmed input if it's not yet a valid address (the
 *  confirm step is only reachable once `sendCanSubmit`, so the fallback is
 *  defensive). SecEng review polish (F-3). */
const sendRecipientChecksummed = computed(() => {
  const raw = sendRecipient.value.trim()
  if (!sendRecipientValid.value) return raw
  try { return getAddress(raw) } catch { return raw }
})

// ── Wave 5 W3 — Withdraw (mhUSDC → USDC) state ──────────────────────────
//
// Two-phase async flow (FHE necessity — see `reference_mhusdc_usdc_exit_is_async_fhe`):
//   1. `withdrawToUsdc(amount, eph) → claimId` burns mhUSDC + requests
//      coprocessor decryption. Returns a monotonic claimId.
//   2. After the decrypt lands (`withdrawDecryptResult.ready === true`),
//      `claimUsdc(claimId)` settles real USDC from the wrapper's reserve
//      to the user.
//
// State separation:
//   - `withdrawAmount` / `withdrawIsProcessing` / `withdrawSuccess` /
//     `withdrawTxHash` / `withdrawErrMsg` mirror the deposit-flow refs but
//     are kept distinct so a stale deposit result doesn't bleed across the
//     direction toggle.
//   - `pendingClaims` is the per-user re-discoverable list of in-flight
//     claims (re-built from `getUserWithdrawClaims` on mount + on every
//     successful withdraw). Settled claims are pruned by the contract from
//     `_userWithdrawClaims` so the list is always "what's still owed."
const withdrawAmount = ref('')
const withdrawIsProcessing = ref(false)
const withdrawSuccess = ref(false)
const withdrawTxHash = ref<string | null>(null)
const withdrawErrMsg = ref<string | null>(null)

/** Per-claim UI shape. `amount` is null while the coprocessor decrypt is
 *  still in flight (the contract stores `amount = 0` until `claimUsdc`
 *  settles it, so the polled `withdrawDecryptResult.amount` IS the source
 *  of truth for the burned figure). */
interface PendingClaim {
  claimId: bigint
  ready: boolean
  amount: bigint | null
  claiming: boolean
  /** Last-known error from claimUsdc, if the user tried + the reserve was
   *  short / kill-switch was on / etc. Cleared on next retry. */
  errMsg: string | null
}

const pendingClaims = ref<PendingClaim[]>([])
const pendingDiscoveryError = ref<string | null>(null)
const claimsKillSwitch = ref<boolean>(false)
// `paused()` is the whole-wrapper kill-switch (blocks wrap, transfer, AND
// withdrawToUsdc request leg). Separate from `claimsPaused()` which only
// blocks `claimUsdc` settlement. Both surfaced in the Withdraw UI so the
// user sees WHY their CTA / Claim button is disabled before touching it.
const wrapperPaused = ref<boolean>(false)
const numericWithdrawAmount = computed(
  () => parseFloat(withdrawAmount.value.replace(/,/g, '')) || 0,
)
const hasMhUsdcBalance = computed(() => {
  const bal = portfolio.pusdcConfidentialBalance
  return bal !== null && bal !== undefined && bal > 0n
})
const withdrawSubmitDisabled = computed(() =>
  withdrawIsProcessing.value
  || !withdrawAmount.value.trim()
  || numericWithdrawAmount.value <= 0
  // Hard-gate the submit on the wrapper-wide pause so the user gets a
  // clear UI affordance instead of a tx revert. The kill-switch banner
  // above the form explains why.
  || wrapperPaused.value,
)

// Poll handle for `withdrawDecryptResult` on non-ready claims. Started
// whenever the pending list has any non-ready entry; stopped when all
// claims are ready (or the list empties). 5s cadence — cofhe testnet
// decrypts usually land in <60s, so a few polls covers the typical case.
let claimPollTimer: ReturnType<typeof setInterval> | null = null
const CLAIM_POLL_INTERVAL_MS = 5_000
// Precomputed seconds for the template (avoids `Math.round(... / 1000)`
// inline in JSX-like bindings — minor clarity bump).
const CLAIM_POLL_INTERVAL_SECONDS = Math.round(CLAIM_POLL_INTERVAL_MS / 1000)

// Round-2 review (FE Dev HIGH) — guard against late Promise resolutions
// after the component unmounts. Async loops inside `pollPendingDecrypts`
// + `loadPendingClaims` still resolve after teardown, and the post-resolve
// code could call `toast.success` etc. on a component the user already
// navigated away from. Short-circuit at the top of each async map callback.
let isUnmounted = false

// WS-1 keep-alive — true only while the page is the active route. Distinct
// from `isUnmounted` (which flips once, on TRUE destroy): under <keep-alive>
// the component is NOT destroyed on navigate-away, just deactivated. This flag
// gates the polling watchers + the claim-poll re-arm so a BACKGROUNDED /cash
// stops hitting the RPC, then resumes on re-entry via onActivated.
const isActive = ref(false)

// Round-2 review (CR H-1) — in-flight guard for `loadPendingClaims`. With
// four reactive triggers (watch address immediate + connected + route.path +
// manual Refresh) the discovery can stampede on first /cash mount; a user
// with 64 pending claims × N concurrent loads = pathological RPC burst that
// can clobber state mid-rebuild. Coalesce concurrent calls into one in-flight
// promise; later callers get the same result.
let inFlightDiscovery: Promise<void> | null = null

// Round-2 review (A11y F7) — focus management targets for state transitions.
// On state swap (success → form, error → form, etc.) we `nextTick` then
// `.focus()` the relevant element so a screen-reader user isn't orphaned at
// document root. Three refs cover the withdraw success/error/form chain
// primary actions; pending-claims doesn't need it (the list grows in place;
// no element unmounts under the user's cursor). Component refs (MButton)
// resolve to the component instance via Vue's string-ref mechanism — the
// focus helper unwraps `.$el` if it's a component proxy.
const withdrawAmountInputRef = ref<HTMLInputElement | null>(null)
const withdrawAgainButtonRef = ref<any>(null)
const withdrawTryAgainButtonRef = ref<any>(null)

// Steps shown only while a wrap is in flight (inline above the Convert
// button). "Enter Amount" intentionally dropped — by the time the rail
// is visible the user has already entered the amount. Two real steps
// remain per mode.
const cashSteps = [
  { label: 'Approve USDC', description: 'Granting allowance so the wrapper can pull your USDC…' },
  { label: 'Mint mhUSDC', description: 'Encrypting your USDC into spendable mhUSDC…' },
]
const assetSteps = [
  { label: 'Approve', description: 'Approving ERC-20 to vault…' },
  { label: 'Wrap', description: 'Wrapping into fhERC-20…' },
]
const steps = computed(() => mode.value === 'cash' ? cashSteps : assetSteps)

const quickAmounts = ['100', '1000', '5000']
const numericAmount = computed(() => parseFloat(amount.value.replace(/,/g, '')) || 0)

// Cash-mode direction segments. Drives the 3-way toggle (Deposit / Withdraw /
// Send). Icons are lucide components rendered via <component :is>.
const directionOptions: Array<{ value: Direction; label: string; icon: typeof Send }> = [
  { value: 'deposit', label: 'Deposit', icon: ArrowDownToLine },
  { value: 'withdraw', label: 'Withdraw', icon: ArrowUpFromLine },
  { value: 'send', label: 'Send', icon: Send },
]

// ── Wallet aside readouts ──────────────────────────────────────────────

const copied = ref(false)
const balancesLoading = ref(false)
const usdcBalance = ref<bigint | null>(null)

// Anti-layout-shift gate. The welcome ribbon's `v-if` depends on
// `isFirstRun` which depends on the async USDC balance read; rendering
// the main convert card before the read settled meant the card would
// animate in alone, then the ribbon would mount ~half a second later
// when the RPC resolved and push the card downward. Holding both
// sections behind a single `balancesLoaded` flag guarantees they
// commit to a layout in the same tick — ribbon (if first-run) and
// card animate together via the stagger on the card's :visible-once.
//
// Flipped true:
//   • after `loadBalances()` resolves (success OR error)
//   • when there's no wallet to load against (initial state, render
//     immediately so the disconnected view isn't blank)
//   • by a 1500ms timeout fallback (degraded RPC: render rather than
//     leave the page blank; late-arriving RPC could re-trigger the
//     pop-in but only on truly slow networks, accepted edge case)
const balancesLoaded = ref(false)

// True first-run state: USDC has been read AND is zero AND the user has
// no decrypted mhUSDC. Gates the welcome ribbon so returning users
// topping up don't see onboarding copy on every visit. mhUSDC value
// lives in the portfolio store now (`pusdcConfidentialBalance`); same
// gate logic as before, just reads the shared source.
const isFirstRun = computed(() =>
  usdcBalance.value === 0n
  && (portfolio.pusdcConfidentialBalance === null || portfolio.pusdcConfidentialBalance === 0n),
)

async function loadBalances() {
  if (!address.value) {
    // No wallet → nothing to fetch, but the page still needs to render
    // (the disconnected view shows the form + an aside with `—` balances).
    balancesLoaded.value = true
    return
  }
  balancesLoading.value = true
  try {
    usdcBalance.value = await Erc20Service.balanceOf(
      addresses.usdc, address.value as `0x${string}`,
    )
  } catch (e) {
    console.warn('[CashPage] USDC balance read failed', e)
    usdcBalance.value = null
  } finally {
    balancesLoading.value = false
    balancesLoaded.value = true
  }
}

/**
 * Unified refresh: re-read USDC AND re-decrypt mhUSDC, but only if the
 * user has already revealed mhUSDC. If the balance is still locked we
 * leave it locked — refreshing shouldn't trigger a session signature
 * for a value the user hasn't asked to see.
 */
async function refreshAll() {
  if (!address.value) return
  await loadBalances()
  if (portfolio.pusdcConfidentialBalance !== null) {
    await portfolio.decryptPusdc(address.value as `0x${string}`)
  }
}

/**
 * Reveal mhUSDC via the portfolio store's `decryptPusdc` action. Same
 * FHE flow under the hood (initFhe → MuHavenStable.confidentialBalanceOf
 * → decryptMhUsdcForView with legacy-PUSDC fallback) — using the store
 * means CashPage tile, TradePage glance bar, and Portfolio Cash Buffer
 * all read the same value, and a wrap or trade refresh updates every
 * surface at once.
 */
async function decryptMhUsdcBalance() {
  if (!address.value) return
  await portfolio.decryptPusdc(address.value as `0x${string}`)
}

async function copyAddress() {
  if (!address.value) return
  await navigator.clipboard.writeText(address.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

// ── Inbound-balance auto-refresh + bloom choreography ──────────────────
//
// Three-agent co-spec (UX Researcher + UX Architect + UI Designer):
//   - Architect: viem.watchContractEvent filtered to `to: kernelAddress`
//     (Transfer for USDC; for mhUSDC, MuHavenStable.Transfer fires on
//     mint/transfer with kernel-only args — no amount in the log, just
//     a refresh trigger). pollingInterval ≈ Arb Sepolia block time;
//     cleanup on unmount + on address change.
//   - Designer: soft amber bloom on the affected tile (600ms, ~12% gold
//     border alpha) + transient `+$X.XX` subtitle for USDC deltas ≥$1
//     (slides up under the value, persists 3.5s, fades 600ms). Faucet
//     "Get test USDC" link cross-fades out as the bloom begins on the
//     0→positive transition. Multiple drips inside a 1500ms window
//     coalesce into one bloom + one summed delta, so a multi-tx faucet
//     drip animates once at the final total.
//   - Researcher: silent-but-noticed (no toast spam — privacy-first;
//     amber bloom is detected pre-attentively in peripheral vision per
//     Bartram et al.'s motion-perception studies). For mhUSDC the
//     bloom fires regardless of reveal-state but the subtitle requires
//     a revealed pre-state (we know the new value only when the user
//     has opted into decrypt).
//
// Implementation: watcher subscribes when `address.value` and
// `connected.value` resolve; cleanup ref tracked so we can unwatch on
// account-switch + unmount. The watcher's onLogs handler debounces
// inside the 1500ms window and re-loads/re-decrypts.
// Bloom state. `*BloomActive` toggles the gold-ring overlay (mount-fade
// driven by Vue's <Transition>); `usdcDeltaCents` powers the transient
// `+$X.XX received` subtitle. Both clear after their hold timer fires.
const usdcBloomActive = ref(false)
const mhusdcBloomActive = ref(false)
const usdcDeltaCents = ref<number>(0)
let pendingUsdcDeltaCents = 0
let usdcBloomTimer: ReturnType<typeof setTimeout> | null = null
let usdcBloomClearTimer: ReturnType<typeof setTimeout> | null = null
let usdcDeltaClearTimer: ReturnType<typeof setTimeout> | null = null
let mhusdcBloomTimer: ReturnType<typeof setTimeout> | null = null
let mhusdcBloomClearTimer: ReturnType<typeof setTimeout> | null = null
const watcherCleanups: Array<() => void> = []
// Safety-net polling. viem's watchContractEvent uses eth_newFilter +
// eth_getFilterChanges by default; some RPCs garbage-collect filters
// after a TTL, which silently kills the watcher. This interval guarantees
// the USDC + mhUSDC balances refresh every SAFETY_POLL_MS regardless of
// watcher state, with no bloom animation (the bloom is the watcher's job;
// this is just data freshness). Cleared in teardownWatchers.
let safetyPollTimer: ReturnType<typeof setInterval> | null = null

const BLOOM_DEBOUNCE_MS = 1500
const BLOOM_HOLD_MS = 900            // gold ring visible duration (≈ 600ms enter + 300ms hold before fade)
const SUBTITLE_PERSIST_MS = 3500
const SAFETY_POLL_MS = 30_000         // 30s: cheap, much faster than the user noticing staleness

function triggerUsdcBloom(deltaUnits: bigint) {
  // 6-decimal USDC base units → cents (1e-2). Sub-dollar dust still
  // pulses the ring but suppresses the subtitle (avoids "+$0.00" noise).
  const cents = Number(deltaUnits / 10_000n)
  pendingUsdcDeltaCents += cents
  if (usdcBloomTimer) clearTimeout(usdcBloomTimer)
  usdcBloomTimer = setTimeout(() => {
    usdcBloomActive.value = true
    usdcDeltaCents.value = pendingUsdcDeltaCents
    pendingUsdcDeltaCents = 0
    if (usdcBloomClearTimer) clearTimeout(usdcBloomClearTimer)
    usdcBloomClearTimer = setTimeout(() => {
      usdcBloomActive.value = false
    }, BLOOM_HOLD_MS)
    if (usdcDeltaClearTimer) clearTimeout(usdcDeltaClearTimer)
    usdcDeltaClearTimer = setTimeout(() => {
      usdcDeltaCents.value = 0
    }, SUBTITLE_PERSIST_MS)
    void loadBalances()
  }, BLOOM_DEBOUNCE_MS)
}

function triggerMhusdcBloom() {
  if (mhusdcBloomTimer) clearTimeout(mhusdcBloomTimer)
  mhusdcBloomTimer = setTimeout(() => {
    mhusdcBloomActive.value = true
    if (mhusdcBloomClearTimer) clearTimeout(mhusdcBloomClearTimer)
    mhusdcBloomClearTimer = setTimeout(() => {
      mhusdcBloomActive.value = false
    }, BLOOM_HOLD_MS)
    // Re-decrypt only if the user has already opted in to reveal —
    // surprise session signatures on inbound transfers would be a
    // privacy footgun. Locked users see the bloom only; clicking
    // Reveal afterwards picks up the new on-chain handle.
    if (portfolio.pusdcConfidentialBalance !== null && address.value) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  }, BLOOM_DEBOUNCE_MS)
}

function teardownWatchers() {
  for (const cleanup of watcherCleanups) {
    try { cleanup() } catch { /* best-effort */ }
  }
  watcherCleanups.length = 0
  if (usdcBloomTimer) { clearTimeout(usdcBloomTimer); usdcBloomTimer = null }
  if (usdcBloomClearTimer) { clearTimeout(usdcBloomClearTimer); usdcBloomClearTimer = null }
  if (usdcDeltaClearTimer) { clearTimeout(usdcDeltaClearTimer); usdcDeltaClearTimer = null }
  if (mhusdcBloomTimer) { clearTimeout(mhusdcBloomTimer); mhusdcBloomTimer = null }
  if (mhusdcBloomClearTimer) { clearTimeout(mhusdcBloomClearTimer); mhusdcBloomClearTimer = null }
  if (safetyPollTimer) { clearInterval(safetyPollTimer); safetyPollTimer = null }
  pendingUsdcDeltaCents = 0
  usdcBloomActive.value = false
  mhusdcBloomActive.value = false
  usdcDeltaCents.value = 0
}

function setupInboundWatchers(kernelAddress: `0x${string}`) {
  // Always tear down before re-arming so an account-switch doesn't
  // leak the previous kernel's subscription. `watchContractEvent`
  // returns an unwatch fn that closes the underlying eth_newFilter.
  teardownWatchers()
  const publicClient = getPublicClient()

  // USDC inbound — fires on every Transfer where to == kernel.
  const unwatchUsdc = publicClient.watchContractEvent({
    address: addresses.usdc,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { to: kernelAddress },
    pollingInterval: 12_000,
    onLogs: (logs) => {
      let total = 0n
      for (const l of logs) {
        const value = (l.args as { value?: bigint } | undefined)?.value
        if (typeof value === 'bigint') total += value
      }
      if (total > 0n) triggerUsdcBloom(total)
    },
    // Surface RPC errors (filter dropped, rate limit, etc.) so the
    // user can see why the bloom stopped firing. Without this, viem's
    // poll loop swallows errors and the watcher silently dies. The
    // safety-net poll below covers the data-freshness side regardless;
    // this is just diagnostics.
    onError: (err) => {
      console.warn('[CashPage] USDC inbound watcher error', err)
    },
  })
  watcherCleanups.push(unwatchUsdc)

  // mhUSDC inbound — MuHavenStable.Transfer is `(from, to)` only (no
  // amount; FHE-encrypted balances on the contract). The watcher is a
  // refresh trigger; the actual new balance comes from re-decrypting
  // the post-transfer handle if the user has revealed mhUSDC.
  if (!isZeroAddress(v35Addresses.muHavenStable)) {
    const unwatchMhusdc = publicClient.watchContractEvent({
      address: v35Addresses.muHavenStable,
      abi: muHavenStableAbi,
      eventName: 'Transfer',
      args: { to: kernelAddress },
      pollingInterval: 12_000,
      onLogs: () => triggerMhusdcBloom(),
      onError: (err) => {
        console.warn('[CashPage] mhUSDC inbound watcher error', err)
      },
    })
    watcherCleanups.push(unwatchMhusdc)
  }

  // Safety-net poll. Some Arb Sepolia RPCs (notably the public
  // endpoints) drop eth_newFilter handles after a TTL, which kills
  // viem's watchContractEvent silently mid-session. This interval is
  // independent of the watcher: every SAFETY_POLL_MS we re-read the
  // USDC balance + (if revealed) the mhUSDC balance. No bloom — the
  // bloom is the watcher's job. This guarantees the displayed value
  // is at most ~30s stale even when the watcher fully fails.
  safetyPollTimer = setInterval(() => {
    if (!isActive.value) return  // never heavy-reload a backgrounded kept-alive page
    void loadBalances()
    if (portfolio.pusdcConfidentialBalance !== null && address.value) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  }, SAFETY_POLL_MS)
}

// ── WS-1 keep-alive lifecycle + rapid-nav guards ───────────────────────────
// Same two guards as PortfolioPage (the RPC-429 fix): the per-entry refetch is
// THROTTLED and watcher arming is DEBOUNCED. viem arms an eth_newFilter the
// instant watchContractEvent is called and multicall can't batch those, so
// re-arming on every entry was the real 429 source — flitting Cash<->Portfolio
// now never arms (the pending arm is cancelled on deactivate). isUnmounted
// (one-way, TRUE-destroy only) stays distinct from isActive (activate/deactivate).
const ARM_DEBOUNCE_MS = 1200
const LOAD_THROTTLE_MS = 8000
let armTimer: ReturnType<typeof setTimeout> | null = null
let lastCashLoadAt = 0

function clearArmTimer() {
  if (armTimer) { clearTimeout(armTimer); armTimer = null }
}
function armWatchersDebounced() {
  clearArmTimer()
  armTimer = setTimeout(() => {
    armTimer = null
    if (isActive.value && address.value) setupInboundWatchers(address.value as `0x${string}`)
  }, ARM_DEBOUNCE_MS)
}
function refetchCashThrottled() {
  if (!(connected.value && address.value)) return
  if (Date.now() - lastCashLoadAt < LOAD_THROTTLE_MS) return
  lastCashLoadAt = Date.now()
  void loadBalances()
  void loadPendingClaims()
}

onActivated(() => {
  isActive.value = true
  refetchCashThrottled()
  if (connected.value && address.value) armWatchersDebounced()
  // Re-arm the claim poll from CACHED pending claims even when the refetch
  // above was throttled (settling on /cash within the throttle window would
  // otherwise leave the 5s readiness poll off until the next load). Idempotent:
  // no-ops if a timer already exists or every cached claim is ready.
  ensurePollingActive()
})
onDeactivated(() => {
  isActive.value = false
  clearArmTimer()
  teardownWatchers()
  stopPolling()
  // CR review MEDIUM-1 — drop out of the send confirm sub-step on nav-away.
  // CashPage is kept alive, so without this a user who advanced to the confirm
  // screen then navigated away returns (onActivated) to a PRIMED "Confirm &
  // Send" button echoing a possibly-stale amount. Bouncing to the form on
  // deactivate means re-entry always lands on the editable form. Typed values
  // are intentionally preserved (only the step resets); the form re-validates
  // live and handleSend re-checks at broadcast, so this is purely a "don't
  // return to a primed irreversible action" guard. The withdraw flow has no
  // confirm step so it doesn't need this.
  if (sendStep.value === 'confirm') sendStep.value = 'form'
})
onBeforeUnmount(() => {
  // Flip isUnmounted BEFORE teardown so any in-flight Promise.all resolutions in
  // pollPendingDecrypts / loadPendingClaims / claimWithdrawal short-circuit
  // before mutating refs / firing toasts.
  isUnmounted = true
  isActive.value = false
  clearArmTimer()
  teardownWatchers()
  stopPolling()
})

// Account switch WHILE active → new kernel: bypass the load throttle + re-arm
// (debounced); logout (addr falsy) tears everything down. Gated on isActive so
// a switch landing while backgrounded is a no-op (onActivated re-syncs on
// return). No `immediate`: first entry is owned by onActivated above.
watch(
  () => address.value,
  (addr) => {
    if (!isActive.value) return
    clearArmTimer()
    if (addr) {
      lastCashLoadAt = 0
      refetchCashThrottled()
      armWatchersDebounced()
    } else {
      teardownWatchers()
      pendingClaims.value = []
      stopPolling()
      // Don't leave a recipient/amount staged across a logout.
      resetSendState()
    }
  },
)

// Late-connect (user signs in while sitting on /cash). Gated on isActive so a
// connection event landing while backgrounded is a no-op — onActivated
// refetches on return. (Replaces the removed watch(route.path==='/cash').)
watch(connected, (val) => {
  if (!isActive.value) return
  if (val) {
    refetchCashThrottled()
    armWatchersDebounced()
  }
})

// Wave 5 W3 — keep the `direction` ref in sync with the URL on back/forward
// navigation + MCP deep-links that fire after mount. setDirection() owns
// the user-driven path (writes URL + resets forms); this watcher covers the
// browser-history / external-link path (read URL, don't reset forms so any
// in-flight withdraw state survives a back-button glance). Same-value
// guards prevent a feedback loop with setDirection's own URL write.
watch(unwrapModeRequested, (isUnwrap) => {
  if (mode.value !== 'cash') return
  // `send` is a URL-less direction (no deep-link). setDirection('send') strips
  // any `?mode=unwrap`, which fires this watcher; without this guard it would
  // immediately knock the user back to deposit. Leave `send` alone.
  if (direction.value === 'send') return
  const desired: Direction = isUnwrap ? 'withdraw' : 'deposit'
  if (direction.value !== desired) direction.value = desired
})

watch(mode, (m) => {
  // Reset progress + scoped state when toggling between flows so a half-
  // finished asset wrap doesn't leak into a cash-mode progress rail.
  currentStep.value = 0
  amount.value = ''
  showSuccess.value = false
  txHash.value = null
  errMsg.value = null
  // Round-2 (CR M-1 + H-2) — direction is meaningful only in cash mode.
  // On mode → asset transition, reset direction so a later flip back to
  // cash doesn't show the withdraw branch unexpectedly. On mode → cash
  // transition, re-evaluate the URL intent so a deep-link with both
  // `?mode=cash` (a no-op no longer reached via setMode) and an external
  // URL change to `?mode=unwrap` correctly land on the withdraw form.
  if (m !== 'cash') {
    if (direction.value !== 'deposit') direction.value = 'deposit'
  } else if (unwrapModeRequested.value && direction.value !== 'withdraw') {
    direction.value = 'withdraw'
  }
})

onMounted(() => {
  // Balance + claim discovery for a connected wallet now runs in onActivated
  // (which fires right after onMounted on first mount AND on every re-entry),
  // so it isn't duplicated here. onMounted keeps only the TRUE first-mount
  // concerns: the no-wallet render fast-path, issuer context, the render
  // fallback timeout, and the MCP deep-link prefill.
  if (!connected.value) {
    // No wallet on mount — render the page immediately so the user sees
    // the form rather than a blank column while we wait for an event
    // that may never come (`watch(connected)` covers the late-connect
    // case and re-fires `loadBalances`).
    balancesLoaded.value = true
  }
  // Phase 9.A · issuer-side context — load tokens lazily so the card
  // can read in-flight epochs. Investors don't need this fetch.
  if (isIssuer.value && !issuerTokens.loaded) {
    issuerTokens.load().catch(() => {/* non-blocking */})
  }
  // 1500ms timeout fallback. If the USDC RPC stalls past this point we
  // commit to rendering the page anyway — a blank column for several
  // seconds is worse than a possible late-arriving ribbon push. The
  // timeout is generous enough that healthy staging RPCs always resolve
  // first; only genuinely degraded sessions hit the fallback.
  setTimeout(() => { balancesLoaded.value = true }, 1500)

  // Path C deep-link from @muhaven/mcp `cash.wrap({ amount: 100 })` →
  // `/cash?amount=100`. Pre-fill the form so the user just reviews +
  // taps Convert; we NEVER auto-submit. The amount is in human-readable
  // USDC units (e.g. "100" for $100), matching the form's own unit
  // convention. Reject non-numeric / negative values silently — a bad
  // pre-fill just leaves the field empty.
  //
  // Round-2 (CR L-5) — when the deep-link also requests the withdraw
  // direction (`?mode=unwrap&amount=100`), pre-fill the WITHDRAW input
  // instead. Same MCP Path-C pattern, applied to the active form.
  const queryAmount = route.query.amount as string | undefined
  if (queryAmount && /^\d+(\.\d+)?$/.test(queryAmount)) {
    if (direction.value === 'withdraw') withdrawAmount.value = queryAmount
    else amount.value = queryAmount
  }
})

// ── Mode switcher ──────────────────────────────────────────────────────

function setMode(next: Mode) {
  if (mode.value === next) return
  if (next === 'cash' && !wrapperAvailable.value) return
  mode.value = next
}

// ── Submit ─────────────────────────────────────────────────────────────

async function handleSubmit() {
  if (mode.value === 'cash') return handleCashWrap()
  return handleAssetWrap()
}

/**
 * USDC → encrypted mhUSDC, Wave 5 W3 Phase 9 single-step direct wrap.
 * Investors hold cleartext Circle USDC after funding their kernel from the
 * Circle faucet; mhUSDC is what `MuHavenSubscription.purchase` pulls.
 *
 * `MuHavenStable.wrapUsdc(amount, eph)` pulls the USDC straight into the
 * wrapper's reserve and mints mhUSDC 1:1 in ONE transaction — no legacy
 * PUSDC intermediate, no PUSDC operator grant. This also makes the reserve
 * circular (deposits grow it, withdrawals drain it). The deposit amount is
 * public via the USDC ERC-20 Transfer log (same boundary as before — the old
 * 2-step's USDC→PUSDC leg also exposed it); mhUSDC balances stay confidential.
 *
 * Flow:
 *   - Step 0: approve USDC for the wrapper (only when allowance < amount).
 *   - Step 1: `stable.wrapUsdc(amount, eph)` (one tx; no client-side encrypt).
 */
async function handleCashWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  if (!wrapperAvailable.value) {
    errMsg.value = 'MuHavenStable wrapper not configured for this build.'
    return
  }
  isProcessing.value = true
  errMsg.value = null

  try {
    // USDC and mhUSDC both use 6 decimals — same scaling, no rate conversion.
    const amountUnits = BigInt(Math.round(numericAmount.value * 1_000_000))
    if (amountUnits <= 0n) throw new Error('Amount must be positive')

    const kernel = address.value as `0x${string}`

    // ── Step 0 (display) → Approve USDC for the wrapper ───────────────
    // Approve only when allowance < amount. Approve `amountUnits` exactly
    // (not max) so the surface area stays tight; investors who repeat
    // wraps will pay a fresh approve each time but it's a 1-tx ERC-20
    // call — minor cost vs. perpetual unlimited approval risk. Note the
    // spender is now the wrapper itself (wrapUsdc pulls USDC directly),
    // not the legacy PUSDC contract.
    currentStep.value = 0
    const allowance = await Erc20Service.allowance(
      addresses.usdc, kernel, v35Addresses.muHavenStable,
    )
    if (allowance < amountUnits) {
      await Erc20Service.approve(addresses.usdc, v35Addresses.muHavenStable, amountUnits)
      toast.info('USDC approved', {
        description: 'Wrapper can now pull your USDC',
      })
    }

    // ── Step 1 (display) → Direct USDC → mhUSDC wrap (single tx) ───────
    // `wrapUsdc` takes the cleartext amount (the on-chain handle is
    // trivially-encrypted), so there's no client-side encrypt round-trip.
    currentStep.value = 1
    await initFhe()
    const ctx = await buildWriteContext()
    const stable = new StableClient(ctx, v35Addresses.muHavenStable)
    const eph = getEphemeralEOA() as `0x${string}`

    const hash = await stable.wrapUsdc(amountUnits, eph)
    txHash.value = hash
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: 'USDC converted 1:1 into mhUSDC — ready for atomic buys.',
    })
    // Refresh USDC + auto-decrypt the new mhUSDC balance so the user
    // sees their fresh confidential cash without an extra click.
    loadBalances()
    decryptMhUsdcBalance()
  } catch (e) {
    // Print the full error CHAIN — TxFailedError wraps the underlying
    // viem/sender error in `cause`, but `toast.error` only shows the
    // top-level message. Walking `cause` here reveals the actual revert
    // reason / RPC error / encoding issue underneath. Without this, a
    // bare "Transaction failed for MuHavenStable.wrap (not submitted)"
    // hides whatever viem actually saw.
    console.error('[CashPage] cash wrap failed — full chain:')
    // tsconfig targets ES2020, so `Error.cause` isn't on the lib type. Walk
    // it via a structural read so we don't need to widen the project's lib.
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      if (cur instanceof Error) {
        console.error(`  [${depth}] ${cur.constructor.name}:`, cur)
        const next = (cur as Error & { cause?: unknown }).cause
        if (next) {
          cur = next
          depth += 1
          continue
        }
      } else {
        console.error(`  [${depth}] ${typeof cur}:`, cur)
      }
      break
    }
    errMsg.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: errMsg.value })
  } finally {
    isProcessing.value = false
  }
}

// ── Wave 5 W3 — Withdraw flow (mhUSDC → USDC) ───────────────────────────

/**
 * Phase 1 of a direct mhUSDC → USDC withdrawal. Burns
 * `min(balance, requested)` mhUSDC (the contract clamps via FHE.min — an
 * over-request takes the full balance, not zero, so a "Max" affordance is
 * naturally safe even if the user enters a stale balance) and requests
 * async coprocessor decryption of the burned amount. Returns a `claimId`
 * that gets appended to the pending list; the user (or a future auto-claim
 * poller) calls `claimUsdc(claimId)` once decrypt lands.
 *
 * Error mapping is intentionally explicit for the two recoverable contract
 * reverts the user might hit:
 *   - `UsdcReserveNotSet` — pre-cutover state; should be impossible on prod
 *     once the seed runbook ran, but kept as a guard.
 *   - `TooManyPendingWithdrawals` (cap 64/user) — user must claim or wait
 *     for an existing claim to settle before opening a new one.
 *   - `NoBalance` — user has no mhUSDC; the form already disables submit
 *     in this case via `hasMhUsdcBalance`, but the contract revert is the
 *     authoritative gate.
 *   - `PausedSurface` — wrapper-wide pause; affects wrap + transfer too.
 */
async function handleWithdraw() {
  if (!withdrawAmount.value || withdrawIsProcessing.value || !address.value) return
  if (!wrapperAvailable.value) {
    withdrawErrMsg.value = 'MuHavenStable wrapper not configured for this build.'
    return
  }
  withdrawIsProcessing.value = true
  withdrawErrMsg.value = null

  try {
    // mhUSDC + USDC are both 6-decimal — same scaling, no rate conversion.
    const amountUnits = BigInt(Math.round(numericWithdrawAmount.value * 1_000_000))
    if (amountUnits <= 0n) throw new Error('Amount must be positive')

    await initFhe()
    const ctx = await buildWriteContext()
    const stable = new StableClient(ctx, v35Addresses.muHavenStable)
    const eph = getEphemeralEOA() as `0x${string}`

    const { hash, claimId } = await stable.withdrawToUsdc(amountUnits, eph)
    withdrawTxHash.value = hash

    if (claimId !== null) {
      // Optimistically append to the pending list so the user sees the new
      // row immediately (no need to wait for a re-fetch + RPC round-trip).
      // The re-discovery on next mount picks it up authoritatively. A poll
      // tick fires `withdrawDecryptResult(claimId)` within 5s to flip
      // `ready` once the coprocessor catches up.
      // W3 Phase 8: optimistic add — ready immediately. The
      // decrypt+publish runs inside `claimWithdrawal` when the user
      // taps Claim (or auto-fires below for same-session burns).
      const optimisticClaim = {
        claimId,
        ready: true,
        amount: null,
        claiming: false,
        errMsg: null,
      } as const
      pendingClaims.value = [...pendingClaims.value, { ...optimisticClaim }]
      ensurePollingActive()

      // W3 Phase 8.1 — auto-claim immediately after a successful burn.
      // The same-session ephemeralEOA is in the burn handle's ACL grant
      // (`FHE.allow(burnAmount, ephemeralEOA)` from `withdrawToUsdc`), so
      // the off-chain `decryptForTx` permit verification + on-chain
      // `publishDecryptResult` + `claimUsdc` can all run back-to-back
      // without an extra user tap. Total UX collapses to one passkey
      // sign for the burn (the decrypt + publish + claim all sign via
      // the kernel's already-mounted session). The pending-claim list
      // entry stays put as a fallback if any leg fails — the user can
      // retry from the list.
      //
      // Find the live ref in pendingClaims after the append (the array
      // was rebuilt so `optimisticClaim` is a different object).
      const live = pendingClaims.value.find((c) => c.claimId === claimId)
      if (live) {
        // Don't `await` — let the burn-success toast render first, then
        // claimWithdrawal updates the list / fires its own toasts on
        // success or error. Errors stay scoped to the claim row.
        toast.info('Settling your USDC…', {
          description: 'Decrypting the burned amount and publishing the result on-chain.',
        })
        void claimWithdrawal(live)
      }
    } else {
      // Defensive: the SDK returns null only if the receipt had no
      // WithdrawRequested log (shouldn't happen on a successful tx). The
      // burn still happened on-chain; surface a clear recovery instruction.
      console.warn('[CashPage] withdrawToUsdc tx returned null claimId — receipt missing event')
      withdrawErrMsg.value =
        'Withdrawal submitted but the claim id was not in the receipt. ' +
        'Refresh the page — pending claims will re-discover from the chain.'
    }

    withdrawSuccess.value = true
    toast.success('Withdrawal requested', {
      description: 'Burning mhUSDC. Auto-claim runs immediately if the same session signed the burn.',
    })
    // Refresh mhUSDC display — the burn already dropped the encrypted
    // balance handle, but only the user can decrypt the new value.
    if (portfolio.pusdcConfidentialBalance !== null && address.value) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  } catch (e) {
    // Same chain-walk diagnostic as the cash wrap — surfaces the underlying
    // viem / sender error instead of just the top-level TxFailedError.
    console.error('[CashPage] withdrawToUsdc failed — full chain:')
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      if (cur instanceof Error) {
        console.error(`  [${depth}] ${cur.constructor.name}:`, cur)
        const next = (cur as Error & { cause?: unknown }).cause
        if (next) { cur = next; depth += 1; continue }
      } else {
        console.error(`  [${depth}] ${typeof cur}:`, cur)
      }
      break
    }
    withdrawErrMsg.value = withdrawErrorMessage(e)
    toast.error('Withdrawal failed', { description: withdrawErrMsg.value })
  } finally {
    withdrawIsProcessing.value = false
  }
}

/**
 * Settle a pending claim: read the coprocessor result and (if ready) pay
 * USDC from the wrapper reserve to the user. Permissionless on-chain — the
 * funds always go to the original requester, so a stranger could in
 * principle settle on the user's behalf; we still surface a Claim button
 * because there's no backend auto-claim poller in W3 (deferred per plan).
 *
 * The two recoverable reverts get user-readable copy + KEEP the claim in
 * the pending list (the burn already happened; the claim is retriable):
 *   - `WithdrawClaimNotReady` — decrypt hasn't landed yet; should be
 *     unreachable because the button is disabled until `ready === true`,
 *     but defensive.
 *   - `ReserveInsufficient` — reserve drained; owner must top up. The
 *     wrapper preserves the claim state (only effects + transfer happen
 *     after the sufficiency check) so a retry once the reserve is topped
 *     up settles cleanly.
 *   - `ClaimsPaused` — settlement kill-switch engaged by owner.
 */
async function claimWithdrawal(claim: PendingClaim) {
  if (claim.claiming || !claim.ready) return
  claim.claiming = true
  claim.errMsg = null

  try {
    await initFhe()
    const ctx = await buildWriteContext()
    const stable = new StableClient(ctx, v35Addresses.muHavenStable)

    // ── W3 Phase 8 — client-driven decrypt + publish before claim ──────
    //
    // The deployed cofhe coprocessor on Arb Sepolia does NOT auto-publish
    // decrypt results in response to on-chain `AllowedForDecryption`
    // events (empirically verified 2026-05-29: only 1 such event in 5.5h
    // prod-wide, zero matching publishes). The actual prod cofhe flow
    // requires the client to (a) fetch the decrypted value + Threshold
    // Network signature via `cofheClient.decryptForTx(handle)`, and
    // (b) submit it on-chain via `TaskManager.publishDecryptResult`
    // BEFORE the contract reader (here: `MuHavenStable.claimUsdc`'s
    // internal `FHE.getDecryptResultSafe`) can return `ready=true`.
    //
    // Reference: `development/DEV_WAVE_5/W3_PHASE_8_PLAN.md` and
    // https://cofhe-docs.fhenix.zone/tutorials/migrating-from-fhe-decrypt.md.
    //
    // The poll-driven local `ready` flag is OPTIMISTIC — it polls
    // `getDecryptResultSafe` which won't return ready until step (b)
    // lands. So `claim.ready === true` here means EITHER (i) someone
    // else (another tab, a relayer, the mock TM auto-publish in tests)
    // already published OR (ii) the user has already attempted this
    // claim's publish. Either way we re-attempt the decrypt + publish
    // path defensively; an already-published handle reverts on TM and
    // we treat that as success (the result is in storage either way).
    //
    // Read the burn handle from the claim record. Belt-and-suspenders:
    // we have the handle in the WithdrawRequested event indexed at
    // load time too, but reading the storage record is simpler than
    // threading it through the PendingClaim model.
    const claimRecord = await MuHavenStableService.getWithdrawClaim(claim.claimId)
    if (isUnmounted) return
    const handle = claimRecord.handle as `0x${string}`

    // Step (a): off-chain decrypt via Threshold Network.
    //
    // 403 on first try usually means the active session's ephemeralEOA
    // ISN'T in the burn handle's ACL — happens when the burn was signed
    // by a prior session (different in-memory eph key, regenerated on
    // each page reload per `useFhe.ensureEphemeralKey`). The contract's
    // `refreshAuditGrant(handle, eph)` re-stamps the new eph onto the
    // historical handle (gated by `FHE.isAllowed(handle, msg.sender)`
    // so only the rightful claim recipient can call it), then a retry
    // succeeds. Same shape as `useFhe.decryptForView`'s 403 fallback
    // for `kind: 'mhUsdcAudit'`.
    let decryptedValue: bigint
    let signature: `0x${string}`
    const tryDecrypt = async () => decryptForTxWithPermit(handle)
    try {
      const r = await tryDecrypt()
      if (isUnmounted) return
      decryptedValue = r.decryptedValue
      signature = r.signature
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const is403 = /HTTP 403/i.test(m) || /Forbidden/i.test(m) || /403/.test(m)
      if (!is403) {
        throw new Error(
          `Decrypt request failed: ${m}. Try refreshing the page and retrying.`,
        )
      }
      // Cross-session ACL refresh — re-grant the new eph access to the
      // burn handle, then retry. Idempotent: a redundant grant is a
      // no-op at the FHE precompile.
      const eph = getEphemeralEOA()
      try {
        await MuHavenStableService.refreshAuditGrant(handle, eph)
        if (isUnmounted) return
      } catch (refreshErr) {
        throw new Error(
          `Decrypt request failed (HTTP 403), and the on-chain ACL refresh ` +
          `also failed: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}. ` +
          `If you re-logged in since the withdraw, try the session that signed the burn.`,
        )
      }
      try {
        const r = await tryDecrypt()
        if (isUnmounted) return
        decryptedValue = r.decryptedValue
        signature = r.signature
      } catch (retryErr) {
        const rm = retryErr instanceof Error ? retryErr.message : String(retryErr)
        throw new Error(
          `Decrypt retry after ACL refresh still failed: ${rm}. ` +
          `Try refreshing the page; if it persists, the burn-time ` +
          `session EOA may have been on a different device.`,
        )
      }
    }

    // Step (b): publish the signed result on-chain. Idempotent at the
    // TaskManager level — a second publish for the same handle reverts
    // (we treat it as "already published, continue").
    try {
      await TaskManagerService.publishDecryptResult(handle, decryptedValue, signature)
      if (isUnmounted) return
    } catch (e) {
      const m = walkErrorMessage(e)
      // "result is already published" / "DecryptResultAlreadyPublished" /
      // any storage-already-set revert — keep going. The contract reader
      // will see the result from the prior publish.
      if (
        /already\s*(published|recorded|set)/i.test(m)
        || /DecryptResultAlreadyPublished/i.test(m)
      ) {
        console.warn('[CashPage] publishDecryptResult: handle already published — continuing')
      } else {
        throw new Error(
          `Publishing the decryption result failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }

    // Step (c): existing claim settlement. `claimUsdc` reads
    // `FHE.getDecryptResultSafe(handle)` which now resolves to the value
    // we just published.
    const hash = await stable.claimUsdc(claim.claimId)
    if (isUnmounted) return

    // Settled — remove from the pending list. The contract pruned the
    // claimId from `_userWithdrawClaims[caller]` (swap-pop), so a fresh
    // `getUserWithdrawClaims` on next mount agrees with this local state.
    pendingClaims.value = pendingClaims.value.filter((c) => c.claimId !== claim.claimId)
    if (pendingClaims.value.length === 0) stopPolling()

    toast.success('USDC claimed', {
      description: claim.amount !== null
        ? `${formatBase6(claim.amount)} USDC transferred to your wallet.`
        : 'USDC transferred to your wallet.',
      action: { label: 'View tx', onClick: () => window.open(arbiscanTx(hash), '_blank') },
    })

    // Refresh USDC + mhUSDC tiles in the aside.
    void loadBalances()
    if (portfolio.pusdcConfidentialBalance !== null && address.value) {
      void portfolio.decryptPusdc(address.value as `0x${string}`)
    }
  } catch (e) {
    if (isUnmounted) return
    console.error('[CashPage] claimUsdc failed — full chain:')
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      if (cur instanceof Error) {
        console.error(`  [${depth}] ${cur.constructor.name}:`, cur)
        const next = (cur as Error & { cause?: unknown }).cause
        if (next) { cur = next; depth += 1; continue }
      } else {
        console.error(`  [${depth}] ${typeof cur}:`, cur)
      }
      break
    }
    // Round-2 (CR L-3) — `WithdrawClaimAlreadyClaimed` is a benign two-tab
    // race (or a stale-row replay); surface it as info, not red error, and
    // auto-refresh so the orphan row disappears. The error mapper already
    // emits user-friendly copy ("This claim was already settled. Refresh
    // to update the list.") — promote it to an actionable info toast.
    const errStr = walkErrorMessage(e)
    if (/WithdrawClaimAlreadyClaimed/i.test(errStr)) {
      toast.info('Claim already settled', {
        description: 'This claim was settled in another session. Refreshing the list…',
      })
      void loadPendingClaims()
      return
    }
    const msg = claimErrorMessage(e)
    // Re-find by stable claimId in case loadPendingClaims rebuilt the array
    // mid-await (orphan-reference safety — same pattern as pollPendingDecrypts).
    const live = pendingClaims.value.find((c) => c.claimId === claim.claimId)
    if (live) live.errMsg = msg
    toast.error('Claim failed', { description: msg })
  } finally {
    // Round-2 (CR L-2) — dropped the dead `else claim.claiming = false`
    // branch. The two real cases are handled correctly: (a) success path
    // pruned the claim → row is gone from the UI, no-op needed; (b) error
    // path keeps the claim, `find()` returns the live row, clear the flag.
    if (!isUnmounted) {
      const live = pendingClaims.value.find((c) => c.claimId === claim.claimId)
      if (live) live.claiming = false
    }
  }
}

/** Re-discover the user's pending claims from chain. Called on mount + on
 *  account-switch. Settled claims are pruned by the contract from the
 *  per-user list, so this is always "what's still owed".
 *
 *  Per-claim: fetch `withdrawDecryptResult(claimId)` to populate `ready` +
 *  `amount` (or leave `amount=null` while the decrypt is still in flight).
 *  The kill-switch `claimsPaused()` is read once and surfaced as a banner
 *  (the per-row Claim button stays clickable but the user sees why claims
 *  would currently revert ClaimsPaused on broadcast). */
async function loadPendingClaims(): Promise<void> {
  // Round-2 (CR H-1) — coalesce concurrent callers onto a single in-flight
  // promise. Returns the same promise to all callers so the Refresh button
  // can `await` it for a future loading-state indicator.
  if (inFlightDiscovery) return inFlightDiscovery
  inFlightDiscovery = (async () => {
    await loadPendingClaimsImpl()
  })().finally(() => { inFlightDiscovery = null })
  return inFlightDiscovery
}

async function loadPendingClaimsImpl() {
  if (!address.value || !wrapperAvailable.value) {
    pendingClaims.value = []
    stopPolling()
    return
  }
  pendingDiscoveryError.value = null
  // Best-effort reads of the two pause flags — informational + drives the
  // banners + the submit-button disabled state. Failures degrade silently
  // (banners hide); a console.warn helps debugging if the stale `false`
  // surprises an operator (round-2 CR L-4).
  // Read both pause flags in the SAME tick so multicall folds them into one
  // aggregate eth_call (they were two sequential awaits → two round-trips, and
  // loadPendingClaims now re-runs on every /cash re-entry under keep-alive).
  // allSettled keeps the per-flag silent-degrade contract (a failed read hides
  // its banner; the console.warn helps if a stale `false` surprises an
  // operator — round-2 CR L-4).
  const [claimsRes, pausedRes] = await Promise.allSettled([
    MuHavenStableService.claimsPaused(),
    MuHavenStableService.paused(),
  ])
  if (claimsRes.status === 'fulfilled') claimsKillSwitch.value = claimsRes.value
  else console.warn('[CashPage] claimsPaused read failed', claimsRes.reason)
  if (pausedRes.status === 'fulfilled') wrapperPaused.value = pausedRes.value
  else console.warn('[CashPage] paused read failed', pausedRes.reason)

  try {
    const ids = await MuHavenStableService.getUserWithdrawClaims(address.value as `0x${string}`)
    if (ids.length === 0) {
      pendingClaims.value = []
      stopPolling()
      return
    }
    // Batch the per-claim decrypt reads in parallel — `Promise.all` is fine
    // for typical pending-count (<= MAX_PENDING_WITHDRAWALS=64). Failures
    // per-claim degrade to "pending unknown" rather than nuking the list.
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await MuHavenStableService.withdrawDecryptResult(id)
          // W3 Phase 8: a claim is always actionable as soon as it's
          // discovered — the client-driven decrypt+publish happens inside
          // `claimWithdrawal` itself, not on a poll. If `getDecryptResultSafe`
          // happens to return ready (someone else published, or the test
          // mock auto-published), we surface the amount preemptively.
          return { id, ready: true, amount: r.ready ? r.amount : null }
        } catch (e) {
          console.warn('[CashPage] withdrawDecryptResult read failed for claim', id, e)
          // Even on read failure, the claim is still actionable — the
          // client-driven flow re-decrypts at claim time and will
          // surface any real error then.
          return { id, ready: true, amount: null }
        }
      }),
    )
    // Preserve the in-flight `claiming` flag for any existing row so a
    // re-discovery during an in-flight claim doesn't reset the spinner.
    const prev = new Map(pendingClaims.value.map((c) => [c.claimId, c]))
    pendingClaims.value = results.map((r) => {
      const existing = prev.get(r.id)
      return {
        claimId: r.id,
        ready: r.ready,
        amount: r.amount,
        claiming: existing?.claiming ?? false,
        errMsg: existing?.errMsg ?? null,
      }
    })
    ensurePollingActive()
  } catch (e) {
    console.warn('[CashPage] pending-claim discovery failed', e)
    pendingDiscoveryError.value = e instanceof Error ? e.message : 'Failed to load pending claims'
  }
}

/** Refresh the `ready` + `amount` fields on any pending claim that's not
 *  yet ready. Called on a 5s interval while any non-ready claim exists.
 *  Skipping ready/claiming rows reduces RPC chatter; the interval stops
 *  itself once every row is ready. */
async function pollPendingDecrypts() {
  if (!wrapperAvailable.value) return
  const targets = pendingClaims.value.filter((c) => !c.ready)
  if (targets.length === 0) {
    stopPolling()
    return
  }
  await Promise.all(
    targets.map(async (claim) => {
      try {
        const r = await MuHavenStableService.withdrawDecryptResult(claim.claimId)
        // Round-2 (FE Dev HIGH) — short-circuit if the component unmounted
        // mid-await; the toast.success would otherwise fire for a page the
        // user already navigated away from.
        if (isUnmounted) return
        // Re-find the claim in the CURRENT list before mutating — a
        // concurrent `loadPendingClaims()` (Refresh button, address change,
        // route revisit) may have reassigned `pendingClaims.value` with
        // brand-new PendingClaim objects mid-await, leaving `claim` as an
        // orphaned reference whose writes never reach the template. Match
        // by `claimId` (the stable identity); if the user has since
        // claimed/settled and the id is gone, the toast just doesn't fire.
        const live = pendingClaims.value.find((c) => c.claimId === claim.claimId)
        if (!live) return
        if (r.ready && !live.ready) {
          live.ready = true
          live.amount = r.amount
          toast.success('USDC ready to claim', {
            description: `${formatBase6(r.amount)} USDC unlocked — tap Claim below.`,
          })
        }
      } catch (e) {
        // Per-claim transient read failure — keep polling; don't surface
        // a toast for every blip (RPC dropouts on Arb Sepolia are common).
        console.warn('[CashPage] poll withdrawDecryptResult failed', claim.claimId, e)
      }
    }),
  )
  // Re-evaluate; if everything is now ready, kill the interval.
  if (pendingClaims.value.every((c) => c.ready)) stopPolling()
}

function ensurePollingActive() {
  // WS-1 — never arm (or re-arm) the claim poll on a backgrounded kept-alive
  // page. An in-flight loadPendingClaims that resolves AFTER onDeactivated
  // would otherwise restart the 5s interval on a hidden page. onActivated
  // re-runs loadPendingClaims (→ here) on re-entry, so polling resumes then.
  if (!isActive.value) return
  if (claimPollTimer) return
  if (pendingClaims.value.every((c) => c.ready)) return // nothing to wait for
  claimPollTimer = setInterval(() => { void pollPendingDecrypts() }, CLAIM_POLL_INTERVAL_MS)
}

function stopPolling() {
  if (claimPollTimer) {
    clearInterval(claimPollTimer)
    claimPollTimer = null
  }
}

function resetWithdrawForm() {
  withdrawAmount.value = ''
  withdrawSuccess.value = false
  withdrawTxHash.value = null
  withdrawErrMsg.value = null
  // Round-2 (A11y F7) — after the user dismisses success/error, the form
  // re-mounts. Move focus to the amount input so SR + keyboard users land
  // on the primary entry point of the freshly-rendered form.
  void focusElement(withdrawAmountInputRef.value)
}

/** Pre-fill the withdraw input with the user's decrypted mhUSDC balance.
 *  Round-2 (CR M-3) — formats from bigint directly (NOT via Number()) to
 *  preserve 6-decimal precision end-to-end. The handler that parses the
 *  input on submit still goes via parseFloat, so a sub-6-dp round-trip is
 *  the only precision loss; the contract's FHE.min clamp absorbs any
 *  slight under-request (burns less) or over-request (burns the full
 *  balance). */
function setWithdrawMax() {
  const bal = portfolio.pusdcConfidentialBalance
  if (bal === null || bal === undefined || bal <= 0n) return
  const whole = bal / 1_000_000n
  const frac = (bal % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  withdrawAmount.value = frac.length === 0 ? whole.toString() : `${whole}.${frac}`
}

/** Map a thrown error from `withdrawToUsdc` to user-readable copy. Walks
 *  the cause chain looking for known contract-revert markers. Falls back
 *  to the raw message. */
function withdrawErrorMessage(e: unknown): string {
  const m = walkErrorMessage(e)
  if (/UsdcReserveNotSet/i.test(m)) {
    return 'The USDC reserve is not configured yet — contact the operator. (UsdcReserveNotSet)'
  }
  if (/TooManyPendingWithdrawals/i.test(m)) {
    return 'You\'ve hit the per-user cap of 64 pending withdrawals. Claim or wait for one to settle before opening another.'
  }
  if (/NoBalance/i.test(m)) {
    return 'You have no mhUSDC to withdraw. Convert USDC first.'
  }
  if (/PausedSurface/i.test(m) || /\bPaused\b/i.test(m)) {
    return 'The wrapper is currently paused — withdrawals + wraps are temporarily disabled.'
  }
  if (/InvalidEphemeralEOA/i.test(m)) {
    return 'No active session — sign in again to refresh your ephemeral key.'
  }
  return m || 'Withdrawal failed.'
}

/** Map a thrown error from `claimUsdc` to user-readable copy. */
function claimErrorMessage(e: unknown): string {
  const m = walkErrorMessage(e)
  if (/ReserveInsufficient/i.test(m)) {
    return 'The wrapper\'s USDC reserve is short right now — the claim is retriable. ' +
      'The operator has been notified; try again in a few minutes.'
  }
  if (/ClaimsPaused/i.test(m)) {
    return 'Settlement is temporarily halted (operator kill-switch). The claim is retriable once it\'s lifted.'
  }
  if (/WithdrawClaimNotReady/i.test(m)) {
    return 'The decryption hasn\'t landed yet — wait a few seconds and try again.'
  }
  if (/WithdrawClaimAlreadyClaimed/i.test(m)) {
    return 'This claim was already settled. Refresh to update the list.'
  }
  if (/WithdrawClaimNotFound/i.test(m)) {
    return 'No matching claim on-chain — refresh to re-discover.'
  }
  return m || 'Claim failed.'
}

function walkErrorMessage(e: unknown): string {
  let cur: unknown = e
  let depth = 0
  const seen: string[] = []
  while (cur && depth < 8) {
    if (cur instanceof Error) {
      if (cur.message) seen.push(cur.message)
      const next = (cur as Error & { cause?: unknown }).cause
      if (next) { cur = next; depth += 1; continue }
    } else if (typeof cur === 'string') {
      seen.push(cur)
    }
    break
  }
  return seen.join(' :: ')
}

/** Format a base-6 USDC amount as a $X.XX string for display. */
function formatBase6(units: bigint): string {
  const dollars = Number(units) / 1_000_000
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
}

/** Round-2 (A11y F4) — click guard for the Claim button when it carries
 *  `aria-disabled` instead of native `disabled` (so the button stays
 *  focusable + the contextual aria-label is reachable). The guards mirror
 *  the visual `disabled` state below. */
function tryClaimWithdrawal(claim: PendingClaim) {
  if (!claim.ready || claim.claiming || claimsKillSwitch.value) return
  void claimWithdrawal(claim)
}

/** Round-2 (A11y F10) — sort pending claims with ready-to-claim first,
 *  then by ascending claimId. Reduces cognitive load for screen-reader
 *  users: actionable rows surface at the top of the list. */
const sortedPendingClaims = computed(() =>
  [...pendingClaims.value].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1
    return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0
  }),
)

/** Round-2 (A11y F7) — focus a target on the next render tick. Accepts
 *  either an HTMLElement directly OR a Vue component instance (in which
 *  case we unwrap its `.$el` to reach the underlying DOM). Defensive:
 *  noops if the target hasn't mounted yet (state swap is mid-frame).
 *  `focus()` lets the browser scroll the element into view if offscreen,
 *  which is the right behavior for a success/error card that just appeared. */
async function focusElement(target: HTMLElement | { $el?: HTMLElement } | null) {
  if (!target) return
  await nextTick()
  const el = (target as { $el?: HTMLElement }).$el ?? (target as HTMLElement)
  if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus()
}

// Move focus on withdraw success/error transitions so screen-reader users
// land on the relevant action button without a focus reset to <body>.
watch(withdrawSuccess, (isSuccess) => {
  if (isSuccess) void focusElement(withdrawAgainButtonRef.value)
})
watch(withdrawErrMsg, (msg) => {
  if (msg) void focusElement(withdrawTryAgainButtonRef.value)
})

/** Existing RWA wrap — underlying ERC-20 → fhERC-20 via MuHavenVault. */
async function handleAssetWrap() {
  if (!amount.value || isProcessing.value || !address.value) return
  isProcessing.value = true
  errMsg.value = null

  try {
    const amountWei = BigInt(Math.floor(numericAmount.value * 1e18))

    currentStep.value = 0
    const underlying = await VaultService.underlyingToken()
    await Erc20Service.approve(underlying, addresses.muHavenVault, amountWei)

    currentStep.value = 1
    const hash = await VaultService.wrap(amountWei)

    txHash.value = hash
    showSuccess.value = true
    toast.success('Wrap confirmed', {
      description: 'ERC-20 wrapped into fhERC-20 — balance now encrypted on-chain',
    })
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'Wrap failed'
    toast.error('Wrap failed', { description: errMsg.value })
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
}

// ── Send flow (cleartext USDC → external address) ───────────────────────

/** Clear every send-form ref back to the initial state. Used by setDirection
 *  (on toggle), resetSendForm (after success/error), and the account-switch
 *  teardown — so a stale recipient/amount never bleeds across directions or
 *  sessions. */
function resetSendState() {
  sendRecipient.value = ''
  sendAmount.value = ''
  sendStep.value = 'form'
  sendIsProcessing.value = false
  sendSuccess.value = false
  sendTxHash.value = null
  sendErrMsg.value = null
}

/** Advance from the form to the inline confirm step. Re-validates first so a
 *  late balance change (another tab spent USDC) can't slip a now-over-balance
 *  amount into review. Focuses the Confirm button for keyboard/SR users. */
function reviewSend() {
  if (!sendCanSubmit.value) return
  sendErrMsg.value = null
  sendStep.value = 'confirm'
  void focusElement(sendConfirmButtonRef.value)
}

/** Back out of confirm to the editable form (keeps the entered values). */
function backToSendForm() {
  sendStep.value = 'form'
  void focusElement(sendRecipientInputRef.value)
}

/** Pre-fill the send amount with the full cleartext USDC balance. */
function setSendMax() {
  if (usdcBalance.value === null || usdcBalance.value <= 0n) return
  sendAmount.value = formatUnits(usdcBalance.value, 6)
}

/**
 * Execute the send: a plain `USDC.transfer(to, amount)` UserOp from the kernel.
 * Re-validates the recipient + balance at submit time (the confirm step may
 * have sat a while) so we never broadcast a self/zero/over-balance transfer.
 * On success: toast with an Arbiscan link + a MANUAL balance refresh (the
 * inbound watcher only catches transfers TO the kernel, not outbound).
 */
async function handleSend() {
  if (sendIsProcessing.value || !address.value) return
  if (!sendCanSubmit.value) return

  sendIsProcessing.value = true
  sendErrMsg.value = null

  try {
    const units = sendAmountUnits.value
    if (units === null || units <= 0n) throw new Error('Enter a valid amount.')
    // Re-check the balance cap at broadcast time — usdcBalance may have moved
    // since the confirm step was entered.
    if (usdcBalance.value === null || units > usdcBalance.value) {
      throw new Error('Amount exceeds your current USDC balance. Refresh and try again.')
    }
    const to = getAddress(sendRecipient.value.trim())
    // Defensive re-guards (the computeds already gate the button, but the
    // confirm step decouples validation from submission).
    if (isZeroAddress(to)) throw new Error('Cannot send to the zero address.')
    if (to === getAddress(address.value as `0x${string}`)) {
      throw new Error('Cannot send to your own wallet.')
    }

    const hash = await Erc20Service.transfer(addresses.usdc, to, units)
    sendTxHash.value = hash
    sendSuccess.value = true
    sendStep.value = 'form'
    toast.success('USDC sent', {
      description: `${sendAmountDisplay.value} USDC sent to ${to.slice(0, 6)}…${to.slice(-4)}.`,
      action: { label: 'View tx', onClick: () => window.open(arbiscanTx(hash), '_blank') },
    })
    // The inbound watcher fires only on Transfer TO the kernel — an outbound
    // send won't trigger it, so refresh the USDC tile manually.
    void loadBalances()
  } catch (e) {
    // Same cause-chain diagnostic as the wrap/withdraw handlers — surfaces the
    // underlying viem / sender error instead of just the top-level wrapper.
    console.error('[CashPage] USDC send failed — full chain:')
    let cur: unknown = e
    let depth = 0
    while (cur && depth < 8) {
      if (cur instanceof Error) {
        console.error(`  [${depth}] ${cur.constructor.name}:`, cur)
        const nextCause = (cur as Error & { cause?: unknown }).cause
        if (nextCause) { cur = nextCause; depth += 1; continue }
      } else {
        console.error(`  [${depth}] ${typeof cur}:`, cur)
      }
      break
    }
    sendErrMsg.value = e instanceof Error ? e.message : 'Send failed'
    toast.error('Send failed', { description: sendErrMsg.value })
  } finally {
    sendIsProcessing.value = false
  }
}

/** Reset after a success/error to a fresh empty form. */
function resetSendForm() {
  resetSendState()
  void focusElement(sendRecipientInputRef.value)
}

// Move focus on send success/error transitions so screen-reader users land on
// the relevant action button without a focus reset to <body>.
watch(sendSuccess, (isSuccess) => {
  if (isSuccess) void focusElement(sendAgainButtonRef.value)
})
watch(sendErrMsg, (msg) => {
  if (msg) void focusElement(sendTryAgainButtonRef.value)
})

// CR review MEDIUM-2 — if the amount/recipient stops being submittable WHILE
// the user is on the confirm sub-step (e.g. the USDC balance dropped underneath
// via the safety poll / inbound watcher / another tab), bounce back to the
// editable form. The Confirm button already disables reactively (it gates on
// `sendCanSubmit`) and handleSend re-checks at broadcast, so there's no
// fund-safety risk — this is the clarity fix: the confirm card has no
// over-balance banner, so a silently-greyed button would be confusing. Back on
// the form, the live `sendOverBalance` hint explains why.
watch(sendCanSubmit, (ok) => {
  if (!ok && sendStep.value === 'confirm') sendStep.value = 'form'
})

// ── Mode-aware copy ────────────────────────────────────────────────────

const headerTitle = computed(() =>
  mode.value === 'cash' ? 'Convert USDC to mhUSDC' : 'Vault Wrap',
)
const headerSubtitle = computed(() =>
  mode.value === 'cash'
    ? 'Convert your Circle USDC into encrypted mhUSDC. Required once before your first purchase — subsequent buys spend your existing mhUSDC.'
    : 'Wrap an existing RWA ERC-20 into a confidential fhERC-20.',
)
const amountLabel = computed(() =>
  mode.value === 'cash' ? 'Amount (USDC)' : 'Amount (18 decimals)',
)
const ctaLabel = computed(() => {
  if (isProcessing.value) return mode.value === 'cash' ? 'Converting…' : 'Wrapping…'
  return mode.value === 'cash' ? 'Convert to mhUSDC' : 'Approve & Wrap'
})
const successTitle = computed(() =>
  mode.value === 'cash' ? 'mhUSDC ready' : 'Wrap confirmed',
)
const successCopy = computed(() =>
  mode.value === 'cash'
    ? 'USDC converted 1:1 into mhUSDC — your balance is encrypted to this session and ready to spend on the Trade page.'
    : 'ERC-20 wrapped into fhERC-20 — your balance is now encrypted on-chain.',
)
</script>

<template>
  <div>
    <div class="xl:mr-80">
      <!-- ── Anti-layout-shift gate ───────────────────────────────────
           Both the welcome ribbon and the convert card mount only after
           `balancesLoaded` flips true. This guarantees they commit to a
           layout in the same tick — without the gate the convert card
           animated in alone, then the ribbon mounted ~half a second
           later when the USDC RPC resolved and pushed the card down,
           which read as a layout bug. The gate also drives the
           ribbon-vs-card stagger on the convert card's :visible-once
           (delay: 120ms when first-run, 0ms otherwise — under the
           ~150ms perceptual-grouping threshold so the eye reads the
           pair as one composition, not two events). -->
      <template v-if="balancesLoaded">
      <!-- ── Issuer context card — issuer role only ─────────────────
           Surfaces in-flight epochs + a top-up affordance that
           autofills the convert form below. Lives above the welcome
           ribbon so issuers see the operating-cash framing first.
           Investor view skips this card entirely. -->
      <IssuerContextCard
        v-if="mode === 'cash' && isIssuer && !showSuccess && !errMsg"
        class="max-w-2xl mx-auto mb-6"
        @autofill="handleIssuerAutofill"
      />

      <!-- ── Welcome ribbon — investor first-run only ──────────────────
           Shown when USDC=0 and platform mhUSDC empty: a gentle two-step
           pointer (fund right-aside → convert below). Hidden once the
           user has any balance, so returning top-ups stay quiet. Issuer
           role gets the IssuerContextCard above instead. -->
      <section
        v-if="mode === 'cash' && !isIssuer && isFirstRun && !showSuccess && !errMsg"
        v-motion
        :initial="{ opacity: 0, y: 12 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 460 } }"
        data-testid="cash-welcome-ribbon"
        class="max-w-2xl mx-auto mb-6 rounded-2xl overflow-hidden
               border border-gold/25 dark:border-signal/20
               bg-gradient-to-br from-gold/8 via-mist/40 to-transparent
               dark:from-signal/8 dark:via-[#1c1b1b]/60 dark:to-transparent
               p-5 md:p-6"
      >
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-gold/15 dark:bg-signal/15 flex items-center justify-center shrink-0">
            <Sparkles :size="16" :stroke-width="1.8" class="text-gold dark:text-signal" />
          </div>
          <div class="flex flex-col gap-1.5">
            <h1 class="font-accent italic text-xl md:text-2xl text-midnight dark:text-white tracking-tight leading-tight">
              Welcome to MuHaven
            </h1>
            <p class="font-sans text-[13px] text-cool leading-relaxed">
              <span class="font-medium text-midnight dark:text-white">1.</span> Copy your wallet address (right) and tap
              <span class="font-medium text-midnight dark:text-white">Get test USDC</span> to receive testnet USDC.
              <br class="hidden md:block">
              <span class="font-medium text-midnight dark:text-white">2.</span> Convert USDC to <span class="font-mono text-[12px]">mhUSDC</span> below — encrypted cash you'll spend on the Trade page.
            </p>
          </div>
        </div>
      </section>

      <section
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: isFirstRun ? 120 : 0 } }"
        class="relative max-w-2xl mx-auto rounded-2xl overflow-hidden border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div aria-hidden="true"
             class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/60 dark:via-signal/50 to-transparent" />
        <div aria-hidden="true"
             class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none"
             :class="mode === 'cash' ? 'bg-compute/8 dark:bg-signal/8' : 'bg-gold/8 dark:bg-signal/8'" />

        <div class="p-8 md:p-10 relative">
          <!-- Wave 5 W3 — Direction toggle (Deposit / Withdraw). Cash mode
               only; hidden during in-flight + success + error states so the
               result card owns the card surface. The Withdraw side calls
               `MuHavenStable.withdrawToUsdc` → async claim → `claimUsdc`
               (paid in real USDC from the wrapper reserve). MCP deep-link
               `cash.unwrap` lands here via `?mode=unwrap`. -->
          <!-- Round-2 (A11y F1 + FE Dev HIGH): use the "toggle button group"
               pattern (role="group" + aria-pressed on each button) rather than
               the tablist pattern. No tabpanel exists (the "panel" is the rest
               of the card containing form/success/error states), so tablist
               semantics misled screen readers. aria-pressed announces the
               binary state correctly + each button stays in the natural
               Tab/Shift+Tab order without needing arrow-key handling. -->
          <!-- Wave 5 — 3-way direction: Deposit / Withdraw / Send. Per-button
               active gradient (no sliding pill — robust for 3 segments). Hidden
               while ANY flow is in-flight / succeeded / errored, and while the
               send flow is on its confirm sub-step (the user is reviewing). -->
          <div
            v-if="mode === 'cash' && !isProcessing && !showSuccess && !errMsg
              && !withdrawIsProcessing && !withdrawSuccess && !withdrawErrMsg
              && !sendIsProcessing && !sendSuccess && !sendErrMsg
              && !(direction === 'send' && sendStep === 'confirm')"
            data-testid="cash-direction-toggle"
            role="group"
            aria-label="Cash direction: deposit, withdraw, or send"
            class="relative inline-flex items-center gap-1 mb-6 flex-wrap
                   rounded-full border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#1c1b1b]/80 p-1
                   shadow-[inset_0_1px_2px_rgba(63,46,12,0.04)]
                   dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          >
            <button
              v-for="opt in directionOptions"
              :key="opt.value"
              type="button"
              :aria-pressed="direction === opt.value"
              @click="setDirection(opt.value)"
              :data-testid="`cash-direction-${opt.value}`"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-4 py-2 min-w-[112px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.18em] font-semibold cursor-pointer',
                'transition-all duration-200',
                direction === opt.value
                  ? 'text-midnight bg-gradient-to-r from-compute to-gold dark:from-signal dark:to-signal/85 shadow-[0_2px_10px_-2px_rgba(255,186,32,0.45)] dark:shadow-[0_2px_14px_-2px_rgba(255,220,161,0.35)]'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <component :is="opt.icon" :size="13" :stroke-width="2" aria-hidden="true" />
              {{ opt.label }}
            </button>
          </div>

          <!-- Mode toggle — investor view defaults to cash with the toggle
               hidden. Pass `?mode=asset` to surface the asset (vault wrap)
               flow alongside cash for issuer/dev use. -->
          <div
            v-if="!showSuccess && !errMsg && !withdrawSuccess && !withdrawErrMsg && showModeToggle"
            data-testid="wrap-mode-toggle"
            class="relative inline-flex items-center gap-1 mb-8
                   rounded-full border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#1c1b1b]/80 p-1
                   shadow-[inset_0_1px_2px_rgba(63,46,12,0.04)]
                   dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          >
            <div
              aria-hidden="true"
              class="absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full
                     bg-gradient-to-r transition-all duration-300 ease-out
                     shadow-[0_2px_10px_-2px_rgba(255,186,32,0.45)]
                     dark:shadow-[0_2px_14px_-2px_rgba(255,220,161,0.35)]"
              :class="[
                mode === 'cash'
                  ? 'left-1 from-compute to-gold dark:from-signal dark:to-signal/85'
                  : 'left-[calc(50%+0.05rem)] from-gold to-gold/90 dark:from-signal dark:to-signal/70',
              ]"
            />
            <button
              type="button"
              @click="setMode('cash')"
              :disabled="isProcessing"
              data-testid="wrap-mode-cash"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[130px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'cash'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Coins :size="13" :stroke-width="2" />
              Cash · mhUSDC
            </button>
            <button
              type="button"
              @click="setMode('asset')"
              :disabled="isProcessing"
              data-testid="wrap-mode-asset"
              :class="[
                'relative z-10 inline-flex items-center justify-center gap-2 px-5 py-2 min-w-[130px] rounded-full',
                'font-sans text-[11px] uppercase tracking-[0.22em] font-semibold cursor-pointer',
                'transition-colors duration-200',
                mode === 'asset'
                  ? 'text-midnight'
                  : 'text-cool hover:text-midnight dark:hover:text-white',
              ]"
            >
              <Layers :size="13" :stroke-width="2" />
              Asset · RWA
            </button>
          </div>

          <!-- ── Deposit branch (Cash + Asset) — existing form chain ── -->
          <template v-if="direction === 'deposit' || mode === 'asset'">
          <div v-if="showSuccess" data-testid="wrap-success-card" class="flex flex-col items-center gap-5 py-6">
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <p class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">{{ successTitle }}</p>
              <p class="font-sans text-sm text-cool max-w-md">{{ successCopy }}</p>
            </div>
            <p v-if="txHash" class="font-mono text-[11px] text-cool">
              tx:
              <a :href="arbiscanTx(txHash)" target="_blank" rel="noopener"
                 class="text-compute dark:text-signal hover:underline">
                {{ txHash.slice(0, 10) }}…{{ txHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" @click="resetForm">
              {{ mode === 'cash' ? 'Convert again' : 'Make another wrap' }}
            </MButton>
          </div>

          <div v-else-if="errMsg" data-testid="wrap-error-card" class="flex flex-col items-center gap-5 py-8">
            <div class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center">
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">Something went wrong</p>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ errMsg }}</p>
            <MButton variant="outline" @click="resetForm">Try again</MButton>
          </div>

          <div v-else class="flex flex-col gap-8">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center">
                <Shield :size="18" :stroke-width="1.8" />
              </div>
              <div>
                <p class="font-accent italic text-xl text-midnight dark:text-white leading-tight">{{ headerTitle }}</p>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">{{ headerSubtitle }}</p>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <label for="wrap-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                {{ amountLabel }}
              </label>
              <div class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2 transition-colors focus-within:border-gold dark:focus-within:border-signal">
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">$</span>
                <input
                  id="wrap-amount-input"
                  v-model="amount"
                  placeholder="0.00"
                  inputmode="decimal"
                  aria-label="Wrap amount"
                  :disabled="isProcessing"
                  data-testid="wrap-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button
                  v-for="qa in quickAmounts"
                  :key="qa"
                  type="button"
                  @click="amount = qa"
                  :disabled="isProcessing"
                  :data-testid="`wrap-quick-${qa}`"
                  class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                         bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                         text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                         border border-haze dark:border-white/10
                         px-3 py-1.5 rounded transition-all duration-200 cursor-pointer disabled:opacity-50"
                >
                  ${{ Number(qa).toLocaleString() }}
                </button>
              </div>
              <p
                v-if="mode === 'cash'"
                class="font-sans text-[10px] text-cool/80 leading-relaxed"
                data-testid="wrap-cash-hint"
              >
                1:1 backed: every USDC you wrap is held as collateral. Unwrap to USDC any time.
              </p>
            </div>

            <!-- Inline progress rail — visible only while a wrap is in
                 flight. Two pill steps (Approve → Mint) with active /
                 done state. Replaces the right-aside "Current Step"
                 section that lived statically on the page even when
                 nothing was happening. -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="isProcessing"
                data-testid="wrap-inline-rail"
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

            <button
              type="button"
              @click="handleSubmit"
              :disabled="isProcessing || !amount.trim() || numericAmount <= 0"
              data-testid="wrap-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="isProcessing" :size="16" class="animate-spin" />
              <Shield v-else :size="16" :stroke-width="2" />
              <span class="uppercase tracking-[0.18em]">{{ ctaLabel }}</span>
              <ArrowRight v-if="!isProcessing" :size="16" :stroke-width="2" />
            </button>
          </div>
          </template>

          <!-- ── Withdraw branch (Cash only) — Wave 5 W3 ───────────────── -->
          <template v-else-if="direction === 'withdraw'">
          <!-- Pause-state banners — visible across success / error / form
               states so the user always sees WHY their next action is
               blocked, not just at the form layer. `wrapperPaused()` blocks
               the request leg (deposit + withdraw); `claimsPaused()` only
               blocks the settle leg (claimUsdc). Either one renders a
               banner; both can show simultaneously. -->
          <!-- Round-2 (A11y F6): role="alert" so screen-readers preempt
               on mount — these are blocking conditions, not informational.
               Decorative AlertTriangle icons get aria-hidden so the SR
               announcement isn't "alert, alert, Wrapper is paused" (the
               role already conveys severity). -->
          <div
            v-if="wrapperPaused"
            data-testid="withdraw-wrapper-paused-banner"
            role="alert"
            class="mb-5 rounded-lg p-3 border border-amber-400/30 bg-amber-500/8 flex items-start gap-2.5"
          >
            <AlertTriangle :size="14" class="text-amber-500 flex-shrink-0 mt-0.5" :stroke-width="2" aria-hidden="true" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              <span class="font-semibold text-midnight dark:text-white">Wrapper is paused.</span>
              All wraps, transfers, and withdrawal requests are temporarily disabled.
              Existing pending claims can still be settled once the operator resumes the
              wrapper.
            </p>
          </div>
          <div
            v-if="claimsKillSwitch"
            data-testid="withdraw-kill-switch-banner"
            role="alert"
            class="mb-5 rounded-lg p-3 border border-amber-400/30 bg-amber-500/8 flex items-start gap-2.5"
          >
            <AlertTriangle :size="14" class="text-amber-500 flex-shrink-0 mt-0.5" :stroke-width="2" aria-hidden="true" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              <span class="font-semibold text-midnight dark:text-white">USDC settlement temporarily halted.</span>
              You can still request a withdrawal — your mhUSDC will burn and the claim will
              wait in the list below until the operator resumes settlement.
            </p>
          </div>

          <div v-if="withdrawSuccess" data-testid="withdraw-success-card" class="flex flex-col items-center gap-5 py-6">
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
              aria-hidden="true"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <h2 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                Withdrawal requested
              </h2>
              <p class="font-sans text-sm text-cool max-w-md">
                Your mhUSDC is burned and the coprocessor is decrypting the amount. Your USDC
                claim will appear in the list below; once it's ready (~30–60s), tap
                <span class="font-medium text-midnight dark:text-white">Claim</span> to receive
                the USDC into your wallet.
              </p>
            </div>
            <p v-if="withdrawTxHash" class="font-mono text-[11px] text-cool">
              tx:
              <a :href="arbiscanTx(withdrawTxHash)" target="_blank" rel="noopener"
                 class="text-compute dark:text-signal hover:underline">
                {{ withdrawTxHash.slice(0, 10) }}…{{ withdrawTxHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" ref="withdrawAgainButtonRef" @click="resetWithdrawForm">
              Withdraw again
            </MButton>
          </div>

          <div v-else-if="withdrawErrMsg" data-testid="withdraw-error-card" class="flex flex-col items-center gap-5 py-8">
            <div
              class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center"
              aria-hidden="true"
            >
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <h2 class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">Withdrawal failed</h2>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ withdrawErrMsg }}</p>
            <MButton variant="outline" ref="withdrawTryAgainButtonRef" @click="resetWithdrawForm">Try again</MButton>
          </div>

          <div v-else class="flex flex-col gap-8">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center"
                aria-hidden="true"
              >
                <ArrowUpFromLine :size="18" :stroke-width="1.8" />
              </div>
              <div>
                <h2 class="font-accent italic text-xl text-midnight dark:text-white leading-tight">
                  Withdraw mhUSDC to USDC
                </h2>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">
                  Burn your encrypted mhUSDC and receive real USDC into your wallet. Two-phase
                  for privacy: the burn fires now, the coprocessor decrypts the amount, then
                  you claim the USDC from the list below (~30–60s end-to-end).
                </p>
              </div>
            </div>

            <div class="flex flex-col gap-3">
              <label for="withdraw-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Amount (mhUSDC)
              </label>
              <div class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2 transition-colors focus-within:border-gold dark:focus-within:border-signal">
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">$</span>
                <!-- Round-2 (A11y F9): dropped redundant aria-label — the
                     visible <label for="…"> already names this input.
                     Round-2 (CR M-4): pattern + aria-describedby surface the
                     6-decimal precision limit so a power user typing 9 digits
                     of decimal won't be silently truncated. -->
                <input
                  id="withdraw-amount-input"
                  ref="withdrawAmountInputRef"
                  v-model="withdrawAmount"
                  placeholder="0.00"
                  inputmode="decimal"
                  pattern="^\d*(\.\d{0,6})?$"
                  aria-describedby="withdraw-amount-hint"
                  :disabled="withdrawIsProcessing"
                  data-testid="withdraw-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <!-- Round-2 (A11y F8): py-2 (≥28px) clears WCAG 2.2 AA 2.5.8
                     target-size minimum (24×24). Was py-1.5 (~22-24px). -->
                <button
                  type="button"
                  @click="setWithdrawMax"
                  :disabled="withdrawIsProcessing || !hasMhUsdcBalance"
                  data-testid="withdraw-max"
                  class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                         bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                         text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                         border border-haze dark:border-white/10
                         px-3 py-2 rounded transition-all duration-200 cursor-pointer
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  :title="hasMhUsdcBalance ? 'Withdraw your full mhUSDC balance' : 'Reveal your mhUSDC balance first to enable Max'"
                >
                  Max
                </button>
                <p
                  id="withdraw-amount-hint"
                  v-if="!hasMhUsdcBalance"
                  class="font-sans text-[10px] text-cool/80 leading-relaxed"
                  data-testid="withdraw-zero-balance-hint"
                >
                  Reveal your mhUSDC balance (right) to see what's withdrawable. Convert USDC first if you have none.
                </p>
                <p
                  id="withdraw-amount-hint"
                  v-else
                  class="font-sans text-[10px] text-cool/80 leading-relaxed"
                  data-testid="withdraw-cash-hint"
                >
                  1:1 unwrap, 6-decimal precision. Confidential balance, public payout —
                  every mhUSDC becomes one USDC paid from the protocol reserve.
                </p>
              </div>
            </div>

            <!-- Single-step rail — visible while in flight. The on-chain
                 path is one tx (burn + request decrypt); the "wait for
                 decryption" stage happens off-form, in the pending list
                 below. Round-2 (A11y F2): role="status" announces the
                 "sign in your wallet" instruction to screen-reader users. -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="withdrawIsProcessing"
                data-testid="withdraw-inline-rail"
                role="status"
                class="rounded-lg p-4 border border-gold/25 dark:border-signal/20
                       bg-gold/6 dark:bg-signal/5 flex items-center gap-3"
              >
                <Loader2 :size="14" class="animate-spin text-compute dark:text-signal flex-shrink-0" aria-hidden="true" />
                <p class="font-sans text-[11px] text-cool leading-tight">
                  <span class="font-semibold text-compute dark:text-signal">Burning mhUSDC + requesting decryption…</span>
                  Sign in your wallet to confirm.
                </p>
              </div>
            </transition>

            <button
              type="button"
              @click="handleWithdraw"
              :disabled="withdrawSubmitDisabled"
              data-testid="withdraw-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Loader2 v-if="withdrawIsProcessing" :size="16" class="animate-spin" aria-hidden="true" />
              <ArrowUpFromLine v-else :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="uppercase tracking-[0.18em]">
                {{ withdrawIsProcessing ? 'Submitting…' : 'Withdraw to USDC' }}
              </span>
              <ArrowRight v-if="!withdrawIsProcessing" :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          </template>

          <!-- ── Send branch (Cash only) — cleartext USDC → external ──────
               A plain ERC-20 `USDC.transfer` out of the kernel. No FHE / SDK /
               async claim. Two inline steps: form → confirm (the confirm echoes
               the full recipient + amount + an irreversibility notice). No new
               modal/Teleport — CashPage is keep-alive cached. -->
          <template v-else>
          <!-- Success -->
          <div v-if="sendSuccess" data-testid="send-success-card" class="flex flex-col items-center gap-5 py-6">
            <div
              v-motion
              :initial="{ opacity: 0, scale: 0.5 }"
              :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 15 } }"
              class="w-16 h-16 rounded-full bg-positive/15 border border-positive/30 flex items-center justify-center"
              aria-hidden="true"
            >
              <CheckCircle2 :size="32" :stroke-width="1.8" class="text-positive" />
            </div>
            <div class="text-center space-y-1.5">
              <h2 class="font-accent italic text-2xl md:text-3xl text-midnight dark:text-white tracking-tight">
                USDC sent
              </h2>
              <p class="font-sans text-sm text-cool max-w-md">
                Your USDC has left your wallet and is on its way to the recipient on Arbitrum Sepolia.
              </p>
            </div>
            <p v-if="sendTxHash" class="font-mono text-[11px] text-cool">
              tx:
              <a :href="arbiscanTx(sendTxHash)" target="_blank" rel="noopener"
                 class="text-compute dark:text-signal hover:underline">
                {{ sendTxHash.slice(0, 10) }}…{{ sendTxHash.slice(-8) }}
              </a>
            </p>
            <MButton variant="outline" ref="sendAgainButtonRef" @click="resetSendForm">
              Send more USDC
            </MButton>
          </div>

          <!-- Error -->
          <div v-else-if="sendErrMsg" data-testid="send-error-card" class="flex flex-col items-center gap-5 py-8">
            <div
              class="w-14 h-14 rounded-full bg-negative/12 border border-negative/30 flex items-center justify-center"
              aria-hidden="true"
            >
              <Lock :size="26" :stroke-width="1.8" class="text-negative" />
            </div>
            <h2 class="font-accent italic text-xl text-midnight dark:text-white tracking-tight text-center">Send failed</h2>
            <p class="font-sans text-sm text-cool text-center max-w-md">{{ sendErrMsg }}</p>
            <MButton variant="outline" ref="sendTryAgainButtonRef" @click="resetSendForm">Try again</MButton>
          </div>

          <!-- Confirm sub-step — echoes the full recipient + amount + an
               explicit irreversibility notice before signing. -->
          <div v-else-if="sendStep === 'confirm'" data-testid="send-confirm-card" class="flex flex-col gap-6">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center"
                aria-hidden="true"
              >
                <Send :size="18" :stroke-width="1.8" />
              </div>
              <div>
                <h2 class="font-accent italic text-xl text-midnight dark:text-white leading-tight">Confirm your send</h2>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">
                  Review the recipient and amount carefully — this can't be undone.
                </p>
              </div>
            </div>

            <dl class="rounded-lg border border-haze dark:border-white/10 bg-mist/30 dark:bg-white/[0.02] divide-y divide-haze dark:divide-white/10">
              <div class="flex items-center justify-between gap-4 p-4">
                <dt class="font-sans text-[11px] uppercase tracking-[0.18em] text-cool font-medium">Amount</dt>
                <dd class="font-accent italic text-xl text-midnight dark:text-white tabular-nums" data-testid="send-confirm-amount">
                  {{ sendAmountDisplay }} <span class="font-sans text-[11px] not-italic text-cool">USDC</span>
                </dd>
              </div>
              <div class="flex flex-col gap-1 p-4">
                <dt class="font-sans text-[11px] uppercase tracking-[0.18em] text-cool font-medium">To</dt>
                <dd class="font-mono text-[12px] text-midnight dark:text-white break-all" data-testid="send-confirm-recipient">
                  {{ sendRecipientChecksummed }}
                </dd>
              </div>
            </dl>

            <div
              data-testid="send-irreversible-notice"
              role="alert"
              class="rounded-lg p-3 border border-amber-400/30 bg-amber-500/8 flex items-start gap-2.5"
            >
              <AlertTriangle :size="14" class="text-amber-500 flex-shrink-0 mt-0.5" :stroke-width="2" aria-hidden="true" />
              <p class="font-sans text-[11px] text-cool leading-relaxed">
                <span class="font-semibold text-midnight dark:text-white">This cannot be undone.</span>
                You're sending real USDC out of your MuHaven wallet on Arbitrum Sepolia. Funds sent to
                the wrong address are unrecoverable — double-check it.
              </p>
            </div>

            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-200 ease-in"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div
                v-if="sendIsProcessing"
                data-testid="send-inline-rail"
                role="status"
                class="rounded-lg p-4 border border-gold/25 dark:border-signal/20
                       bg-gold/6 dark:bg-signal/5 flex items-center gap-3"
              >
                <Loader2 :size="14" class="animate-spin text-compute dark:text-signal flex-shrink-0" aria-hidden="true" />
                <p class="font-sans text-[11px] text-cool leading-tight">
                  <span class="font-semibold text-compute dark:text-signal">Sending USDC…</span>
                  Sign in your wallet to confirm.
                </p>
              </div>
            </transition>

            <div class="flex items-center gap-3">
              <button
                type="button"
                @click="backToSendForm"
                :disabled="sendIsProcessing"
                data-testid="send-back"
                class="inline-flex items-center justify-center gap-2 px-5 py-4 rounded-lg
                       font-sans font-semibold text-sm tracking-wide
                       border border-haze dark:border-white/15 text-cool
                       hover:text-midnight dark:hover:text-white hover:border-gold/50 dark:hover:border-signal/30
                       transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ArrowLeft :size="16" :stroke-width="2" aria-hidden="true" />
                <span class="uppercase tracking-[0.18em]">Back</span>
              </button>
              <button
                type="button"
                ref="sendConfirmButtonRef"
                @click="handleSend"
                :disabled="sendIsProcessing || !sendCanSubmit"
                data-testid="send-confirm-cta"
                class="btn-gold-sweep flex-1 py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                       flex items-center justify-center gap-2.5 cursor-pointer
                       transition-all duration-300 hover:-translate-y-0.5"
              >
                <Loader2 v-if="sendIsProcessing" :size="16" class="animate-spin" aria-hidden="true" />
                <Send v-else :size="16" :stroke-width="2" aria-hidden="true" />
                <span class="uppercase tracking-[0.18em]">{{ sendIsProcessing ? 'Sending…' : 'Confirm & Send' }}</span>
              </button>
            </div>
          </div>

          <!-- Form -->
          <div v-else class="flex flex-col gap-8">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center"
                aria-hidden="true"
              >
                <Send :size="18" :stroke-width="1.8" />
              </div>
              <div>
                <h2 class="font-accent italic text-xl text-midnight dark:text-white leading-tight">
                  Send USDC
                </h2>
                <p class="font-sans text-[11px] text-cool mt-0.5 leading-relaxed">
                  Send cleartext USDC from your wallet to any external Arbitrum address — an exchange,
                  a hardware wallet, a friend. This is a public transfer, not a confidential one.
                </p>
              </div>
            </div>

            <!-- Recipient -->
            <div class="flex flex-col gap-3">
              <label for="send-recipient-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Recipient address
              </label>
              <input
                id="send-recipient-input"
                ref="sendRecipientInputRef"
                v-model.trim="sendRecipient"
                placeholder="0x…"
                spellcheck="false"
                autocomplete="off"
                aria-describedby="send-recipient-hint"
                :disabled="sendIsProcessing"
                data-testid="send-recipient-input"
                class="w-full bg-transparent border-0 border-b border-haze dark:border-white/10
                       font-mono text-base text-midnight dark:text-white py-3 px-1
                       placeholder:text-cool/40 focus:outline-none focus:border-gold dark:focus:border-signal
                       transition-colors disabled:opacity-50"
              />
              <!-- Validation readout (mirrors the TransferPage idiom). -->
              <p
                id="send-recipient-hint"
                v-if="sendRecipient.trim() && !sendRecipientValid"
                role="alert"
                data-testid="send-recipient-invalid"
                class="font-sans text-[10px] text-negative leading-relaxed flex items-center gap-1.5"
              >
                <AlertTriangle :size="12" :stroke-width="2" aria-hidden="true" />
                Not a valid Ethereum address.
              </p>
              <p
                id="send-recipient-hint"
                v-else-if="sendIsZeroAddr"
                role="alert"
                data-testid="send-recipient-zero"
                class="font-sans text-[10px] text-negative leading-relaxed flex items-center gap-1.5"
              >
                <AlertTriangle :size="12" :stroke-width="2" aria-hidden="true" />
                That's the zero address — funds would be burned. Pick a real address.
              </p>
              <p
                id="send-recipient-hint"
                v-else-if="sendIsSelf"
                role="alert"
                data-testid="send-recipient-self"
                class="font-sans text-[10px] text-negative leading-relaxed flex items-center gap-1.5"
              >
                <AlertTriangle :size="12" :stroke-width="2" aria-hidden="true" />
                That's your own wallet — sending to yourself just wastes a transaction.
              </p>
              <p
                id="send-recipient-hint"
                v-else
                class="font-sans text-[10px] text-cool/80 leading-relaxed"
                data-testid="send-recipient-hint-default"
              >
                The full address is shown again on the confirm screen before you sign.
              </p>
            </div>

            <!-- Amount -->
            <div class="flex flex-col gap-3">
              <label for="send-amount-input" class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-medium">
                Amount (USDC)
              </label>
              <div class="flex items-end gap-2 border-b border-haze dark:border-white/10 pb-2 transition-colors focus-within:border-gold dark:focus-within:border-signal">
                <span aria-hidden="true" class="font-accent italic text-3xl md:text-4xl text-cool pb-0.5 leading-none">$</span>
                <input
                  id="send-amount-input"
                  v-model="sendAmount"
                  placeholder="0.00"
                  inputmode="decimal"
                  pattern="^\d*(\.\d{0,6})?$"
                  aria-describedby="send-amount-hint"
                  :disabled="sendIsProcessing"
                  data-testid="send-amount-input"
                  class="w-full bg-transparent border-0 font-accent italic
                         text-4xl md:text-5xl text-midnight dark:text-white tabular-nums tracking-tight
                         placeholder:text-cool/40 focus:outline-none focus:ring-0 p-0 leading-none disabled:opacity-50"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  @click="setSendMax"
                  :disabled="sendIsProcessing || usdcBalance === null || usdcBalance === 0n"
                  data-testid="send-max"
                  class="font-sans text-[10px] uppercase tracking-[0.2em] font-medium
                         bg-mist/60 dark:bg-white/5 hover:bg-gold/15 dark:hover:bg-signal/15
                         text-slate dark:text-body-dark/80 hover:text-compute dark:hover:text-signal
                         border border-haze dark:border-white/10
                         px-3 py-2 rounded transition-all duration-200 cursor-pointer
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  :title="usdcBalance && usdcBalance > 0n ? 'Send your full USDC balance' : 'No USDC to send'"
                >
                  Max
                </button>
                <p
                  id="send-amount-hint"
                  v-if="sendOverBalance"
                  role="alert"
                  data-testid="send-over-balance"
                  class="font-sans text-[10px] text-negative leading-relaxed flex items-center gap-1.5"
                >
                  <AlertTriangle :size="12" :stroke-width="2" aria-hidden="true" />
                  Amount exceeds your USDC balance ({{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}).
                </p>
                <p
                  id="send-amount-hint"
                  v-else
                  class="font-sans text-[10px] text-cool/80 leading-relaxed"
                  data-testid="send-amount-hint-default"
                >
                  Available: {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }} · 6-decimal precision.
                </p>
              </div>
            </div>

            <!-- Irreversibility framing on the form too (the confirm step has
                 the load-bearing notice; this is the early heads-up). -->
            <div class="rounded-lg p-4 border border-gold/25 bg-gold/5 flex items-start gap-3">
              <AlertTriangle :size="16" :stroke-width="1.8" class="text-gold mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p class="font-sans text-[11px] text-cool leading-relaxed">
                Sends leave MuHaven and can't be reversed. You'll review the full recipient and amount
                before signing.
              </p>
            </div>

            <button
              type="button"
              @click="reviewSend"
              :disabled="!sendCanSubmit"
              data-testid="send-review-cta"
              class="btn-gold-sweep w-full py-4 rounded-lg font-sans font-semibold text-sm tracking-wide
                     flex items-center justify-center gap-2.5 cursor-pointer
                     transition-all duration-300 hover:-translate-y-0.5 mt-2"
            >
              <Send :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="uppercase tracking-[0.18em]">Review send</span>
              <ArrowRight :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          </template>
        </div>
      </section>

      <!-- ── Pending USDC claims — Wave 5 W3 ───────────────────────────────
           Re-discovered from chain on mount via `getUserWithdrawClaims`;
           one row per pending claim. Each row polls
           `withdrawDecryptResult(claimId)` every 5s until ready, then the
           Claim button settles via `claimUsdc(claimId)`. Visible regardless
           of the current direction so a user mid-flight always sees their
           in-progress USDC even if they flip back to Deposit. -->
      <!-- Round-2 (A11y F5): dropped `aria-live="polite"` from the section.
           A whole-section live region churns with every 5s poll × N rows;
           the per-row pill below gets its own role="status" so only the
           specific status changes get announced. The toast.success on
           ready transition (in pollPendingDecrypts) is the global cue. -->
      <section
        v-if="pendingClaims.length > 0 || pendingDiscoveryError"
        data-testid="cash-pending-claims-section"
        class="max-w-2xl mx-auto mt-6 rounded-2xl overflow-hidden border border-haze dark:border-white/5
               bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-lg
               shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
               dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
      >
        <div class="p-6 md:p-8 relative">
          <div class="flex items-center justify-between mb-5">
            <div class="flex items-center gap-3">
              <div
                class="w-8 h-8 rounded-lg bg-gold/15 dark:bg-signal/15 text-compute dark:text-signal flex items-center justify-center"
                aria-hidden="true"
              >
                <ArrowUpFromLine :size="14" :stroke-width="1.8" />
              </div>
              <div>
                <h2 class="font-accent italic text-lg text-midnight dark:text-white leading-tight">
                  Pending USDC claims
                </h2>
                <p class="font-sans text-[11px] text-cool mt-0.5">
                  {{ pendingClaims.length }} in flight · checks every {{ CLAIM_POLL_INTERVAL_SECONDS }}s
                </p>
              </div>
            </div>
            <button
              type="button"
              @click="loadPendingClaims"
              data-testid="cash-pending-claims-refresh"
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.18em] font-medium
                     text-cool hover:text-compute dark:hover:text-signal transition-colors px-2 py-2"
              aria-label="Refresh pending claims"
            >
              <RefreshCw :size="11" :stroke-width="2" aria-hidden="true" />
              Refresh
            </button>
          </div>

          <p
            v-if="pendingDiscoveryError"
            data-testid="cash-pending-claims-error"
            role="alert"
            class="font-sans text-[11px] text-negative bg-negative/5 border border-negative/20 rounded px-3 py-2 mb-3"
          >
            Couldn't load pending claims: {{ pendingDiscoveryError }}
          </p>

          <ul class="flex flex-col gap-3">
            <li
              v-for="claim in sortedPendingClaims"
              :key="claim.claimId.toString()"
              :data-testid="`cash-pending-claim-${claim.claimId}`"
              class="rounded-lg border border-haze dark:border-white/10 bg-mist/30 dark:bg-white/[0.02]
                     p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            >
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-mono text-[11px] text-cool">claim #{{ claim.claimId }}</span>
                  <!-- Round-2 (A11y F5): role="status" on the pill so each
                       claim's individual state-change is announced, without
                       the whole list re-announcing on every render. -->
                  <span
                    v-if="!claim.ready"
                    role="status"
                    class="inline-flex items-center gap-1 font-sans text-[9px] uppercase tracking-[0.18em] font-semibold
                           text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/25
                           px-2 py-0.5 rounded"
                  >
                    <Loader2 :size="10" class="animate-spin" aria-hidden="true" />
                    Decrypting
                  </span>
                  <span
                    v-else
                    role="status"
                    class="inline-flex items-center gap-1 font-sans text-[9px] uppercase tracking-[0.18em] font-semibold
                           text-positive bg-positive/10 border border-positive/25
                           px-2 py-0.5 rounded"
                  >
                    <CheckCircle2 :size="10" aria-hidden="true" />
                    Ready to claim
                  </span>
                </div>
                <p class="font-accent italic text-lg text-midnight dark:text-white leading-tight">
                  {{ claim.ready && claim.amount !== null ? formatBase6(claim.amount) : '— USDC' }}
                </p>
                <p
                  v-if="claim.errMsg"
                  role="alert"
                  class="font-sans text-[10px] text-negative leading-snug max-w-md"
                >
                  {{ claim.errMsg }}
                </p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <!-- Round-2 (A11y F4): replaced MButton with a raw button so
                     `aria-disabled` keeps the element FOCUSABLE while
                     non-actionable. Native `disabled` removes from the focus
                     order and (in some SR/browser combos) suppresses the
                     accessible name — meaning the contextual aria-label
                     never reaches the user. The click guard mirrors what
                     `disabled` did. Style mirrors MButton primary-sm. -->
                <button
                  type="button"
                  :aria-disabled="!claim.ready || claim.claiming || claimsKillSwitch"
                  @click="tryClaimWithdrawal(claim)"
                  :data-testid="`cash-pending-claim-${claim.claimId}-claim`"
                  :aria-label="
                    claim.ready && claim.amount !== null
                      ? `Claim ${formatBase6(claim.amount)} USDC for claim ${claim.claimId}`
                      : claimsKillSwitch
                        ? `Claim ${claim.claimId} paused — settlement temporarily halted`
                        : `Claim ${claim.claimId} not ready yet`
                  "
                  :class="[
                    'inline-flex items-center justify-center gap-1.5 font-sans font-semibold transition-all duration-200 rounded-md',
                    'text-xs px-3.5 py-2',
                    'bg-compute text-white hover:bg-compute-hover hover:-translate-y-0.5 active:scale-[0.98]',
                    'shadow-[0_4px_14px_rgba(184,134,11,0.22)] hover:shadow-[0_8px_24px_rgba(184,134,11,0.32)]',
                    'dark:bg-signal dark:text-[#412d00] dark:hover:bg-signal-hover',
                    'dark:shadow-[0_4px_14px_rgba(255,220,161,0.20)] dark:hover:shadow-[0_8px_28px_rgba(255,220,161,0.32)]',
                    (!claim.ready || claim.claiming || claimsKillSwitch)
                      ? 'opacity-50 cursor-not-allowed hover:translate-y-0 hover:shadow-[0_4px_14px_rgba(184,134,11,0.22)]'
                      : 'cursor-pointer',
                  ]"
                >
                  <Loader2 v-if="claim.claiming" :size="14" class="animate-spin" aria-hidden="true" />
                  <ArrowDownToLine v-else :size="12" :stroke-width="2" aria-hidden="true" />
                  {{ claim.claiming ? 'Claiming…' : claimsKillSwitch ? 'Paused' : claim.ready ? 'Claim USDC' : 'Waiting' }}
                </button>
              </div>
            </li>
          </ul>
        </div>
      </section>
      </template>
    </div>

    <Teleport to="body" :disabled="!isXl">
      <!-- WS-1 fix: when teleported to <body> (xl), keep-alive does NOT relocate
           this node on deactivate, so a backgrounded /cash would leave the
           fixed "Your Wallet" aside painted over every other page. Gate the
           teleported render on `isActive` so it unmounts from <body> when the
           page is backgrounded. Below xl the teleport is disabled (in-flow), so
           keep-alive moves it normally — show unconditionally there. v-show (not
           v-if) so the v-motion entrance doesn't replay on every Cash re-entry
           and the node isn't remounted; a display:none fixed node isn't painted,
           so the leak is fixed either way. -->
      <aside
        v-show="isActive || !isXl"
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 520, delay: 120 } }"
        class="mt-10 xl:mt-0 flex flex-col gap-8 w-full
               xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
               xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
      >
        <!-- ── Wallet card — address + QR + chain pill ──────────────── -->
        <div>
          <div class="flex items-center justify-between mb-5">
            <h2 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold inline-flex items-center gap-2">
              <Wallet :size="13" :stroke-width="2" class="text-compute dark:text-signal" />
              Your wallet
            </h2>
            <span
              class="font-sans text-[9px] uppercase tracking-[0.18em] font-medium
                     text-compute/80 dark:text-signal/80
                     bg-compute/8 dark:bg-signal/10
                     border border-compute/20 dark:border-signal/20
                     px-2 py-0.5 rounded"
            >
              Arb Sepolia
            </span>
          </div>

          <div
            class="rounded-xl p-5 border border-haze dark:border-white/8
                   bg-white dark:bg-[#1c1b1b]/80
                   shadow-[0_2px_14px_-6px_rgba(63,46,12,0.1)]
                   dark:shadow-[0_2px_14px_-6px_rgba(0,0,0,0.6)]
                   flex flex-col items-center gap-4"
          >
            <MAddressQR
              :address="address ?? null"
              :size="148"
              caption="Scan with any wallet to send USDC here"
            />

            <div class="w-full flex flex-col gap-2">
              <span class="font-sans text-[9px] uppercase tracking-[0.22em] text-cool/80 text-center">
                Smart account address
              </span>
              <button
                type="button"
                @click="copyAddress"
                :disabled="!address"
                data-testid="cash-wallet-copy-address"
                :aria-label="copied ? 'Address copied' : 'Copy smart account address'"
                class="group w-full inline-flex items-center justify-between gap-2
                       rounded-lg px-3 py-2.5
                       bg-mist/60 dark:bg-white/[0.04]
                       border border-haze dark:border-white/8
                       hover:border-gold/50 dark:hover:border-signal/30
                       transition-colors duration-200 cursor-pointer
                       disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span class="font-mono text-[11px] text-compute dark:text-signal truncate">
                  {{ address ?? '—' }}
                </span>
                <span
                  class="flex-shrink-0 inline-flex items-center gap-1 font-sans text-[10px] uppercase tracking-[0.18em] font-semibold
                         text-cool group-hover:text-compute dark:group-hover:text-signal transition-colors"
                >
                  <Check v-if="copied" :size="12" class="text-positive" />
                  <Copy v-else :size="12" />
                  {{ copied ? 'Copied' : 'Copy' }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- ── Balances strip ──────────────────────────────────────── -->
        <div class="flex flex-col gap-3">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold">Balances</h3>

          <!-- USDC: plaintext ERC-20.
               Phase 9.A · Option Z follow-up — auto-refresh + bloom on
               inbound transfers. The whole tile gains a `data-bloom`
               toggle keyed on `usdcBloomKey`; the gold-glow ring + the
               transient `+$X.XX` subtitle are the visible affordances
               (silent for everyone but the user, no toast spam). The
               "Get test USDC" link cross-fades out as the bloom
               begins on the 0→positive transition so the slot reads
               as one coherent event. -->
          <div
            data-testid="cash-usdc-tile"
            class="relative rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-1 overflow-hidden"
          >
            <!-- Inbound bloom overlay: a 600ms gold-glow ring fades in
                 over the tile border on each debounced inbound. Pure
                 visual cue — pointer-events-none so it doesn't intercept
                 the faucet link clicks. v-motion / Transition handles
                 the mount fade; the script clears it after BLOOM_HOLD_MS. -->
            <transition
              enter-active-class="transition-opacity duration-300 ease-out"
              leave-active-class="transition-opacity duration-500 ease-in"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <div
                v-if="usdcBloomActive"
                aria-hidden="true"
                data-testid="cash-usdc-bloom"
                class="absolute inset-0 rounded-lg pointer-events-none
                       ring-2 ring-gold/40 dark:ring-signal/40
                       shadow-[0_0_24px_-4px_rgba(255,186,32,0.45)]
                       dark:shadow-[0_0_24px_-4px_rgba(255,220,161,0.35)]"
              />
            </transition>
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">USDC</span>
              <span class="font-sans text-[9px] text-cool/70 uppercase tracking-[0.18em]">Public testnet</span>
            </div>
            <span
              class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums"
              data-testid="cash-usdc-balance"
            >
              {{ usdcBalance !== null ? formatUSD(Number(usdcBalance) / 1e6) : '—' }}
            </span>
            <!-- Transient inbound-delta subtitle. Renders only when the
                 most recent debounced inbound was ≥$1 (sub-dollar dust
                 still pulses the ring but doesn't earn a label).
                 Auto-clears after SUBTITLE_PERSIST_MS. -->
            <transition
              enter-active-class="transition-all duration-300 ease-out"
              leave-active-class="transition-all duration-600 ease-in"
              enter-from-class="opacity-0 translate-y-1"
              leave-to-class="opacity-0"
            >
              <span
                v-if="usdcDeltaCents >= 100"
                data-testid="cash-usdc-inbound-delta"
                class="font-sans text-[11px] tabular-nums text-positive font-semibold"
              >
                +{{ formatUSD(usdcDeltaCents / 100) }} received
              </span>
            </transition>
            <transition
              enter-active-class="transition-opacity duration-300"
              leave-active-class="transition-opacity duration-300"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <a
                v-if="usdcBalance !== null && usdcBalance === 0n"
                :href="CIRCLE_FAUCET_URL"
                target="_blank"
                rel="noopener"
                data-testid="fund-account-faucet-link"
                class="mt-1 inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold text-gold hover:text-gold/80 transition-colors self-start"
              >
                Get test USDC
                <ExternalLink :size="11" />
              </a>
            </transition>
          </div>

          <!-- mhUSDC: encrypted spendable cash. Two states:
               • Pre-decrypt (portfolio.pusdcConfidentialBalance === null): show "Encrypted"
                 pill + Reveal button. The on-chain balance handle is
                 sealed; only the user can decrypt. We never auto-fetch
                 this on mount — each decrypt costs a session signature.
               • Post-decrypt (bigint): show formatted USD + Refresh.
               Auto-refresh on inbound MuHavenStable.Transfer fires the
               same bloom ring; for revealed users it also re-decrypts
               the balance, for locked users it just signals "something
               arrived — click Reveal to see the new total". No
               subtitle here: the amount handle isn't readable from the
               event payload (FHE-encrypted), so we can't show a
               +$X.XX delta without forcing a decrypt. -->
          <div
            data-testid="cash-mhusdc-tile"
            class="relative rounded-lg p-4 border border-haze dark:border-white/8 bg-mist/40 dark:bg-[#1c1b1b]/60 flex flex-col gap-2 overflow-hidden"
          >
            <!-- Inbound bloom for mhUSDC. Same 600ms gold ring as USDC.
                 Fires on MuHavenStable.Transfer with `to == kernel`,
                 i.e. inbound mints (from a wrap on this account or
                 from a P2P transfer-in). For revealed users, the
                 portfolio store auto-re-decrypts so the value updates
                 in lockstep; for locked users the bloom is the only
                 signal until they click Reveal. -->
            <transition
              enter-active-class="transition-opacity duration-300 ease-out"
              leave-active-class="transition-opacity duration-500 ease-in"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <div
                v-if="mhusdcBloomActive"
                aria-hidden="true"
                data-testid="cash-mhusdc-bloom"
                class="absolute inset-0 rounded-lg pointer-events-none
                       ring-2 ring-gold/40 dark:ring-signal/40
                       shadow-[0_0_24px_-4px_rgba(255,186,32,0.45)]
                       dark:shadow-[0_0_24px_-4px_rgba(255,220,161,0.35)]"
              />
            </transition>
            <div class="flex items-center justify-between">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool">mhUSDC</span>
              <span
                class="font-sans text-[9px] uppercase tracking-[0.18em] font-medium
                       text-compute/80 dark:text-signal/80
                       border border-compute/20 dark:border-signal/20
                       px-1.5 py-0.5 rounded"
              >
                Encrypted
              </span>
            </div>

            <!-- Decrypted state: big number. Refresh action lives in the
                 single unified button below — keeps the tile clean and
                 prevents two competing "Refresh" surfaces in the aside. -->
            <template v-if="portfolio.pusdcConfidentialBalance !== null">
              <span
                class="font-accent italic text-2xl text-midnight dark:text-white tabular-nums"
                data-testid="cash-mhusdc-balance"
              >
                {{ formatUSD(Number(portfolio.pusdcConfidentialBalance) / 1e6) }}
              </span>
              <span
                v-if="!portfolio.pusdcStale"
                class="font-sans text-[10px] text-cool/80 leading-tight"
              >
                Confidential cash · spend on Trade
              </span>
              <!-- Stale sub-line: most-recent passive refresh failed but
                   the cached value is still visible. Inline Retry re-fires
                   the decrypt. Same shape as PortfolioPage's strip cell
                   (one bug, one fix, one indicator pattern). -->
              <span
                v-else
                data-testid="cash-mhusdc-stale"
                class="font-sans text-[10px] text-cool/80 leading-tight flex items-center gap-1"
              >
                <span>Last refresh failed</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  @click="decryptMhUsdcBalance"
                  :disabled="portfolio.pusdcDecrypting"
                  class="text-compute dark:text-signal hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >retry</button>
              </span>
            </template>

            <!-- Pre-decrypt state: blurred placeholder + Reveal CTA -->
            <template v-else>
              <span
                class="font-accent italic text-2xl text-cool/40 dark:text-body-dark/30 tabular-nums select-none blur-[2.5px] tracking-[0.05em]"
                aria-hidden="true"
                data-testid="cash-mhusdc-locked"
              >
                $••••.••
              </span>
              <span class="font-sans text-[10px] text-cool/80 leading-tight">
                Confidential cash · only you can decrypt
              </span>
              <button
                type="button"
                @click="decryptMhUsdcBalance"
                :disabled="portfolio.pusdcDecrypting || !address"
                data-testid="cash-mhusdc-decrypt-cta"
                class="self-start mt-1 inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-semibold
                       text-compute dark:text-signal
                       border border-compute/30 dark:border-signal/30
                       hover:text-white dark:hover:text-[#412d00]
                       hover:bg-compute dark:hover:bg-signal
                       px-3 py-1.5 rounded transition-all duration-200 cursor-pointer
                       disabled:opacity-60 disabled:cursor-wait"
              >
                <Loader2 v-if="portfolio.pusdcDecrypting" :size="11" class="animate-spin" />
                <Eye v-else :size="11" :stroke-width="2" />
                Reveal
              </button>
            </template>

            <p
              v-if="portfolio.pusdcError"
              class="font-sans text-[10px] text-negative leading-tight mt-1"
            >
              {{ portfolio.pusdcError }}
            </p>
          </div>

          <!-- Unified Refresh — re-fetches USDC + re-decrypts mhUSDC iff
               already revealed. We never trigger a fresh decrypt for a
               locked balance: that costs a session signature for a
               value the user hasn't asked to see. -->
          <div class="flex items-center justify-end pt-1">
            <button
              type="button"
              @click="refreshAll"
              :disabled="balancesLoading || portfolio.pusdcDecrypting || !address"
              data-testid="cash-balances-refresh"
              class="inline-flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.22em] font-medium text-cool hover:text-compute dark:hover:text-signal transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw :size="12" :class="(balancesLoading || portfolio.pusdcDecrypting) && 'animate-spin'" />
              Refresh
            </button>
          </div>
        </div>

        <!-- Security Notice — privacy framing, always visible. The
             progress rail used to live above this section but moved
             inline above the Convert button so it's only on screen
             while a wrap is actually running. -->
        <div class="pt-8 border-t border-haze dark:border-white/8">
          <h3 class="font-sans text-[11px] uppercase tracking-[0.22em] text-cool font-semibold mb-4">Security Notice</h3>
          <div class="rounded-lg p-4 border border-gold/25 bg-gold/5 flex items-start gap-3">
            <EyeOff :size="16" :stroke-width="1.8" class="text-gold mt-0.5 flex-shrink-0" />
            <p class="font-sans text-[11px] text-cool leading-relaxed">
              {{ mode === 'cash'
                ? 'Wrap amount is encrypted via Fhenix FHE. mhUSDC balance grants decrypt rights to this session only.'
                : 'ERC-20 approval and wrap amounts are visible on-chain. Balance becomes encrypted after wrapping.' }}
            </p>
          </div>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
