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
 *   2. One-time session-key export. Operator clicks "Reveal session key
 *      for broker" → SessionKeyRevealModal mints + surfaces a 0x-prefixed
 *      32-byte hex. Operator pastes it into MUHAVEN_BROKER_SESSION_KEY on
 *      a different machine. The dashboard never ships the key over the
 *      wire — local-only computation per the Wave 4 privacy boundary.
 *
 * The threshold-narrowing sliders described in POST_S4_QUEUE.md are
 * deferred to a Q1b follow-up: the bare tier picker plus reveal is the
 * load-bearing piece for the operator-broker handshake and the §3e⁶
 * closure. Threshold UI ships when Wave 5 wires the validator-bind
 * call-policy build (currently the backend's permission template is
 * scoped per-action; per-tier thresholds are a separate concern).
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  ShieldCheck,
  Layers,
  KeyRound,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  Lock,
  PlayCircle,
  Clock,
} from 'lucide-vue-next'
import {
  agentPolicyApi,
  ApiError,
  type AgentUserStateDto,
  type Surface,
  type Tier,
  type TierTransitionConfirmation,
} from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import MButton from '@/components/ui/MButton.vue'
import MPageLoader from '@/components/ui/MPageLoader.vue'
import SessionKeyRevealModal from '@/components/agent/SessionKeyRevealModal.vue'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const walletStore = useWalletStore()

/** Type guards for the deep-link query params from `set_policy` redirect. */
const SURFACE_SET: ReadonlyArray<Surface> = ['havenbot', 'mcp', 'openclaw', 'checkout']
const PICKABLE_TIER_SET: ReadonlyArray<Tier> = ['advisory', 'confirm-per-action', 'policy-bound']
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
const showRevealModal = ref(false)
const lastCommittedAt = ref<string | null>(null)

// F2 — Resume flow when current tier is paused. Distinct from the
// step-up flow because resume bypasses requestUserTierChange entirely
// (it's only resumable-from-paused per ADR-0).
const resuming = ref(false)

// F3 — Live countdown to the confirmation token's expiry so the user
// notices when their token is about to go stale. The 1s ticker only
// runs while a token is pending; cleared on commit / cancel / unmount.
const nowMs = ref<number>(Date.now())
let countdownHandle: ReturnType<typeof setInterval> | null = null

const currentState = computed<AgentUserStateDto | null>(
  () => statesBySurface.value[selectedSurface.value] ?? null,
)

const currentTier = computed<Tier | null>(() => currentState.value?.tier ?? null)

const canSubmit = computed<boolean>(() => {
  if (submitting.value) return false
  if (targetTier.value === null) return false
  if (targetTier.value === currentTier.value) return false
  if (currentTier.value === 'paused') return false
  // Step-up disabled when policy-bound gates fail (mirror backend rejection
  // shape so the user sees the unmet gate inline, not as a 409 surprise).
  if (stepUpGateFailure.value) return false
  // F3 — a pending-but-expired token would 410 on commit; block the
  // explicit commit and force the user to re-request fresh. The
  // pendingExpired branch's "Start over" CTA handles this case.
  if (pendingExpired.value) return false
  return true
})

const stepUpGateFailure = computed<string | null>(() => {
  if (!targetTier.value || !currentState.value) return null
  if (
    targetTier.value === 'policy-bound'
    && currentTier.value === 'advisory'
  ) {
    return 'Advisory → Policy-bound is forbidden in Wave 4. Step through Confirm per action first.'
  }
  if (
    targetTier.value === 'policy-bound'
    && currentTier.value === 'confirm-per-action'
  ) {
    const c = currentState.value.confirmedActionCount
    if (c < 5) {
      return `Policy-bound requires ≥5 confirmed actions on this surface; you have ${c}.`
    }
    if (!currentState.value.riskQuestionnaireComplete) {
      return 'Policy-bound requires the risk questionnaire to be completed first.'
    }
  }
  return null
})

const isStepUp = computed<boolean>(() => {
  if (!targetTier.value || !currentTier.value) return false
  // Step-up = broadening agent autonomy. Match backend transition-tier.use-case.
  if (currentTier.value === 'advisory' && targetTier.value === 'confirm-per-action') return true
  if (currentTier.value === 'confirm-per-action' && targetTier.value === 'policy-bound') return true
  if (currentTier.value === 'advisory' && targetTier.value === 'policy-bound') return true
  return false
})

const submitLabel = computed<string>(() => {
  if (submitting.value) return 'Submitting…'
  if (pendingConfirmation.value) return 'Confirm transition'
  if (!targetTier.value) return 'Pick a tier'
  if (targetTier.value === currentTier.value) return 'No change'
  if (stepUpGateFailure.value) return 'Locked'
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
})

onBeforeUnmount(() => {
  if (countdownHandle !== null) {
    clearInterval(countdownHandle)
    countdownHandle = null
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
  transitionError.value = null
}

function onPickTier(next: Tier): void {
  if (currentTier.value === 'paused') return
  targetTier.value = next
  // Picking a different tier invalidates any in-flight confirmation
  // token — the actionHash would no longer match the new payload.
  pendingConfirmation.value = null
  transitionError.value = null
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || !targetTier.value) return
  submitting.value = true
  transitionError.value = null

  try {
    if (pendingConfirmation.value) {
      // Phase 2 — re-post with the token to commit.
      const res = await agentPolicyApi.commitTransition({
        surface: selectedSurface.value,
        targetTier: targetTier.value,
        confirmationToken: pendingConfirmation.value.token,
      })
      onTransitionApplied(res.state, 'committed')
    } else {
      // Phase 1 — issue the request.
      const res = await agentPolicyApi.requestTransition({
        surface: selectedSurface.value,
        targetTier: targetTier.value,
      })
      if (res.requiresConfirmation) {
        pendingConfirmation.value = res.confirmation
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

function onTransitionApplied(next: AgentUserStateDto, kind: 'committed' | 'step-down'): void {
  statesBySurface.value = { ...statesBySurface.value, [next.surface]: next }
  pendingConfirmation.value = null
  targetTier.value = null
  lastCommittedAt.value = next.updatedAt
  toast.success(
    kind === 'step-down'
      ? `Tier set to ${formatTier(next.tier)}`
      : `Transition confirmed — now ${formatTier(next.tier)}`,
    { description: `Surface: ${formatSurface(next.surface)}` },
  )
}

function openReveal(): void {
  if (!walletStore.connected) {
    toast.error('Reconnect your wallet first', {
      description: 'Session-key minting needs an active ZeroDev kernel.',
    })
    return
  }
  showRevealModal.value = true
}

/**
 * F2 — Resume CTA when the current surface is paused. Backend's
 * ResumeAgentUseCase requires `tier === Paused` (else rejects) and
 * always lands the resumed surface in Advisory per ADR-0
 * §"Allowed transitions" — the user must re-traverse Confirm-per-action
 * + PolicyBound to regain autonomy. We mirror that landing tier in the
 * local state so the picker comes alive immediately.
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
  transitionError.value = null
}

// ── Helpers ────────────────────────────────────────────────────────

function formatTier(t: Tier | null | undefined): string {
  if (!t) return '—'
  if (t === 'confirm-per-action') return 'Confirm per action'
  if (t === 'policy-bound') return 'Policy-bound'
  if (t === 'paused') return 'Paused'
  return 'Advisory'
}

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
            Tiers gate what the agent (HavenBot, MCP broker, OpenClaw skill,
            Checkout deeplinks) can execute on your behalf. Step-ups need
            a second tap to confirm; step-downs apply immediately. A
            breach pauses the surface — resuming always lands back in
            <span class="font-mono">Advisory</span>, so the user re-traverses
            Confirm to regain autonomy.
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
        <div
          v-if="currentState"
          class="text-right text-[11px] text-cool dark:text-body-dark/70"
        >
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
              <span class="font-mono">Advisory</span> — you'll need to
              re-traverse Confirm-per-action before granting Policy-bound
              autonomy again.
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

      <!-- Tier picker -->
      <section
        data-testid="policy-tier-picker"
        class="rounded-2xl border border-haze dark:border-white/5
               bg-white/40 dark:bg-[#1c1b1b]/40 backdrop-blur-md p-5 md:p-6"
      >
        <p
          class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-3"
        >
          Target tier
        </p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button
            v-for="opt in TIER_OPTIONS"
            :key="opt.value"
            type="button"
            :disabled="currentTier === 'paused'"
            :data-testid="`policy-tier-${opt.value}`"
            :class="[
              'text-left rounded-xl border px-4 py-4 transition-all duration-150',
              'flex flex-col gap-2',
              targetTier === opt.value
                ? 'border-gold/50 dark:border-signal/50 bg-gold/10 dark:bg-signal/8 ring-2 ring-gold/30 dark:ring-signal/30'
                : 'border-haze dark:border-white/10 hover:bg-mist/60 dark:hover:bg-white/5',
              currentTier === 'paused' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
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
          </button>
        </div>
      </section>

      <!-- Gate-failure hint -->
      <p
        v-if="stepUpGateFailure"
        data-testid="policy-gate-hint"
        class="px-4 py-3 rounded-xl border border-gold/40 bg-gold/8
               text-[13px] text-compute dark:text-body-dark"
      >
        <Lock :size="13" class="inline -mt-0.5 mr-1 text-gold" />
        {{ stepUpGateFailure }}
      </p>

      <!-- Transition error -->
      <p
        v-if="transitionError"
        data-testid="policy-transition-error"
        class="px-4 py-3 rounded-xl border border-negative/40 bg-negative/5
               text-[13px] text-negative"
      >
        <AlertTriangle :size="13" class="inline -mt-0.5 mr-1" />
        {{ transitionError }}
      </p>

      <!-- Pending-confirmation hint (step-up) — countdown live-updates
           the remaining seconds so the user sees the 5-min token TTL
           winding down. When expired, the inline "Start over" CTA
           clears the dead token without disturbing the picker. -->
      <div
        v-if="pendingConfirmation"
        data-testid="policy-pending-confirmation"
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

        <MButton
          variant="outline"
          :disabled="!walletStore.connected"
          data-testid="policy-reveal-cta"
          @click="openReveal"
        >
          <KeyRound :size="14" />
          Reveal session key for broker
        </MButton>

        <p
          v-if="lastCommittedAt"
          class="text-[11px] text-cool ml-auto"
          data-testid="policy-last-committed"
        >
          Last change · {{ new Date(lastCommittedAt).toLocaleString() }}
        </p>
      </div>

      <!-- Broker handoff explainer -->
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
          Click <span class="font-mono">Reveal session key for broker</span>
          above to surface the 0x-prefixed 32-byte hex once. Paste it into
          <code class="font-mono text-[11px]">MUHAVEN_BROKER_SESSION_KEY</code>
          on your broker machine, restart the daemon, and any read /
          propose call from the MCP / OpenClaw skill will route through
          the policy you just set. The key never leaves your device; the
          backend doesn't see it.
        </p>
      </section>
    </template>

    <SessionKeyRevealModal
      v-if="showRevealModal"
      @close="showRevealModal = false"
    />
  </div>
</template>
