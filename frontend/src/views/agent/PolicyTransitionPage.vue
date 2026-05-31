<script setup lang="ts">
/**
 * Wave 4 Q1 — Dashboard agent policy / tier transition + session-key reveal.
 *
 * Closes §3e⁶ F-dashboard-policy-route-missing — the broker daemon's error
 * string pointed operators to this page; it didn't exist before Q1. Page
 * has two stacked responsibilities:
 *
 *   1. Per-surface tier picker (Advisory / Confirm-per-action / Policy-bound).
 *      Wires to backend POST /api/v1/agent/policy/transition — handles
 *      both step-down auto-commits and step-up confirmation-token flow.
 *
 *   2. One-time session-key export. After confirming a Scoped transition,
 *      SessionKeyRevealModal surfaces the freshly-minted signer as a
 *      one-paste `muhaven-broker update --session <key>` command (raw hex
 *      still offered for env-var / stdin workflows). Operator runs it on a
 *      different machine. The dashboard never ships the key over the
 *      wire — local-only computation per the Wave 4 privacy boundary.
 *
 * The threshold-narrowing sliders described in POST_S4_QUEUE.md are
 * deferred to a Q1b follow-up: the bare tier picker plus reveal is the
 * load-bearing piece for the operator-broker handshake and the §3e⁶
 * closure. Threshold UI ships when Wave 5 wires the validator-bind
 * call-policy build (currently the backend's permission template is
 * scoped per-action; per-tier thresholds are a separate concern).
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  ShieldCheck,
  ShieldOff,
  Layers,
  KeyRound,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  PlayCircle,
  Clock,
  ChevronDown,
  Repeat2,
} from 'lucide-vue-next'
import {
  agentPolicyApi,
  ApiError,
  type AgentUserStateDto,
  type MintScopedSessionRequest,
  type Surface,
  type Tier,
  type TierTransitionConfirmation,
} from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useModalA11y } from '@/composables/useModalA11y'
import { useScopedSession } from '@/composables/useScopedSession'
import {
  scopedExpiresInSec,
  formatExpiresIn,
  signerPrefix,
  permissionIdPrefix,
  formatMhUsdc6,
  isSessionLive,
} from '@/composables/scoped-session.helpers'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import SessionKeyRevealModal from '@/components/agent/SessionKeyRevealModal.vue'
import type { ScopedSessionInstallResult } from '@/providers/wallet-provider.interface'
import { v35Addresses } from '@/contracts/addresses'
import {
  SCOPED_DEFAULT_TTL_SEC,
  SCOPED_TTL_CHOICES,
  parseMhUsdcBase6,
  prefixConsentActionHash,
  newScopedSessionId,
  buildScopedMintBody,
  formatPendingMhUsdc,
  formatTier,
  formatTtlLabel,
  scopedParamsFailure,
} from './policy-scoped.helpers'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const walletStore = useWalletStore()

/** Type guards for the deep-link query params from `set_policy` redirect. */
const SURFACE_SET: ReadonlyArray<Surface> = ['havenbot', 'mcp', 'openclaw', 'checkout']
const PICKABLE_TIER_SET: ReadonlyArray<Tier> = ['advisory', 'confirm-per-action', 'policy-bound', 'scoped']
function isSurface(v: unknown): v is Surface {
  return typeof v === 'string' && (SURFACE_SET as readonly string[]).includes(v)
}
function isPickableTier(v: unknown): v is Tier {
  return typeof v === 'string' && (PICKABLE_TIER_SET as readonly string[]).includes(v)
}


// ── Tier surface — the page operates on a single surface at a time.
// Defaulting to MCP because that's the surface the broker daemon binds
// to + the page's primary operator audience. The dropdown lets the
// user switch between HavenBot / MCP / OpenClaw / Checkout if they
// want to manage a different surface's tier.
const SURFACE_OPTIONS: ReadonlyArray<{ value: Surface; label: string; description: string }> = [
  { value: 'mcp', label: 'MCP / Broker', description: 'For the broker daemon + Claude Code skill' },
  { value: 'havenbot', label: 'HavenBot', description: 'For the in-dashboard chat copilot' },
  { value: 'openclaw', label: 'OpenClaw', description: 'For the Claude OpenClaw skill install' },
  { value: 'checkout', label: 'Checkout', description: 'For hosted-checkout deeplinks' },
]

const TIER_OPTIONS: ReadonlyArray<{
  value: Tier
  title: string
  blurb: string
  icon: typeof ShieldCheck
}> = [
  {
    value: 'advisory',
    title: 'Advisory',
    blurb: 'Agent can read your portfolio and propose actions. Every write requires a fresh passkey signature.',
    icon: ShieldCheck,
  },
  {
    value: 'confirm-per-action',
    title: 'Confirm per action',
    blurb: 'Agent proposes; a dashboard / Telegram prompt asks you to confirm each write before it submits.',
    icon: Layers,
  },
  {
    value: 'policy-bound',
    title: 'Policy-bound',
    blurb: 'Agent can write within the call-allowlist + spend caps you configured. Subject to risk-engine pauses.',
    icon: Sparkles,
  },
  {
    value: 'scoped',
    title: 'Scoped autonomy',
    blurb: 'Autonomous buys & sells within a per-op ceiling, time-bounded by TTL. The agent signs without prompting up to the ceiling.',
    icon: KeyRound,
  },
]

// ── Local state ────────────────────────────────────────────────────
const selectedSurface = ref<Surface>('mcp')
const targetTier = ref<Tier | null>(null)
const statesBySurface = ref<Record<Surface, AgentUserStateDto | null>>({
  havenbot: null,
  mcp: null,
  openclaw: null,
  checkout: null,
})
const loadingState = ref(true)
const submitting = ref(false)
const fetchError = ref<string | null>(null)
const transitionError = ref<string | null>(null)

// Step-up flow: backend returned a confirmation token; user must click
// "Confirm" to consume it. Cleared once consumed or on tier-pick change.
const pendingConfirmation = ref<TierTransitionConfirmation | null>(null)
const lastCommittedAt = ref<string | null>(null)

// F2 — Resume flow when current tier is paused. Distinct from the
// step-up flow because resume bypasses requestUserTierChange entirely
// (it's only resumable-from-paused per ADR-0).
const resuming = ref(false)

// Wave 5 Path D Slice 1 Pickup A — Scoped tier inputs. `maxPerOpUsd6Input`
// is the user-facing whole-mhUSDC string (decimal, up to 6 dp); the commit
// step parses it to a base-6 BigInt for the POST. `ttlSecInput` is a
// curated segmented control (R1 UX H-2: free-text seconds was wrong
// cognitive load for a consent-critical autonomy decision).
const maxPerOpUsd6Input = ref<string>('100')
const ttlSecInput = ref<number>(SCOPED_DEFAULT_TTL_SEC)

// Reveal flow for the Scoped session-key surfaced AFTER the tier transition
// commit + the policy-snapshot POST land. This is the SOLE broker-key reveal
// (Wave 5 Option D · C4 follow-up removed the legacy in-tab "Reveal session
// key for broker" button — it minted a different key that didn't match the
// on-chain Scoped validator). It carries the freshly-minted ephemeral EOA's
// private half, surfaced as the one-paste `muhaven-broker update --session
// <key>` command (the modal also exposes the raw key for env-var / stdin use).
const scopedReveal = ref<ScopedSessionInstallResult | null>(null)

/** R1 UX H-3 — post-commit error-recovery state. When set, the inline
 *  failure-recovery strip surfaces "Retry mint" + "Step down to
 *  Policy-bound" CTAs so the user isn't stranded with an orphaned
 *  tier=scoped server-state + no functional session key.
 *  R2 RC LOW-1 — only `'retry-mint'` is actually emitted today; the
 *  prior `| 'step-down'` literal was dead-code. Narrowed to keep the
 *  union honest. */
const scopedRecoveryNeeded = ref<'retry-mint' | null>(null)
/** Captured consentActionHash from the consumed ConfirmToken — preserved
 *  across a retry so the audit-chain stable-key JOIN remains correlated
 *  to the originally-confirmed tier transition. */
const scopedRecoveryConsentHash = ref<`0x${string}` | null>(null)
/** Snapshot of the maxPerOpUsd6 + ttlSec the user authorized at Phase 1
 *  issue time. R1 UX H-4: live-editing the form after issue must not
 *  silently shift what the second tap confirms. Cleared on token /
 *  picker reset. */
const pendingScopedParams = ref<{ maxPerOpUsd6: bigint; ttlSec: number } | null>(null)

// F3 — Live countdown to the confirmation token's expiry so the user
// notices when their token is about to go stale. The 1s ticker only
// runs while a token is pending; cleared on commit / cancel / unmount.
const nowMs = ref<number>(Date.now())
let countdownHandle: ReturnType<typeof setInterval> | null = null

// ── Wave 5 Option D · Commit 4 — active Scoped session + revoke ──────
// Shared module state (same refs the global ScopedSessionBanner reads),
// so a revoke here clears the banner + arms its broker-purge reminder.
const {
  session: activeScopedSession,
  refresh: refreshScopedSession,
  revoke: revokeScopedSession,
  setReinvest: setReinvestEnabled,
} = useScopedSession()

// ── Wave 5 Slice 2c — auto-reinvest opt-in toggle ───────────────────
// Optimistic switch: flip the view immediately, POST, roll back on error.
// Reflects the active session's `reinvestEnabled` (default false). The
// keyless reinvest runner only claims+buys when this is ON.
const reinvestBusy = ref<boolean>(false)
const reinvestError = ref<string | null>(null)
/** The intended state while a POST is in flight (optimistic). Falls back to
 *  the session's persisted flag when idle. */
const reinvestOptimistic = ref<boolean | null>(null)
const reinvestOn = computed<boolean>(() =>
  reinvestOptimistic.value !== null
    ? reinvestOptimistic.value
    : activeScopedSession.value?.reinvestEnabled === true,
)

async function onToggleReinvest(): Promise<void> {
  if (reinvestBusy.value || !hasActiveScopedSession.value) return
  const next = !reinvestOn.value
  reinvestBusy.value = true
  reinvestError.value = null
  reinvestOptimistic.value = next
  try {
    await setReinvestEnabled(next)
    // Committed — drop the optimistic override so the computed reads the
    // freshly-updated session row.
    reinvestOptimistic.value = null
    toast.success(
      next ? 'Auto-reinvest enabled' : 'Auto-reinvest disabled',
      {
        description: next
          ? 'Matured yield will be claimed and reinvested into the same RWA automatically — bounded by your per-trade cap.'
          : 'The agent will no longer auto-reinvest your matured yield.',
      },
    )
  } catch (e) {
    reinvestOptimistic.value = null // roll back to the persisted value
    reinvestError.value =
      e instanceof ApiError
        ? e.status === 404
          ? 'No active session to toggle — re-mint a Scoped session first.'
          : `Could not update auto-reinvest (HTTP ${e.status}).`
        : e instanceof Error
          ? e.message
          : 'Could not update auto-reinvest.'
  } finally {
    reinvestBusy.value = false
  }
}

/** A revocable Scoped session exists (status='active' + TTL live). The
 *  revoke zone + the tier-picker disclosure key off this. Re-evaluates
 *  every 1s via the existing `nowMs` ticker. */
const hasActiveScopedSession = computed<boolean>(() =>
  isSessionLive(activeScopedSession.value, nowMs.value),
)

const scopedExpiresLabel = computed<string>(() =>
  activeScopedSession.value
    ? formatExpiresIn(scopedExpiresInSec(activeScopedSession.value.validUntilSec, nowMs.value))
    : '—',
)

const scopedMintedLabel = computed<string>(() =>
  activeScopedSession.value?.mintedAt
    ? new Date(activeScopedSession.value.mintedAt).toLocaleString()
    : '—',
)

/** When an active session exists the tier picker collapses behind a
 *  "Change tier" disclosure (UX HIGH-2 — keep the revoke zone the focus).
 *  Initialised in onMounted once the session has loaded; toggled open by
 *  the disclosure button or after a revoke. */
const showTierPicker = ref<boolean>(true)

// Revoke confirmation alertdialog state.
const showRevokeDialog = ref<boolean>(false)
const revokeDialogRoot = ref<HTMLElement | null>(null)
const revoking = ref<boolean>(false)
const revokeError = ref<string | null>(null)
/** Dual-tap safety — "Confirm revoke" is hold-disabled for 3s after the
 *  dialog opens so the second tap is deliberate (mirrors the
 *  pendingConfirmation cognitive model). */
const REVOKE_HOLD_SEC = 3
const revokeHoldRemaining = ref<number>(REVOKE_HOLD_SEC)
let revokeHoldHandle: ReturnType<typeof setInterval> | null = null

useModalA11y({
  isOpen: showRevokeDialog,
  rootRef: revokeDialogRoot,
  onEscape: () => closeRevokeDialog(),
  // Don't let Esc / backdrop close mid-DELETE — avoids a confusing
  // "did it revoke?" state if the round-trip is in flight.
  disableEscape: revoking,
})

function openRevokeDialog(): void {
  if (!hasActiveScopedSession.value) return
  revokeError.value = null
  revokeHoldRemaining.value = REVOKE_HOLD_SEC
  showRevokeDialog.value = true
  if (revokeHoldHandle !== null) clearInterval(revokeHoldHandle)
  revokeHoldHandle = setInterval(() => {
    revokeHoldRemaining.value = Math.max(0, revokeHoldRemaining.value - 1)
    if (revokeHoldRemaining.value <= 0 && revokeHoldHandle !== null) {
      clearInterval(revokeHoldHandle)
      revokeHoldHandle = null
    }
  }, 1000)
}

function closeRevokeDialog(): void {
  if (revoking.value) return
  showRevokeDialog.value = false
  if (revokeHoldHandle !== null) {
    clearInterval(revokeHoldHandle)
    revokeHoldHandle = null
  }
}

async function onConfirmRevoke(): Promise<void> {
  const s = activeScopedSession.value
  if (!s || revoking.value || revokeHoldRemaining.value > 0) return
  revoking.value = true
  revokeError.value = null
  try {
    // On success: composable clears `session` (banner disappears) + arms
    // the global broker-purge reminder (the "sticky panel").
    await revokeScopedSession(s.sessionId)
    showRevokeDialog.value = false
    if (revokeHoldHandle !== null) {
      clearInterval(revokeHoldHandle)
      revokeHoldHandle = null
    }
    // Re-mint ergonomics: revoking leaves the tier at 'scoped', and you
    // can't step Scoped → Scoped (the state machine rejects same-tier), so
    // re-arming used to require a manual step-down THEN re-pick. Auto-reset
    // the MCP tier to Advisory here so re-arming is the normal one flow:
    // pick Scoped → confirm → mint. Best-effort — revoke already committed,
    // so a step-down hiccup just falls back to the manual path.
    try {
      const stepDown = await agentPolicyApi.requestTransition({
        surface: 'mcp',
        targetTier: 'advisory',
      })
      if (!stepDown.requiresConfirmation) {
        statesBySurface.value = { ...statesBySurface.value, mcp: stepDown.state }
        if (selectedSurface.value === 'mcp') targetTier.value = null
      }
    } catch {
      /* best-effort — leave the tier as-is; user can step down manually */
    }
    // The revoke zone is gone now (no active session) — re-open the tier
    // picker so the user can re-pick Scoped for a fresh session.
    showTierPicker.value = true
    toast.success('Scoped session revoked', {
      description: 'Pick Scoped again to mint a fresh session — and restart your broker to drop its old key.',
    })
    // A11y (R1 Issue 9): the revoke zone unmounted, so `useModalA11y`'s
    // focus-restore target (the "Revoke now" button) is gone and focus
    // would fall to <body>. Land focus on the now-visible tier picker so
    // the user keeps a logical position (the global purge reminder's
    // role="status" announces the outcome independently). nextTick so the
    // restore + re-render settle first.
    await nextTick()
    // A11y (FE-A11y #3): when the best-effort step-down FAILED the tier is
    // still scoped → the re-mint panel is now the rendered primary action,
    // so land focus there. Otherwise (step-down succeeded → Advisory) fall
    // back to the re-opened tier picker. Either way focus never falls to
    // <body> (the global purge reminder's role="status" announces the
    // outcome independently).
    const focusTarget =
      document.querySelector<HTMLElement>('[data-testid="policy-remint-panel"]')
      ?? document.querySelector<HTMLElement>('[data-testid="policy-tier-picker"]')
    if (focusTarget) {
      focusTarget.setAttribute('tabindex', '-1')
      focusTarget.focus({ preventScroll: true })
    }
  } catch (e) {
    // 409 = already terminal (race / double-tap across tabs). Humanise
    // for the inline dialog error; keep the dialog open so the user sees it.
    revokeError.value = humaniseError(e, 'Revoke failed')
  } finally {
    revoking.value = false
  }
}

const currentState = computed<AgentUserStateDto | null>(
  () => statesBySurface.value[selectedSurface.value] ?? null,
)

const currentTier = computed<Tier | null>(() => currentState.value?.tier ?? null)

// ── Wave 5 Option D · C4 re-smoke OPEN-A — direct Scoped re-mint ─────
// The mint ceremony was ONLY reachable as a post-commit step of a tier
// transition INTO scoped. An operator who lands already AT `scoped` with
// no live session (the prior one expired or was revoked) had no way to
// mint a fresh one — picking Scoped is `targetTier === currentTier` →
// "No change". The state below drives a dedicated "Mint a new session"
// panel for that stranded case.

// In-flight flag SPECIFIC to the direct re-mint (distinct from the shared
// `submitting`, which also covers transition commits). `needsReMint` is
// gated on `!submitting`, so without this the re-mint panel would unmount
// the instant its own button is clicked — hiding the "Minting…" spinner and
// flashing the tier picker mid-passkey-ceremony (multi-agent review:
// Frontend Dev MED-1 + Code Reviewer MED-1). This keeps the panel mounted
// (and the picker collapsed) for the whole direct-mint round-trip.
const submittingDirectReMint = ref(false)

// True when the user is stranded at the scoped tier with no live session.
// Gates, in order of why each matters:
//   - `!loadingState`: don't flash the panel during the initial cold load.
//   - `!submitting`: a TRANSITION→scoped flow is briefly "tier=scoped,
//     session not yet refreshed" while `submitting`; the direct re-mint
//     keeps its panel alive via `submittingDirectReMint` instead.
//   - `!revoking` + `scopedReveal === null`: suppress the one-tick flash on
//     revoke, and don't re-offer the panel under an open reveal modal.
//   - `currentTier === 'scoped'`: the MCP-broker autonomy tier is live
//     server-side (Scoped is hard-locked to surface 'mcp'), so the backend
//     mint tier-gate already passes.
//   - `!hasActiveScopedSession`: no revocable session (expired/revoked).
//     When one IS live the revoke zone owns the UI instead.
//   - `scopedRecoveryNeeded === null`: a failed transition-mint shows the
//     transition recovery strip (its own retry); don't double up.
const needsReMint = computed<boolean>(
  () =>
    !loadingState.value
    // `!submitting` suppresses the panel during a TRANSITION-into-scoped
    // mint (tier flips scoped before the session refreshes); the direct
    // re-mint keeps the panel alive via `submittingDirectReMint` below.
    && !submitting.value
    // `!revoking` suppresses the one-tick flash between a revoke resolving
    // (session cleared) and the best-effort step-down landing Advisory
    // (Code Reviewer MED-1).
    && !revoking.value
    // A successful mint opens the reveal modal before the mirror refresh
    // lands; don't re-offer the panel underneath it on a slow refresh
    // (Code Reviewer LOW-1).
    && scopedReveal.value === null
    && currentTier.value === 'scoped'
    && !hasActiveScopedSession.value
    && scopedRecoveryNeeded.value === null,
)

// When a Scoped session is live (revoke zone) OR re-mint is needed/in-flight,
// the tier picker collapses behind a "Change tier" disclosure so the primary
// action (revoke / re-mint) stays the focus. Stepping DOWN to a lower tier
// is still reachable by expanding the picker. `submittingDirectReMint` keeps
// it collapsed through the direct-mint ceremony.
const pickerForceCollapsed = computed<boolean>(
  () =>
    hasActiveScopedSession.value
    || needsReMint.value
    || submittingDirectReMint.value,
)

const canSubmit = computed<boolean>(() => {
  if (submitting.value) return false
  if (targetTier.value === null) return false
  if (targetTier.value === currentTier.value) return false
  if (currentTier.value === 'paused') return false
  // Scoped tier — additionally require the mhUSDC + TTL form to be valid
  // BEFORE any network hop. The backend Zod schema would bounce anyway,
  // but surfacing the violation inline avoids a confusing 400.
  if (scopedFormFailure.value) return false
  // F3 — a pending-but-expired token would 410 on commit; block the
  // explicit commit and force the user to re-request fresh. The
  // pendingExpired branch's "Start over" CTA handles this case.
  if (pendingExpired.value) return false
  return true
})

// Wave 5 Option D · Commit 4 (+ "pick any tier" follow-up, operator
// decisions 2026-05-24) — the forced tier climb is FULLY removed, so there
// is NO `stepUpGateFailure` gate anymore: any non-paused tier reaches any
// higher tier directly (the backend `requestUserTierChange` accepts it as a
// step-up). The ONLY remaining pre-condition is `scopedFormFailure` below
// (cap ≥ $1 + valid TTL), which stays REQUIRED for the Scoped tier. The
// security boundary is the confirmation-token tap + the Scoped mint
// ceremony (passkey + cap + TTL) + the on-chain per-tier policy / revoke
// rails — never the climb. See state-machine.ts JSDoc.

const scopedMaxPerOpUsd6 = computed<bigint | null>(() =>
  parseMhUsdcBase6(maxPerOpUsd6Input.value),
)

// Tier-transition Scoped form validity (cap ≥ $1 + valid TTL). Delegates
// to the pure `scopedParamsFailure` helper so the same rules are unit-
// tested + shared with the OPEN-A re-mint panel below.
const scopedFormFailure = computed<string | null>(() =>
  targetTier.value !== 'scoped'
    ? null
    : scopedParamsFailure(scopedMaxPerOpUsd6.value, ttlSecInput.value),
)

// Wave 5 Option D · C4 re-smoke OPEN-A — the direct re-mint panel has no
// `targetTier === 'scoped'` selection (the user is already AT scoped), so
// it needs its own validity gate over the SAME shared cap/TTL refs.
const reMintFormFailure = computed<string | null>(() =>
  needsReMint.value
    ? scopedParamsFailure(scopedMaxPerOpUsd6.value, ttlSecInput.value)
    : null,
)

const isStepUp = computed<boolean>(() => {
  if (!targetTier.value || !currentTier.value) return false
  // Step-up = broadening agent autonomy. Match backend transition-tier.use-case.
  if (currentTier.value === 'advisory' && targetTier.value === 'confirm-per-action') return true
  if (currentTier.value === 'confirm-per-action' && targetTier.value === 'policy-bound') return true
  if (currentTier.value === 'advisory' && targetTier.value === 'policy-bound') return true
  // Wave 5 Option D · Commit 4 (+ "pick any tier" follow-up) — the forced
  // climb is gone, but every UPWARD move is still a step-up: the
  // confirmation-token tap is the consent moment (mirrors the backend's
  // `RequestTierTransitionUseCase.isStepDown` allowlist). Ascending into
  // Scoped from any lower tier is always a step-up.
  if (targetTier.value === 'scoped' && currentTier.value !== 'scoped') return true
  return false
})

const submitLabel = computed<string>(() => {
  if (submitting.value) return 'Submitting…'
  if (pendingConfirmation.value) return 'Confirm transition'
  if (!targetTier.value) return 'Pick a tier'
  if (targetTier.value === currentTier.value) return 'No change'
  return isStepUp.value ? 'Request transition' : 'Apply tier change'
})

/**
 * F3 — Live remaining seconds on the pending confirmation token.
 * Returns 0 when no token is pending OR the token already expired.
 * 5-min TTL on issue (see backend ConfirmTokenService.DEFAULT_CONFIRM_TTL_MS).
 */
const pendingRemainingSec = computed<number>(() => {
  if (!pendingConfirmation.value) return 0
  const expMs = Date.parse(pendingConfirmation.value.expiresAt)
  if (Number.isNaN(expMs)) return 0
  return Math.max(0, Math.floor((expMs - nowMs.value) / 1000))
})

const pendingCountdownLabel = computed<string>(() => {
  const s = pendingRemainingSec.value
  if (s <= 0) return 'expired'
  const m = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return m > 0 ? `${m}m ${ss}s` : `${s}s`
})

const pendingExpired = computed<boolean>(
  () => pendingConfirmation.value !== null && pendingRemainingSec.value <= 0,
)

// ── Lifecycle ──────────────────────────────────────────────────────
onMounted(async () => {
  if (!authStore.isAuthenticated) {
    // Router guard already redirects to /login for non-public routes —
    // this is defence-in-depth in case the guard fires before our state
    // sync completes.
    void router.replace({ path: '/login', query: { redirect: '/agent/policy/transition' } })
    return
  }
  // Deep-link from HavenBot `set_policy` ConfirmModal → /agent/policy/transition?surface=…&target=…
  // pre-fills the picker so the operator doesn't have to re-select what
  // the LLM already proposed. Unknown values are silently dropped so a
  // stale link can't put the picker in an invalid state.
  const qSurface = route.query.surface
  if (isSurface(qSurface)) selectedSurface.value = qSurface
  const qTarget = route.query.target
  if (isPickableTier(qTarget)) targetTier.value = qTarget

  countdownHandle = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  await loadState()

  // Wave 5 Option D · Commit 4 — load the active Scoped session so the
  // revoke zone + the tier-picker disclosure render correctly. Best-effort
  // (the composable swallows errors into `session=null`).
  await refreshScopedSession()
  // When a session is live (revoke zone) OR the user is stranded at scoped
  // with no session (OPEN-A re-mint panel), collapse the tier picker so the
  // primary action stays the focus; otherwise leave it open.
  showTierPicker.value = !pickerForceCollapsed.value
  // Deep-link `?focus=revoke` from the dashboard banner — auto-focus the
  // "Revoke now" trigger (not scroll-only) once the zone has rendered.
  if (route.query.focus === 'revoke') {
    if (hasActiveScopedSession.value) {
      void Promise.resolve().then(() => {
        const el = document.querySelector<HTMLButtonElement>(
          '[data-testid="policy-revoke-now"]',
        )
        el?.focus()
        const reducedMotion =
          typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        el?.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'center',
        })
      })
    }
    // FE-R2 M-3 — strip the consumed one-shot deep-link param so a later
    // reload (or a fresh mint) doesn't keep auto-focusing the revoke zone.
    // Done regardless of whether a session was present so the intent
    // doesn't stick around.
    const { focus: _drop, ...restQuery } = route.query
    void router.replace({ query: restQuery })
  }
})

onBeforeUnmount(() => {
  if (countdownHandle !== null) {
    clearInterval(countdownHandle)
    countdownHandle = null
  }
  if (revokeHoldHandle !== null) {
    clearInterval(revokeHoldHandle)
    revokeHoldHandle = null
  }
})

async function loadState(): Promise<void> {
  loadingState.value = true
  fetchError.value = null
  try {
    const { surfaces } = await agentPolicyApi.getState()
    const next: Record<Surface, AgentUserStateDto | null> = {
      havenbot: null,
      mcp: null,
      openclaw: null,
      checkout: null,
    }
    for (const row of surfaces) next[row.surface] = row
    statesBySurface.value = next
  } catch (e) {
    fetchError.value = humaniseError(e, 'Could not load policy state')
  } finally {
    loadingState.value = false
  }
}

// ── Submit handlers ────────────────────────────────────────────────

function onSelectSurface(next: Surface): void {
  if (next === selectedSurface.value) return
  selectedSurface.value = next
  targetTier.value = null
  pendingConfirmation.value = null
  pendingScopedParams.value = null
  scopedRecoveryNeeded.value = null
  scopedRecoveryConsentHash.value = null
  transitionError.value = null
}

/**
 * Scoped autonomy is hard-locked to the MCP/Broker surface (the mint POST
 * always sends `surface: 'mcp'` and the backend mint precondition requires
 * the mcp surface to be at tier `scoped`). Picking Scoped while a non-mcp
 * surface is selected committed THAT surface → scoped, then the mint asked
 * for mcp@scoped → HTTP 412 + an orphaned tier the user had to step down
 * from. Disable the Scoped tier on non-mcp surfaces so the impossible state
 * can't be reached; HavenBot reuses the mcp-surface session (per-surface
 * Scoped is a future slice). `paused` disables every tier as before.
 */
function isTierDisabled(value: Tier): boolean {
  if (currentTier.value === 'paused') return true
  if (value === 'scoped' && selectedSurface.value !== 'mcp') return true
  return false
}

function onPickTier(next: Tier): void {
  if (currentTier.value === 'paused') return
  // Defense-in-depth against the disabled-button being activated anyway
  // (keyboard / programmatic): Scoped is only valid on the mcp surface.
  if (next === 'scoped' && selectedSurface.value !== 'mcp') return
  targetTier.value = next
  // Picking a different tier invalidates any in-flight confirmation
  // token — the actionHash would no longer match the new payload.
  pendingConfirmation.value = null
  pendingScopedParams.value = null
  // Clear any post-commit recovery state too: switching to a different
  // tier means the user's intent moved on; the orphan-tier recovery
  // CTAs no longer apply.
  scopedRecoveryNeeded.value = null
  scopedRecoveryConsentHash.value = null
  transitionError.value = null
  // R1 UX M-1 — when the user picks Scoped, focus the maxPerOpUsd6 input
  // so the form section is announced + scrolled into view. nextTick
  // ensures the v-if-mounted element exists before querySelector runs.
  // R2 A11y L-1 — honour `prefers-reduced-motion`; the existing CSS
  // reduced-motion overrides in global.css don't catch imperative
  // `scrollIntoView({behavior:'smooth'})`.
  if (next === 'scoped') {
    void Promise.resolve().then(() => {
      const el = document.querySelector<HTMLInputElement>(
        '[data-testid="policy-scoped-max-usd"]',
      )
      el?.focus()
      const reducedMotion =
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
      })
    })
  }
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || !targetTier.value) return
  submitting.value = true
  transitionError.value = null

  try {
    if (pendingConfirmation.value) {
      // Capture the actionHash BEFORE commit consumes the token — the
      // Scoped post-commit flow needs to anchor the snapshot's
      // `consentActionHash` to the consumed token per Compliance H-1.
      // Phase 1 returns bare-hex (no 0x prefix) per
      // `confirm-token.service.ts:101-104`; the snapshot field requires
      // `0x`-prefixed hex per `MintScopedSessionDtoSchema:HEX_32_BYTE_RE`
      // so we prefix at the populate boundary (matches the backend's
      // own `toChainAnchorHash` normalization in
      // `transition-tier.use-case.ts:44`).
      const consumedActionHash = prefixConsentActionHash(pendingConfirmation.value.actionHash)
      // Phase 2 — re-post with the token to commit.
      const res = await agentPolicyApi.commitTransition({
        surface: selectedSurface.value,
        targetTier: targetTier.value,
        confirmationToken: pendingConfirmation.value.token,
      })
      const landedTier = res.state.tier
      // R1 Code Reviewer MED-3 — silence the tier-transition toast when
      // the next step is the Scoped mint; the mint emits its own success
      // toast so a failed mint doesn't trail a misleading "Transition
      // confirmed" success message.
      onTransitionApplied(res.state, 'committed', {
        silent: landedTier === 'scoped',
      })
      // Wave 5 Path D Slice 1 Pickup A — Scoped post-commit ceremony.
      // Fires ONLY after the tier landed at `scoped` server-side so a
      // failed transition doesn't leave a snapshot orphan on the mirror.
      if (landedTier === 'scoped') {
        await mintScopedSession(consumedActionHash)
      }
    } else {
      // Phase 1 — issue the request.
      const res = await agentPolicyApi.requestTransition({
        surface: selectedSurface.value,
        targetTier: targetTier.value,
      })
      if (res.requiresConfirmation) {
        pendingConfirmation.value = res.confirmation
        // R1 UX H-4 — snapshot the Scoped params NOW so live-editing the
        // form between issue and commit doesn't silently change what the
        // second tap authorizes. The pending-confirmation hint reads
        // from this snapshot, not the live ref.
        if (targetTier.value === 'scoped' && scopedMaxPerOpUsd6.value !== null) {
          pendingScopedParams.value = {
            maxPerOpUsd6: scopedMaxPerOpUsd6.value,
            ttlSec: ttlSecInput.value,
          }
        }
        // For Wave 4, the dashboard's JWT session is already passkey-derived;
        // the confirmation token is bearer-bound to userId + actionHash so a
        // second click is the user's explicit confirmation step.
        toast('Confirm to grant agent autonomy', {
          description:
            'Step-ups require an explicit second tap. Click "Confirm transition" below.',
        })
      } else {
        onTransitionApplied(res.state, 'step-down')
      }
    }
  } catch (e) {
    transitionError.value = humaniseError(e, 'Transition rejected')
    // 410 on commit = token expired / consumed — clear it so the user can
    // re-request with a fresh one without a confusing "stale state" sticky.
    if (e instanceof ApiError && e.status === 410) {
      pendingConfirmation.value = null
    }
  } finally {
    submitting.value = false
  }
}

function onTransitionApplied(
  next: AgentUserStateDto,
  kind: 'committed' | 'step-down',
  opts?: { silent?: boolean },
): void {
  statesBySurface.value = { ...statesBySurface.value, [next.surface]: next }
  pendingConfirmation.value = null
  targetTier.value = null
  lastCommittedAt.value = next.updatedAt
  // R2 fresh-CR M-1 — any successful transition invalidates the
  // post-failed-mint recovery banner. Without these clears, a paused
  // → Advisory resume on a surface that had a stale recovery flag
  // would leave the banner visible against the new (irrelevant) tier.
  scopedRecoveryNeeded.value = null
  scopedRecoveryConsentHash.value = null
  // R1 Code Reviewer MED-3 — Scoped post-commit ceremony fires its own
  // success toast AFTER the mint + POST land; defer the tier-transition
  // toast in that case so a failed mint doesn't surface "success" above
  // a "Tier landed at Scoped, but session-key mint failed" red ribbon.
  if (opts?.silent) return
  toast.success(
    kind === 'step-down'
      ? `Tier set to ${formatTier(next.tier)}`
      : `Transition confirmed — now ${formatTier(next.tier)}`,
    { description: `Surface: ${formatSurface(next.surface)}` },
  )
}

/**
 * Wave 5 Path D Slice 1 Pickup A — Scoped session-key mint ceremony.
 * Runs AFTER `commitTransition` lands `tier === 'scoped'` server-side.
 *
 * Three steps:
 *   1. Mint a fresh ephemeral EOA + Scoped PermissionValidator locally
 *      via `walletStore.installScopedSessionKey`. Captures
 *      `permissionId` and threads it through `buildScopedMintBody`
 *      (Pickup B) so the broker can compose the Kernel v3.1 24-byte
 *      nonce-key composite at sign time.
 *   2. POST the snapshot to the backend mirror
 *      (`/api/v1/agent/policy/scoped-session`). The MCP auto-sync
 *      (Commit 2.B) pulls from this mirror on the next position.buy
 *      and installs into the broker via IPC — bridging the dashboard's
 *      browser-sandbox / Unix-socket transport gap.
 *   3. Open SessionKeyRevealModal pre-seeded with the freshly-minted
 *      key so the operator can run `muhaven-broker update --session <key>`
 *      on the broker machine (installs the key + (re)starts the daemon).
 *
 * **Failure handling**: if the mint or POST throws, the tier already
 * landed at 'scoped' server-side (Phase 2 already committed). Surface a
 * `transitionError` so the operator sees the failure inline. The user
 * has two recoveries: (a) revoke the orphaned tier via step-down then
 * retry, or (b) re-attempt the snapshot POST (idempotent on sessionId).
 * Mirroring the orphan-tier risk explicitly here closes the gap that an
 * R1 fresh CR would flag.
 */
async function mintScopedSession(
  consentActionHash: `0x${string}` | null,
  opts?: { isDirectReMint?: boolean },
): Promise<void> {
  // Seed the transition-flow recovery strip after a post-commit failure
  // (the tier already landed at Scoped server-side, so the user must not be
  // stranded without a retry / step-down CTA). SKIPPED on the OPEN-A direct
  // re-mint path: there the tier was ALREADY scoped (no transition just
  // happened), `needsReMint` stays true, and the re-mint panel itself is the
  // retry surface — the transition recovery strip's "step down to
  // Policy-bound" copy would be misleading there.
  const seedRecovery = (): void => {
    if (opts?.isDirectReMint) return
    scopedRecoveryConsentHash.value = consentActionHash
    scopedRecoveryNeeded.value = 'retry-mint'
  }
  // R1 UX H-4 — pull from `pendingScopedParams` (captured at Phase 1
  // issue) rather than the live form refs, so a user who edits the
  // input AFTER issuing the ConfirmToken still commits the value they
  // originally authorized. If pendingScopedParams is null we're being
  // called from a retry-recovery path that pre-validated the bounds;
  // fall back to the live refs in that case.
  const cap = pendingScopedParams.value?.maxPerOpUsd6 ?? scopedMaxPerOpUsd6.value
  const ttl = pendingScopedParams.value?.ttlSec ?? ttlSecInput.value
  if (!cap) {
    transitionError.value = 'Internal: mhUSDC ceiling parsed to null after canSubmit gate — refresh and retry.'
    // R2 Reality Check MED-2 — every early-return AFTER the tier
    // already landed at Scoped server-side MUST seed the recovery
    // state so the user has a retry / step-down CTA. Without these,
    // an internal-state failure would strand the user with an orphan
    // tier and no in-page recovery.
    seedRecovery()
    return
  }
  // NAV-1:1 conversion (mhUSDC base-6 → whole shares). Correct for TBILL1
  // (NAV $1) which is the Pickup A smoke target. Other tokens (NAV ≠ $1)
  // will land a structurally-correct snapshot whose `selectorCaps[0]
  // .maxAmount` cap differs from the user-intent `maxPerOpUsd6`; Pickup B
  // (real per-token NAV math) refines. Slice 4 wildcard's cumulative-spend
  // ledger uses `maxPerOpUsd6` directly so the dollar ceiling stays
  // honest regardless of per-token NAV skew.
  const maxSharesPerOp = cap / 1_000_000n
  // R1 SecEng MED-1 — defense-in-depth against integer-truncation defeat
  // of the cap. The form's $1 floor (`scopedFormFailure`) already enforces
  // `cap >= 1_000_000n` at the UI gate, so `maxSharesPerOp` MUST be ≥ 1.
  // This block surfaces a clean error if a future refactor relaxes the
  // form floor without revisiting the shares math.
  if (maxSharesPerOp <= 0n) {
    transitionError.value =
      'Internal: max-shares-per-op rounded to zero. The mhUSDC ceiling must be at least $1 mhUSDC.'
    // R2 Reality Check MED-2 — same orphan-tier risk as above; seed
    // recovery state so the user can retry or step down.
    seedRecovery()
    return
  }
  // R1 Frontend M-1 — defensive against a build where
  // `VITE_SUBSCRIPTION_ADDRESS` is unset; `addresses.ts` falls back to
  // the zero address. The backend Zod schema accepts any 20-byte hex
  // and would land a structurally-correct but operationally-useless
  // snapshot that authorizes nothing real. Fail loud here.
  if (
    v35Addresses.subscription
    === '0x0000000000000000000000000000000000000000'
  ) {
    transitionError.value =
      'Subscription contract address is not configured for this environment. Cannot mint a Scoped session.'
    seedRecovery()
    return
  }

  let installed: ScopedSessionInstallResult | null
  try {
    installed = await walletStore.installScopedSessionKey({
      maxPerOpUsd6: cap,
      maxSharesPerOp,
      ttlSec: ttl,
    })
  } catch (e) {
    transitionError.value = humaniseError(
      e,
      'Tier landed at Scoped, but session-key mint failed',
    )
    // R1 UX H-3 — surface recovery CTAs. Preserve the consent hash so a
    // retry re-uses the originally-confirmed token's audit-chain anchor.
    seedRecovery()
    return
  }
  if (!installed) {
    transitionError.value =
      'Tier landed at Scoped, but the wallet provider returned no session-key. Reconnect your wallet and retry the mint.'
    seedRecovery()
    return
  }

  const sessionId = newScopedSessionId()
  // R1 Code Reviewer LOW-3 — viem `privateKeyToAccount.address` returns
  // EIP-55 checksummed; backend lowercases on persist + the broker
  // compares case-insensitively. Lowercase here so the POST round-trips
  // byte-equal with the persisted row and any future raw-SQL audit JOIN
  // doesn't break on case mismatch.
  // R2 Reality Check MED-1 — surface HARD-LOCKED to `'mcp'` per the
  // operator-confirmed Pickup A design decision. The MCP auto-sync
  // (Commit 2.B) only pulls mirror rows with `surface='mcp'`; a Scoped
  // session POSTed under any other surface would silently never reach
  // the broker. Even though `selectedSurface` might be HavenBot /
  // OpenClaw / Checkout when the user is just configuring policy for
  // those surfaces, the Scoped tier ITSELF is an MCP-broker autonomy
  // scope. Backend mirror's `(user_id, surface)` partial UNIQUE lets a
  // Telegram-surface Scoped session co-exist later without conflict.
  const body: MintScopedSessionRequest = buildScopedMintBody({
    sessionId,
    signerAddress: installed.signerAddress.toLowerCase() as `0x${string}`,
    subscriptionAddress: v35Addresses.subscription.toLowerCase() as `0x${string}`,
    maxPerOpUsd6: cap,
    maxSharesPerOp,
    // Wave 5 Slice 1 (MCP sell) — authorize autonomous queued-sell to every
    // per-token RedemptionQueue. The on-chain envelope already permits
    // submit/claim on each, so this is no-re-mint. Empty when no queues are
    // onboarded → the helper omits the submit cap.
    redemptionQueueAddresses: Object.values(v35Addresses.queues),
    mintedAtSec: installed.mintedAtSec,
    validUntilSec: installed.validUntilSec,
    // null (OPEN-A direct re-mint — no transition token) → undefined so the
    // helper omits the field; the backend `consentActionHash` is optional.
    consentActionHash: consentActionHash ?? undefined,
    surface: 'mcp',
    // Pickup B — thread the PermissionValidator's identifier into the
    // snapshot so the MCP server can compose the Kernel v3.1 24-byte
    // nonce-key composite. Without this, every Path D send falls back
    // at `no_permission_id_in_snapshot`. The helper internally
    // lowercases + shape-asserts (`^0x[0-9a-f]{8}$`) so we don't need
    // to normalize here. R1 multi-agent review M-3 absorbed.
    permissionId: installed.permissionId,
    // Wave 5 Option D · Commit 2 — capture install material so the
    // MCP-side MODE.ENABLE UserOp (C3) can install the validator
    // on-chain without a second passkey ceremony. The provider's
    // installScopedSessionKey already triggered ONE WebAuthn ceremony
    // to sign the typed data; the broker re-uses that signature.
    enableData: installed.enableData,
    enableSig: installed.enableSig,
    validatorNonce: installed.validatorNonce,
  })

  try {
    await agentPolicyApi.mintScopedSession(body)
  } catch (e) {
    transitionError.value = humaniseError(
      e,
      'Tier landed at Scoped, but the policy-snapshot POST failed',
    )
    seedRecovery()
    return
  }

  // Success — surface the privateKey for paste into the broker. The
  // reveal modal closes the gap that broker IPC isn't reachable from
  // the browser: the user copies + pastes + restarts daemon, then the
  // MCP auto-sync (Commit 2.B) bridges the snapshot on next position.buy.
  scopedReveal.value = installed
  scopedRecoveryNeeded.value = null
  scopedRecoveryConsentHash.value = null
  pendingScopedParams.value = null
  // Wave 5 Option D · Commit 4 — re-read the mirror so the revoke zone +
  // the global banner pick up the freshly-minted session, and collapse
  // the tier picker (the session is now the focus).
  await refreshScopedSession()
  showTierPicker.value = false
  toast.success('Scoped session minted', {
    description: 'Copy the one-paste “muhaven-broker update --session …” command and run it on your broker.',
  })
}

/**
 * R1 UX H-3 — retry the Scoped mint after a post-commit failure left
 * the user with an orphaned tier=scoped server-state. Re-uses the
 * originally-confirmed `scopedRecoveryConsentHash` so the audit-chain
 * stable-key JOIN stays anchored to the confirmed token (no fresh
 * Phase 1 needed — the tier already landed).
 */
async function onScopedRetryMint(): Promise<void> {
  if (!scopedRecoveryConsentHash.value) {
    transitionError.value = 'Internal: missing consent anchor on retry. Step down to Policy-bound and re-do the transition.'
    return
  }
  if (submitting.value) return
  submitting.value = true
  transitionError.value = null
  try {
    await mintScopedSession(scopedRecoveryConsentHash.value)
  } finally {
    submitting.value = false
  }
}

/**
 * R1 UX H-3 — step down from the orphaned tier=scoped back to
 * Policy-bound so the user can re-attempt cleanly. Step-downs commit
 * without a Phase-2 confirmation (the state-machine auto-applies per
 * `requestUserTierChange`); we just call requestTransition + apply.
 */
async function onScopedStepDownRecover(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  transitionError.value = null
  try {
    const res = await agentPolicyApi.requestTransition({
      surface: selectedSurface.value,
      targetTier: 'policy-bound',
    })
    if (res.requiresConfirmation) {
      // Defensive — Scoped → PolicyBound is a step-down per
      // `state-machine.ts:181-189`. If this branch ever fires the
      // assumption changed; surface a clean error instead of silently
      // leaving the user in a half-broken state.
      transitionError.value =
        'Step-down unexpectedly required confirmation. Re-pick Policy-bound from the tier card to complete.'
      return
    }
    onTransitionApplied(res.state, 'step-down')
    scopedRecoveryNeeded.value = null
    scopedRecoveryConsentHash.value = null
    // R1 Frontend H-1 — symmetric cleanup so a subsequent picker
    // selection doesn't inherit stale Phase-1 snapshot state.
    pendingScopedParams.value = null
  } catch (e) {
    transitionError.value = humaniseError(e, 'Step-down recovery rejected')
  } finally {
    submitting.value = false
  }
}

/**
 * Wave 5 Option D · C4 re-smoke OPEN-A — mint a fresh Scoped session when
 * the user is ALREADY at the `scoped` tier but has no live session (the
 * prior one expired or was revoked). No tier transition / confirmation
 * token is involved: the tier is already committed server-side, and the
 * WebAuthn passkey ceremony inside `installScopedSessionKey` is the
 * user-present consent (the backend `MintScopedSessionDtoSchema`
 * `consentActionHash` is `.optional()` — so we pass `null`).
 *
 * Reuses the SAME `mintScopedSession` ceremony (mint local signer → POST
 * snapshot → reveal broker key → refresh) as the transition path, with
 * `isDirectReMint: true` so a failure leaves the re-mint panel in place as
 * the retry surface rather than seeding the transition recovery strip.
 */
async function onDirectReMint(): Promise<void> {
  // Defensive: only valid in the stranded re-mint state. The button's
  // `:disabled` already gates on these, but a stale click (e.g. the session
  // refreshed into existence between render and click) must no-op.
  if (!needsReMint.value || submitting.value) return
  if (reMintFormFailure.value) return
  submitting.value = true
  // Keep the re-mint panel mounted (+ picker collapsed) through the
  // ceremony so its "Minting…" spinner shows and the picker doesn't flash.
  submittingDirectReMint.value = true
  transitionError.value = null
  try {
    await mintScopedSession(null, { isDirectReMint: true })
  } finally {
    submitting.value = false
    submittingDirectReMint.value = false
  }
}


/**
 * F2 — Resume CTA when the current surface is paused. Backend's
 * ResumeAgentUseCase requires `tier === Paused` (else rejects) and always
 * lands the resumed surface in Advisory per ADR-0 §"Allowed transitions".
 * Since the Option D · C4 "pick any tier" follow-up, re-arming from there
 * is the user's choice (any tier is one confirm tap away — no forced
 * re-climb); we mirror the Advisory landing tier in local state so the
 * picker comes alive immediately.
 */
async function onResume(): Promise<void> {
  if (resuming.value) return
  if (currentTier.value !== 'paused') return
  resuming.value = true
  transitionError.value = null
  try {
    const res = await agentPolicyApi.resume({ surface: selectedSurface.value })
    onTransitionApplied(res.state, 'step-down')
  } catch (e) {
    transitionError.value = humaniseError(e, 'Resume rejected')
  } finally {
    resuming.value = false
  }
}

/**
 * F3 — "Start over" path when the confirmation token expired. Clears
 * the pending token; the user re-clicks Submit to mint a fresh one.
 * Same shape as `onPickTier` w/r/t state reset, but doesn't change the
 * tier selection (the user's intent was preserved).
 */
function onRestartConfirmation(): void {
  pendingConfirmation.value = null
  // R1 Frontend H-1 — clear the issue-time snapshot too so a future
  // caller that reads `pendingScopedParams` outside the v-if gate
  // doesn't see the prior tap's authorization.
  pendingScopedParams.value = null
  transitionError.value = null
}

// ── Helpers ────────────────────────────────────────────────────────

// `formatTier` + `formatTtlLabel` live in `policy-scoped.helpers.ts` so
// the unit tests can guard the `'scoped'` branch + unknown-literal
// fallthrough without mounting the Vue component (R2 fresh-CR H-1).

function formatSurface(s: Surface): string {
  return SURFACE_OPTIONS.find((opt) => opt.value === s)?.label ?? s
}

function humaniseError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string } | null
    if (body?.message) return body.message
    return `${fallback} (HTTP ${e.status})`
  }
  return e instanceof Error ? e.message : fallback
}
</script>

<template>
  <div class="flex flex-col gap-6 max-w-3xl mx-auto pb-12">
    <!-- Hero / explainer strip -->
    <section
      data-testid="policy-page-hero"
      class="rounded-2xl border border-haze dark:border-white/5
             bg-gradient-to-br from-mist/60 via-white/40 to-haze/30
             dark:from-[#171717]/60 dark:via-[#1c1b1b]/60 dark:to-[#171717]/60
             backdrop-blur-md p-5 md:p-6"
    >
      <div class="flex items-start gap-4">
        <div
          class="w-10 h-10 rounded-full bg-gold/12 dark:bg-signal/12
                 flex items-center justify-center flex-shrink-0"
        >
          <ShieldCheck :size="18" :stroke-width="1.8" class="text-compute dark:text-signal" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-1">
            Agent autonomy
          </p>
          <h1 class="font-accent text-[1.5rem] leading-tight text-midnight dark:text-white">
            Choose how much your agent can do without asking
          </h1>
          <p class="font-sans text-[13px] leading-relaxed text-midnight/80 dark:text-white/80 mt-2">
            Each tier sets what your agent (HavenBot, MCP broker, OpenClaw,
            Checkout) can do on your behalf. Pick any tier directly — raising
            autonomy needs a confirming tap; lowering it applies at once. A
            breach pauses the surface; resuming returns to
            <span class="font-mono">Advisory</span>, where you re-arm.
          </p>
        </div>
      </div>
    </section>

    <!-- Loading state -->
    <MPageLoader
      v-if="loadingState"
      label="Reading current tier"
      caption="Fetching per-surface agent state"
    />

    <!-- Cold error -->
    <div
      v-else-if="fetchError"
      class="flex flex-col items-center justify-center py-12 gap-4 rounded-2xl
             border border-negative/40 bg-negative/5"
    >
      <AlertTriangle :size="28" class="text-negative" />
      <p class="text-base text-compute dark:text-body-dark">{{ fetchError }}</p>
      <MButton variant="outline" @click="loadState">Retry</MButton>
    </div>

    <template v-else>
      <!-- Surface picker -->
      <section
        data-testid="policy-surface-picker"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-white/40 dark:bg-[#1c1b1b]/40 backdrop-blur-md p-5 md:p-6"
      >
        <p
          class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-3"
        >
          Surface
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button
            v-for="opt in SURFACE_OPTIONS"
            :key="opt.value"
            type="button"
            :aria-pressed="selectedSurface === opt.value"
            :data-testid="`policy-surface-${opt.value}`"
            :class="[
              'text-left rounded-xl border px-4 py-3 transition-all duration-150 cursor-pointer',
              selectedSurface === opt.value
                ? 'border-compute/40 dark:border-signal/40 bg-gold/8 dark:bg-signal/8 ring-1 ring-compute/30 dark:ring-signal/30'
                : 'border-haze dark:border-white/10 hover:bg-mist/60 dark:hover:bg-white/5',
            ]"
            @click="onSelectSurface(opt.value)"
          >
            <div class="flex items-center justify-between mb-1">
              <span
                class="font-sans text-sm font-semibold text-midnight dark:text-white"
              >{{ opt.label }}</span>
              <span
                v-if="statesBySurface[opt.value]"
                class="font-mono text-[10px] text-cool dark:text-body-dark/70"
              >{{ formatTier(statesBySurface[opt.value]?.tier) }}</span>
            </div>
            <p class="font-sans text-[12px] text-cool leading-relaxed">{{ opt.description }}</p>
          </button>
        </div>
      </section>

      <!-- Current state strip -->
      <section
        data-testid="policy-current-state"
        class="flex items-center gap-3 p-4 rounded-xl
               border border-haze dark:border-white/5
               bg-mist/40 dark:bg-[#0d0e10]/60"
      >
        <div
          class="w-9 h-9 rounded-full bg-gold/12 dark:bg-signal/12
                 flex items-center justify-center"
        >
          <Layers :size="14" :stroke-width="1.8" class="text-compute dark:text-signal" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
            Current
          </p>
          <p
            class="font-sans text-sm font-semibold text-midnight dark:text-white"
            data-testid="policy-current-tier"
          >
            {{ formatTier(currentTier) }}
            <span v-if="currentTier === 'paused'" class="ml-2 text-negative text-xs">
              · paused
            </span>
          </p>
        </div>
        <!-- Informational only. As of the Option D · C4 "pick any tier"
             follow-up these counters NO LONGER gate any tier change
             (any tier is one confirm tap away); they're shown as session
             activity so the label makes that explicit (FE-R2 L2). -->
        <div
          v-if="currentState"
          class="text-right text-[11px] text-cool dark:text-body-dark/70"
        >
          <p class="text-[9px] uppercase tracking-[0.18em] text-cool/70 mb-0.5">
            Session activity · not required for tier changes
          </p>
          <p>
            Confirmed actions:
            <span class="font-mono text-midnight dark:text-white">
              {{ currentState.confirmedActionCount }}
            </span>
          </p>
          <p>
            Risk Q&amp;A:
            <span
              :class="currentState.riskQuestionnaireComplete
                ? 'text-positive font-semibold'
                : 'text-cool/80'"
            >
              {{ currentState.riskQuestionnaireComplete ? 'complete' : 'pending' }}
            </span>
          </p>
        </div>
      </section>

      <!-- F2 — Resume panel. Replaces the prior "resume from Activity"
           inline hint, which pointed at a page that doesn't expose this
           action. Only shows when currentTier is paused; clicking calls
           POST /policy/resume which lands the surface back in Advisory. -->
      <section
        v-if="currentTier === 'paused'"
        data-testid="policy-resume-panel"
        class="p-4 rounded-xl border border-gold/40 bg-gold/8 space-y-3"
      >
        <div class="flex items-start gap-2">
          <PlayCircle :size="16" class="mt-0.5 flex-shrink-0 text-compute dark:text-signal" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-compute dark:text-signal">
              Resume this surface
            </p>
            <p class="text-[12px] text-compute dark:text-body-dark leading-relaxed mt-0.5">
              <span class="font-mono">{{ formatSurface(selectedSurface) }}</span>
              is paused. Resuming lands you back in
              <span class="font-mono">Advisory</span>; from there you can
              re-arm any tier directly with a fresh confirmation.
            </p>
          </div>
        </div>
        <MButton
          variant="primary"
          :disabled="resuming"
          data-testid="policy-resume-cta"
          @click="onResume"
        >
          <Loader2 v-if="resuming" :size="14" class="animate-spin" />
          <PlayCircle v-else :size="14" />
          {{ resuming ? 'Resuming…' : 'Resume to Advisory' }}
        </MButton>
      </section>

      <!-- Wave 5 Option D · Commit 4 — revoke zone. Shown whenever a live
           Scoped session exists (independent of the surface picker — a
           Scoped session is always the MCP-broker autonomy scope). Distinct
           negative tint vs the gold pending/recovery strips so the
           kill-switch reads as a destructive control (UX). -->
      <section
        v-if="hasActiveScopedSession"
        data-testid="policy-revoke-zone"
        class="rounded-2xl border border-negative/40 bg-negative/5
               dark:border-negative/30 dark:bg-negative/10 p-5 md:p-6 space-y-4"
      >
        <div class="flex items-start gap-3">
          <div
            class="w-9 h-9 rounded-full bg-negative/12 flex items-center justify-center flex-shrink-0"
          >
            <ShieldOff :size="16" :stroke-width="1.8" class="text-negative" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-negative/90 font-semibold mb-0.5">
              Active scoped session
            </p>
            <h2 class="font-accent text-[1.15rem] leading-tight text-midnight dark:text-white">
              Your agent can sign autonomous buys & sells right now
            </h2>
          </div>
        </div>

        <dl
          data-testid="policy-revoke-meta"
          class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12px]"
        >
          <div>
            <dt class="text-cool">Signer</dt>
            <dd class="font-mono text-midnight dark:text-white truncate">
              {{ signerPrefix(activeScopedSession?.signerAddress) }}
            </dd>
          </div>
          <div>
            <dt class="text-cool">Expires in</dt>
            <dd
              class="font-mono text-midnight dark:text-white"
              data-testid="policy-revoke-expiry"
            >{{ scopedExpiresLabel }}</dd>
          </div>
          <div>
            <dt class="text-cool">Minted</dt>
            <dd class="font-mono text-midnight dark:text-white truncate">{{ scopedMintedLabel }}</dd>
          </div>
          <div>
            <dt class="text-cool">Per-trade cap</dt>
            <dd class="font-mono text-midnight dark:text-white">
              {{ formatMhUsdc6(activeScopedSession?.maxPerOpUsd6) }} mhUSDC
            </dd>
          </div>
          <div>
            <dt class="text-cool">Scope</dt>
            <dd class="font-mono text-midnight dark:text-white">
              Buys &amp; sells
            </dd>
          </div>
          <div>
            <dt class="text-cool">Permission</dt>
            <dd class="font-mono text-midnight dark:text-white">
              {{ permissionIdPrefix(activeScopedSession?.permissionId) }}
            </dd>
          </div>
        </dl>

        <!-- Wave 5 Slice 2c — auto-reinvest opt-in. A POSITIVE control
             nested in the (destructive-tinted) active-session zone, given
             its own neutral surface + an explicit switch so it never reads
             as part of the revoke action. Default OFF; the keyless runner
             only claims+buys when this is ON. -->
        <div
          data-testid="policy-reinvest-toggle"
          class="rounded-xl border border-haze/70 dark:border-white/10
                 bg-frost/60 dark:bg-white/5 p-4 flex items-start gap-3"
          role="group"
          aria-labelledby="reinvest-toggle-label"
        >
          <div
            class="w-9 h-9 rounded-full bg-compute/10 dark:bg-signal/10 flex items-center justify-center flex-shrink-0"
          >
            <Repeat2 :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-3">
              <p
                id="reinvest-toggle-label"
                class="font-sans text-[13px] font-semibold text-midnight dark:text-white"
              >
                Auto-reinvest matured yield
              </p>
              <button
                type="button"
                role="switch"
                :aria-checked="reinvestOn ? 'true' : 'false'"
                aria-labelledby="reinvest-toggle-label"
                :aria-describedby="'reinvest-toggle-desc' + (reinvestError ? ' reinvest-toggle-error' : '')"
                :disabled="reinvestBusy"
                data-testid="policy-reinvest-switch"
                @click="onToggleReinvest"
                class="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full
                       transition-colors duration-150 cursor-pointer
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-compute/60
                       disabled:opacity-60 disabled:cursor-wait"
                :class="reinvestOn ? 'bg-compute dark:bg-signal' : 'bg-haze dark:bg-white/15'"
              >
                <span
                  class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150"
                  :class="reinvestOn ? 'translate-x-[1.375rem]' : 'translate-x-0.5'"
                >
                  <Loader2
                    v-if="reinvestBusy"
                    :size="12"
                    class="m-1 animate-spin text-compute"
                    aria-hidden="true"
                  />
                </span>
              </button>
            </div>
            <p
              id="reinvest-toggle-desc"
              class="mt-1 text-[12px] text-compute dark:text-body-dark leading-relaxed"
            >
              When ON, the agent headlessly claims your matured yield and buys more of the same
              RWA in one atomic transaction — bounded by your per-trade cap, the 8h session TTL,
              and this kill-switch. The reinvested amount is a fixed budget (the exact yield stays
              encrypted). Default OFF.
            </p>
            <p
              v-if="reinvestError"
              id="reinvest-toggle-error"
              role="alert"
              data-testid="policy-reinvest-error"
              class="mt-1.5 text-[12px] font-medium text-negative"
            >
              {{ reinvestError }}
            </p>
          </div>
        </div>

        <p
          data-testid="policy-revoke-cost"
          class="text-[12px] text-compute dark:text-body-dark leading-relaxed"
        >
          Revoking flips the backend mirror to <span class="font-mono">revoked</span> so the
          broker stops receiving your policy. Restoring autonomous trading afterwards means
          re-walking the Scoped consent (one confirm tap), minting + pasting a fresh broker
          key, and restarting the broker daemon — typically ~2–3 minutes hands-on.
        </p>

        <button
          type="button"
          data-testid="policy-revoke-now"
          @click="openRevokeDialog"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg cursor-pointer
                 text-sm font-sans font-semibold text-white
                 bg-negative hover:bg-negative/90 transition-colors duration-150
                 shadow-[0_4px_14px_rgba(220,38,38,0.22)]"
        >
          <ShieldOff :size="14" aria-hidden="true" />
          Revoke now
        </button>
      </section>

      <!-- Wave 5 Option D · C4 re-smoke OPEN-A — direct re-mint panel.
           Shown when the user is AT the scoped tier but has NO live session
           (expired by TTL / revoked), so the tier picker would only offer
           "No change". Mints a fresh broker session WITHOUT a tier
           transition — the passkey ceremony inside `installScopedSessionKey`
           is the consent (backend `consentActionHash` is optional). Binds
           the SAME cap/TTL refs as the transition Scoped form; styled to
           read as the primary action (the picker collapses behind the
           "Change tier" disclosure below for the step-down case). -->
      <section
        v-if="needsReMint || submittingDirectReMint"
        data-testid="policy-remint-panel"
        class="rounded-2xl border border-gold/40 bg-gold/8
               dark:border-signal/30 dark:bg-signal/8 p-5 md:p-6 space-y-4"
      >
        <div class="flex items-start gap-3">
          <div
            class="w-9 h-9 rounded-full bg-gold/15 dark:bg-signal/12
                   flex items-center justify-center flex-shrink-0"
          >
            <KeyRound :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-0.5">
              Scoped autonomy · no active session
            </p>
            <h2 class="font-accent text-[1.15rem] leading-tight text-midnight dark:text-white">
              Mint a fresh broker session
            </h2>
            <p class="font-sans text-[12px] text-compute dark:text-body-dark leading-relaxed mt-1">
              You're set to <span class="font-mono">Scoped autonomy</span> on the
              <span class="font-mono">MCP / Broker</span> surface, but there's no live
              session — the previous one expired or was revoked. Set the per-trade ceiling
              and length, then confirm with your passkey to mint a new broker key.
            </p>
          </div>
        </div>

        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-[12px] font-semibold text-midnight dark:text-white">
            Max mhUSDC per autonomous trade
          </span>
          <input
            v-model="maxPerOpUsd6Input"
            type="text"
            inputmode="decimal"
            placeholder="100"
            data-testid="policy-remint-max-usd"
            :disabled="submitting"
            :aria-invalid="reMintFormFailure !== null"
            :aria-describedby="reMintFormFailure ? 'policy-remint-form-error' : undefined"
            class="rounded-lg border border-haze dark:border-white/10
                   bg-white/60 dark:bg-[#0d0e10]/60
                   px-3 py-2 font-mono text-sm text-midnight dark:text-white
                   focus:outline-none focus:ring-2 focus:ring-gold/40
                   disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <span class="font-sans text-[11px] text-cool leading-relaxed">
            The agent signs autonomous buys & sells up to this per-trade ceiling
            (mhUSDC value; for a sell it's the proceeds cap).
          </span>
        </label>

        <div class="flex flex-col gap-1.5">
          <span
            id="policy-remint-ttl-label"
            class="font-sans text-[12px] font-semibold text-midnight dark:text-white"
          >
            Session length
          </span>
          <div
            role="group"
            aria-labelledby="policy-remint-ttl-label"
            data-testid="policy-remint-ttl"
            class="grid grid-cols-3 sm:grid-cols-5 gap-1.5"
          >
            <button
              v-for="opt in SCOPED_TTL_CHOICES"
              :key="opt.sec"
              type="button"
              :aria-pressed="ttlSecInput === opt.sec"
              :disabled="submitting"
              :data-testid="`policy-remint-ttl-${opt.sec}`"
              :class="[
                'rounded-lg border px-2 py-2 text-[12px] font-mono transition-colors duration-150',
                ttlSecInput === opt.sec
                  ? 'border-gold/50 dark:border-signal/50 bg-gold/10 dark:bg-signal/8 ring-1 ring-gold/30 dark:ring-signal/30 text-compute dark:text-signal'
                  : 'border-haze dark:border-white/10 text-midnight dark:text-white hover:bg-mist/60 dark:hover:bg-white/5',
                submitting ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
              ]"
              @click="ttlSecInput = opt.sec"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <p
          v-if="reMintFormFailure"
          id="policy-remint-form-error"
          data-testid="policy-remint-form-error"
          role="alert"
          class="px-3 py-2 rounded-lg border border-negative/40 bg-negative/5
                 text-[12px] text-negative leading-relaxed"
        >
          <AlertTriangle :size="11" class="inline -mt-0.5 mr-1" aria-hidden="true" />
          {{ reMintFormFailure }}
        </p>

        <MButton
          variant="primary"
          :disabled="submitting || reMintFormFailure !== null"
          data-testid="policy-remint-submit"
          @click="onDirectReMint"
        >
          <Loader2 v-if="submitting" :size="14" class="animate-spin" />
          <KeyRound v-else :size="14" />
          {{ submitting ? 'Minting…' : 'Mint a new session' }}
        </MButton>
      </section>

      <!-- Tier-picker disclosure — when a Scoped session is live (revoke
           zone) OR re-mint is needed (panel above), the picker collapses
           behind a "Change tier" affordance so the primary action stays
           the visual focus (UX HIGH-2). Expand it to step DOWN to a lower
           tier. -->
      <button
        v-if="pickerForceCollapsed && !showTierPicker"
        type="button"
        data-testid="policy-change-tier-toggle"
        @click="showTierPicker = true"
        class="inline-flex items-center gap-1.5 self-start px-3 py-2 rounded-lg cursor-pointer
               text-[12px] font-sans font-medium text-cool
               border border-haze dark:border-white/10
               hover:bg-mist/60 dark:hover:bg-white/5 transition-colors"
      >
        <ChevronDown :size="13" />
        Change tier
      </button>

      <!-- Tier picker (collapsible when an active session exists) -->
      <section
        v-show="!pickerForceCollapsed || showTierPicker"
        data-testid="policy-tier-picker"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-white/40 dark:bg-[#1c1b1b]/40 backdrop-blur-md p-5 md:p-6"
      >
        <p
          class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-3"
        >
          Target tier
        </p>
        <!-- 2×2 grid at md+ — UX-Architect H-1: `lg:grid-cols-4` inside
             `max-w-3xl` cramped each card to ~178px on standard laptops,
             forcing 5-6 line blurb wraps with uneven card heights. 2×2
             at every desktop breakpoint reads cleanly + gives the new
             Scoped blurb room to breathe. -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            v-for="opt in TIER_OPTIONS"
            :key="opt.value"
            type="button"
            :disabled="isTierDisabled(opt.value)"
            :aria-pressed="targetTier === opt.value"
            :aria-label="opt.title
              + (currentTier === opt.value ? ' (current tier)' : '')
              + (opt.value === 'scoped' && selectedSurface !== 'mcp' ? ' — set on the MCP / Broker surface' : '')"
            :data-testid="`policy-tier-${opt.value}`"
            :class="[
              'text-left rounded-xl border px-4 py-4 transition-all duration-150',
              'flex flex-col gap-2',
              targetTier === opt.value
                ? 'border-gold/50 dark:border-signal/50 bg-gold/10 dark:bg-signal/8 ring-2 ring-gold/30 dark:ring-signal/30'
                : 'border-haze dark:border-white/10 hover:bg-mist/60 dark:hover:bg-white/5',
              isTierDisabled(opt.value) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              currentTier === opt.value ? 'shadow-[inset_0_0_0_1px_rgba(184,134,11,0.18)]' : '',
            ]"
            @click="onPickTier(opt.value)"
          >
            <div class="flex items-center justify-between">
              <component
                :is="opt.icon"
                :size="18"
                :stroke-width="1.8"
                class="text-compute dark:text-signal"
              />
              <span
                v-if="currentTier === opt.value"
                class="font-mono text-[10px] text-cool dark:text-body-dark/70"
              >current</span>
            </div>
            <p class="font-sans text-sm font-semibold text-midnight dark:text-white">{{ opt.title }}</p>
            <p class="font-sans text-[12px] text-cool leading-relaxed">{{ opt.blurb }}</p>
            <!-- Scoped is mcp-only — tell the user where to set it instead of
                 letting them commit a HavenBot→scoped transition that 412s. -->
            <p
              v-if="opt.value === 'scoped' && selectedSurface !== 'mcp'"
              class="font-sans text-[11px] text-gold dark:text-signal/90 leading-relaxed mt-0.5"
            >
              Switch the surface above to <span class="font-mono">MCP / Broker</span> to arm
              Scoped autonomy — HavenBot uses that same session.
            </p>
          </button>
        </div>
      </section>

      <!-- Wave 5 Path D Slice 1 Pickup A — Scoped autonomy parameters.
           Shown ONLY when the user has picked the Scoped tier so the
           legacy three-tier UX stays unchanged. `maxPerOpUsd6Input` is
           a free-text decimal with up to 6 dp; the commit step parses
           it to a base-6 BigInt for the POST. `ttlSecInput` is bound to
           a curated segmented control (R1 UX H-2: seconds free-text
           was wrong cognitive load for a consent-critical decision).
           R2 A11y M-1: aria-live moved off this section (the labels
           are static), routed to the inline form-error `<p>` as
           `role="alert"` instead. -->
      <section
        v-if="targetTier === 'scoped' && !needsReMint"
        data-testid="policy-scoped-form"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-white/40 dark:bg-[#1c1b1b]/40 backdrop-blur-md p-5 md:p-6 space-y-4"
      >
        <p
          class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold"
        >
          Scoped autonomy parameters
        </p>
        <!-- R2 Reality Check MED-1 — the Scoped snapshot POSTs under
             `surface: 'mcp'` regardless of the surface picker above.
             Slice 1 only authorizes MCP broker autonomy; per-surface
             Scoped sessions land in Slice 4 once the wildcard rails are
             in place. Surface this so a user editing HavenBot policy
             doesn't expect the Scoped tier to silently enable a Telegram
             agent. -->
        <p
          v-if="selectedSurface !== 'mcp'"
          data-testid="policy-scoped-mcp-notice"
          class="px-3 py-2 rounded-lg border border-haze dark:border-white/10
                 bg-mist/40 dark:bg-[#0d0e10]/60
                 text-[11px] text-cool leading-relaxed"
        >
          Scoped autonomy authorizes the <span class="font-mono">MCP / Broker</span>
          surface regardless of the surface picker above. Per-surface scoped
          sessions land in Slice 4.
        </p>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-[12px] font-semibold text-midnight dark:text-white">
            Max mhUSDC per autonomous trade
          </span>
          <input
            v-model="maxPerOpUsd6Input"
            type="text"
            inputmode="decimal"
            placeholder="100"
            data-testid="policy-scoped-max-usd"
            :disabled="pendingConfirmation !== null || submitting"
            :aria-invalid="scopedFormFailure !== null"
            :aria-describedby="scopedFormFailure ? 'policy-scoped-form-error' : undefined"
            class="rounded-lg border border-haze dark:border-white/10
                   bg-mist/40 dark:bg-[#0d0e10]/60
                   px-3 py-2 font-mono text-sm text-midnight dark:text-white
                   focus:outline-none focus:ring-2 focus:ring-gold/40
                   disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <span class="font-sans text-[11px] text-cool leading-relaxed">
            The agent signs autonomous buys & sells up to this per-trade ceiling
            (mhUSDC value; for a sell it's the proceeds cap). Each trade is checked
            independently — there's no cumulative budget.
          </span>
        </label>
        <div class="flex flex-col gap-1.5">
          <span id="policy-scoped-ttl-label" class="font-sans text-[12px] font-semibold text-midnight dark:text-white">
            Session length
          </span>
          <!-- R2 A11y H-1: dropped `role="radiogroup"` + `role="radio"` —
               the original markup made a false WAI-ARIA promise (arrow
               keys to traverse, single tabstop), but no key handlers
               were wired. Use the toggle-button pattern (`aria-pressed`)
               where Tab-through each option matches actual behavior. -->
          <div
            role="group"
            aria-labelledby="policy-scoped-ttl-label"
            data-testid="policy-scoped-ttl"
            class="grid grid-cols-3 sm:grid-cols-5 gap-1.5"
          >
            <button
              v-for="opt in SCOPED_TTL_CHOICES"
              :key="opt.sec"
              type="button"
              :aria-pressed="ttlSecInput === opt.sec"
              :disabled="pendingConfirmation !== null || submitting"
              :data-testid="`policy-scoped-ttl-${opt.sec}`"
              :class="[
                'rounded-lg border px-2 py-2 text-[12px] font-mono transition-colors duration-150',
                ttlSecInput === opt.sec
                  ? 'border-gold/50 dark:border-signal/50 bg-gold/10 dark:bg-signal/8 ring-1 ring-gold/30 dark:ring-signal/30 text-compute dark:text-signal'
                  : 'border-haze dark:border-white/10 text-midnight dark:text-white hover:bg-mist/60 dark:hover:bg-white/5',
                pendingConfirmation !== null || submitting ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
              ]"
              @click="ttlSecInput = opt.sec"
            >
              {{ opt.label }}
            </button>
          </div>
          <span class="font-sans text-[11px] text-cool leading-relaxed">
            The session auto-expires on-chain via a TimestampPolicy; you can
            revoke earlier from the dashboard.
          </span>
        </div>
        <p
          v-if="scopedFormFailure"
          id="policy-scoped-form-error"
          data-testid="policy-scoped-form-error"
          role="alert"
          class="px-3 py-2 rounded-lg border border-gold/40 bg-gold/8
                 text-[12px] text-compute dark:text-body-dark leading-relaxed"
        >
          <AlertTriangle :size="11" class="inline -mt-0.5 mr-1 text-gold" />
          {{ scopedFormFailure }}
        </p>
      </section>

      <!-- Transition error -->
      <p
        v-if="transitionError"
        data-testid="policy-transition-error"
        role="alert"
        class="px-4 py-3 rounded-xl border border-negative/40 bg-negative/5
               text-[13px] text-negative"
      >
        <AlertTriangle :size="13" class="inline -mt-0.5 mr-1" />
        {{ transitionError }}
      </p>

      <!-- R1 UX H-3 — post-commit recovery strip. When the tier already
           landed at 'scoped' server-side but the mint or POST failed,
           surface "Retry mint" + "Step down to Policy-bound" CTAs so
           the user isn't stranded with an orphaned tier + no session key. -->
      <div
        v-if="scopedRecoveryNeeded === 'retry-mint'"
        data-testid="policy-scoped-recovery"
        role="alert"
        class="px-4 py-3 rounded-xl border border-gold/40 bg-gold/8 space-y-2"
      >
        <p class="text-[13px] font-semibold text-compute dark:text-signal">
          Tier landed at Scoped, session-key mint did not complete
        </p>
        <p class="text-[12px] text-compute dark:text-body-dark leading-relaxed">
          The Scoped tier was committed server-side but the local key mint or
          policy-snapshot POST failed. Retry the mint to re-use the same
          consent token, or step down to Policy-bound to reset cleanly.
        </p>
        <div class="flex flex-wrap gap-2 pt-1">
          <MButton
            variant="primary"
            :disabled="submitting"
            data-testid="policy-scoped-recovery-retry"
            @click="onScopedRetryMint"
          >
            <Loader2 v-if="submitting" :size="14" class="animate-spin" />
            <KeyRound v-else :size="14" />
            Retry mint
          </MButton>
          <MButton
            variant="outline"
            :disabled="submitting"
            data-testid="policy-scoped-recovery-stepdown"
            @click="onScopedStepDownRecover"
          >
            Step down to Policy-bound
          </MButton>
        </div>
      </div>

      <!-- Pending-confirmation hint (step-up) — countdown live-updates
           the remaining seconds so the user sees the 5-min token TTL
           winding down. When expired, the inline "Start over" CTA
           clears the dead token without disturbing the picker.
           R2 A11y M-2: role="status" + aria-live="polite" + aria-atomic
           so SR users hear the Scoped consent-params block when the
           Phase 1 hint mounts (without spamming on each countdown tick;
           the badge's polite-live is on the parent, but content updates
           inside it are read-once on mount, not on every second). -->
      <div
        v-if="pendingConfirmation"
        data-testid="policy-pending-confirmation"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :class="[
          'p-4 rounded-xl border space-y-2',
          pendingExpired ? 'border-negative/40 bg-negative/5' : 'border-gold/40 bg-gold/8',
        ]"
      >
        <div class="flex items-center justify-between gap-2">
          <p
            :class="[
              'text-sm font-semibold',
              pendingExpired
                ? 'text-negative'
                : 'text-compute dark:text-signal',
            ]"
          >
            {{ pendingExpired ? 'Confirmation expired' : 'One more tap to confirm' }}
          </p>
          <span
            data-testid="policy-pending-countdown"
            :class="[
              'inline-flex items-center gap-1 font-mono text-[11px] px-2 py-0.5 rounded-md',
              pendingExpired
                ? 'bg-negative/10 text-negative'
                : 'bg-gold/15 text-compute dark:text-signal',
            ]"
          >
            <Clock :size="11" />
            {{ pendingCountdownLabel }}
          </span>
        </div>
        <p class="text-[12px] text-compute dark:text-body-dark leading-relaxed">
          You're broadening agent autonomy from
          <span class="font-mono">{{ formatTier(currentTier) }}</span>
          to
          <span class="font-mono">{{ formatTier(targetTier) }}</span>
          on
          <span class="font-mono">{{ formatSurface(selectedSurface) }}</span>.
          <template v-if="pendingExpired">
            The 5-minute confirmation window passed; start over to mint a
            fresh token.
          </template>
        </p>
        <!-- R1 UX H-4 — when the user is confirming a Scoped step-up,
             show the EXACT parameters they're authorizing. Sourced from
             the issue-time snapshot in `pendingScopedParams` so editing
             the form between Phase 1 + Phase 2 doesn't silently change
             what the second tap commits. -->
        <ul
          v-if="targetTier === 'scoped' && pendingScopedParams"
          data-testid="policy-pending-scoped-params"
          class="text-[12px] text-compute dark:text-body-dark leading-relaxed
                 pl-4 list-disc space-y-0.5"
        >
          <li>
            Max per autonomous trade:
            <span class="font-mono">{{ formatPendingMhUsdc(pendingScopedParams.maxPerOpUsd6) }}</span>
            mhUSDC
          </li>
          <li>
            Session length:
            <span class="font-mono">{{ formatTtlLabel(pendingScopedParams.ttlSec) }}</span>
          </li>
        </ul>
        <button
          v-if="pendingExpired"
          type="button"
          data-testid="policy-pending-restart"
          class="inline-flex items-center gap-1 text-[12px] text-compute dark:text-signal
                 hover:underline cursor-pointer"
          @click="onRestartConfirmation"
        >
          Start over
        </button>
      </div>

      <!-- CTAs -->
      <div class="flex flex-wrap items-center gap-3">
        <MButton
          v-if="!pickerForceCollapsed || showTierPicker"
          variant="primary"
          :disabled="!canSubmit"
          data-testid="policy-submit"
          @click="onSubmit"
        >
          <Loader2 v-if="submitting" :size="14" class="animate-spin" />
          <ArrowRight v-else-if="pendingConfirmation" :size="14" />
          <CheckCircle2 v-else :size="14" />
          {{ submitLabel }}
        </MButton>

        <p
          v-if="lastCommittedAt"
          class="text-[11px] text-cool ml-auto"
          data-testid="policy-last-committed"
        >
          Last change · {{ new Date(lastCommittedAt).toLocaleString() }}
        </p>
      </div>

      <!-- Broker handoff explainer.
           Wave 5 Option D · C4 follow-up: the legacy "Reveal session key
           for broker" button was REMOVED — it minted a DIFFERENT in-tab
           session key (`walletStore.exportSessionKey`) that does NOT match
           the on-chain Scoped validator, so pasting it into the broker
           silently failed. The ONLY correct broker key is the one shown in
           the reveal modal that pops up RIGHT AFTER you confirm the Scoped
           transition (the freshly-minted Scoped signer). It's shown once
           and never stored; if you miss it, revoke + re-walk to mint a
           fresh one. -->
      <section
        class="p-4 rounded-xl border border-haze dark:border-white/5
               bg-mist/40 dark:bg-[#0d0e10]/60 space-y-2"
      >
        <p
          class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold"
        >
          Broker handoff
        </p>
        <p class="font-sans text-[13px] text-compute dark:text-body-dark leading-relaxed">
          Confirming a <span class="font-mono">Scoped autonomy</span> transition
          reveals a one-time broker command. Run
          <code class="font-mono text-[11px]">muhaven-broker update --session &lt;key&gt;</code>
          on your broker machine — it installs the key and (re)starts the daemon
          in one step, then the MCP / OpenClaw skill signs within this policy.
          Computed locally, shown once, never sent to the backend; miss it and
          you'll revoke + re-mint.
        </p>
      </section>
    </template>

    <!-- Wave 5 Path D Slice 1 Pickup A — Scoped session-key reveal. The
         SOLE broker-key reveal (the legacy in-tab reveal was removed in the
         C4 follow-up). `preMinted` carries the FRESHLY-minted ephemeral EOA
         from the Scoped tier transition commit step. The `smartAccountAddress`
         field stays bound to the user's kernel (not the EOA) so the
         modal's "Smart account" label remains accurate. The privateKey
         decodes to the broker's session signer EOA (`signerAddress`);
         the operator verifies via `muhaven-broker doctor` after paste.
         Closing the modal clears the in-memory `scopedReveal` ref so
         the privateKey is dropped (the parent never persists it). -->
    <SessionKeyRevealModal
      v-if="scopedReveal"
      :pre-minted="{
        privateKey: scopedReveal.signerPrivateKey,
        smartAccountAddress: scopedReveal.smartAccountAddress,
        expiresAtSec: scopedReveal.validUntilSec,
      }"
      @close="scopedReveal = null"
    />

    <!-- Wave 5 Option D · Commit 4 — revoke confirmation alertdialog.
         `role="alertdialog"` + `aria-describedby` → the cost paragraph
         (UX MED-3). Esc + focus-trap + focus-restore via `useModalA11y`
         (Esc disabled mid-DELETE). The "Confirm revoke" button is
         hold-disabled for 3s (dual-tap safety) with a live countdown. -->
    <Teleport to="body">
      <div
        v-if="showRevokeDialog"
        class="fixed inset-0 z-[70] flex items-center justify-center p-4"
      >
        <div
          class="absolute inset-0 bg-midnight/60 dark:bg-black/70 backdrop-blur-sm"
          @click="closeRevokeDialog"
        />
        <div
          ref="revokeDialogRoot"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="policy-revoke-dialog-title"
          aria-describedby="policy-revoke-dialog-desc"
          data-testid="policy-revoke-dialog"
          class="relative w-full max-w-md rounded-2xl p-6 space-y-4
                 bg-white dark:bg-[#16171a]
                 border border-negative/40 dark:border-negative/30
                 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.5)]"
        >
          <div class="flex items-start gap-3">
            <div
              class="w-9 h-9 rounded-full bg-negative/12 flex items-center justify-center flex-shrink-0"
            >
              <ShieldOff :size="16" :stroke-width="1.9" class="text-negative" aria-hidden="true" />
            </div>
            <h2
              id="policy-revoke-dialog-title"
              class="font-accent text-[1.25rem] leading-tight text-midnight dark:text-white pt-1"
            >
              Revoke this scoped session?
            </h2>
          </div>

          <p
            id="policy-revoke-dialog-desc"
            data-testid="policy-revoke-dialog-desc"
            class="text-[13px] text-compute dark:text-body-dark leading-relaxed"
          >
            This immediately flips the backend mirror to
            <span class="font-mono">revoked</span> so the broker stops receiving your policy.
            The broker daemon keeps its in-memory key until you restart it — we'll show you the
            command next. Restoring autonomy means re-walking the Scoped consent and pasting a
            fresh broker key.
          </p>

          <p
            v-if="revokeError"
            role="alert"
            data-testid="policy-revoke-dialog-error"
            class="px-3 py-2 rounded-lg border border-negative/40 bg-negative/5
                   text-[12px] text-negative"
          >
            <AlertTriangle :size="11" class="inline -mt-0.5 mr-1" aria-hidden="true" />
            {{ revokeError }}
          </p>

          <!-- A11y (R1 Issue 1): announce the 3s dual-tap hold + the
               ready state to screen readers. Without this the disabled
               "Confirm revoke" button reads as a permanently-broken
               control. `role="status"` + polite live region; the short
               3-tick window is acceptable to announce. -->
          <p
            class="sr-only"
            role="status"
            aria-live="polite"
            data-testid="policy-revoke-hold-status"
          >
            {{
              revoking
                ? 'Revoking…'
                : revokeHoldRemaining > 0
                  ? `Confirm available in ${revokeHoldRemaining} second${revokeHoldRemaining === 1 ? '' : 's'}`
                  : 'You can now confirm the revoke'
            }}
          </p>

          <div class="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="policy-revoke-cancel"
              :disabled="revoking"
              @click="closeRevokeDialog"
              class="px-4 py-2 rounded-lg text-sm font-sans font-medium cursor-pointer
                     text-cool border border-haze dark:border-white/10
                     hover:bg-mist/60 dark:hover:bg-white/5 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <!-- A11y (R1 Issue 2): native `disabled` only for the in-flight
                 DELETE; the 3s hold uses `aria-disabled` so the button
                 stays focusable + announced (and keeps a stable Tab order)
                 during the wait. `onConfirmRevoke` already no-ops while
                 `revokeHoldRemaining > 0`, so an early activation is safe. -->
            <button
              type="button"
              data-testid="policy-revoke-confirm"
              :disabled="revoking"
              :aria-disabled="revoking || revokeHoldRemaining > 0"
              @click="onConfirmRevoke"
              :class="[
                'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg',
                'text-sm font-sans font-semibold text-white',
                'bg-negative hover:bg-negative/90 transition-colors',
                (revoking || revokeHoldRemaining > 0)
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer',
              ]"
            >
              <Loader2 v-if="revoking" :size="14" class="animate-spin" aria-hidden="true" />
              <ShieldOff v-else :size="14" aria-hidden="true" />
              {{
                revoking
                  ? 'Revoking…'
                  : revokeHoldRemaining > 0
                    ? `Confirm revoke (${revokeHoldRemaining})`
                    : 'Confirm revoke'
              }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
