<script setup lang="ts">
/**
 * Phase 9.A · Expansion (F2) — `/apply-issuer`. Self-serve issuer
 * onboarding wizard.
 *
 * 6-step flow per `PHASE_9A_EXPANSION_PLAN.md` §F2.8:
 *   1. Welcome + KYB (auto-approved)
 *   2. Token basics (symbol, name, asset class)
 *   3. Economics (initial NAV, min investment, yield schedule)
 *   4. Review
 *   5. Deploy (SSE-streamed)
 *   6. First-NAV publish + unpause (kernel-prompted, deferred)
 *
 * The wizard is server-driven: step 1 hits `/v1/issuer/apply` (sync),
 * step 5 hits `/v1/issuer/tokens/deploy` (202) + the SSE feed. State
 * persists to sessionStorage so a refresh doesn't lose progress.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ApiError,
  DEPLOY_STEPS,
  HasInvestorActivityError,
  issuerOnboardingApi,
  type DeployStepKey,
  type DeployStreamEvent,
} from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { useIssuerOnboardingStore } from '@/stores/issuer-onboarding'
import { useIssuerTokensStore } from '@/stores/issuer-tokens'
import { useIssuerInvestorsStore } from '@/stores/issuer-investors'
import MButton from '@/components/ui/MButton.vue'
import {
  Check, CheckCircle2, AlertTriangle, Lock, Loader2, Landmark, Clock, ExternalLink,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const appStore = useAppStore()
const wizard = useIssuerOnboardingStore()
const tokensStore = useIssuerTokensStore()
const investorsStore = useIssuerInvestorsStore()

// Phase 9.A · Expansion (F2). When the deploy stream lands a successful
// finalize event, invalidate the issuer-side caches so the next
// /tokens / /investors visit re-fetches and surfaces the new token.
// Without this, `useIssuerTokensStore` keeps its `loaded=true` flag from
// the wizard's initial mount (when the issuer had zero tokens) and the
// /tokens page shows empty until sign-out / sign-in. The investors
// store walks `issuer-tokens.rawTokens` so it shares the same staleness
// — invalidate both. `issuer-distribution` is a per-token state machine
// with no load-once gate (no action needed); `issuer-compliance`
// composes reactively from `issuer-investors` so it cascades.
function invalidateIssuerCaches() {
  tokensStore.reset()
  investorsStore.reset()
}

const STEP_LABELS: Array<{ idx: number; label: string }> = [
  { idx: 1, label: 'Welcome' },
  { idx: 2, label: 'Token' },
  { idx: 3, label: 'Economics' },
  { idx: 4, label: 'Review' },
  { idx: 5, label: 'Deploy' },
]

const DEPLOY_STEP_LABELS: Record<DeployStepKey, string> = {
  deploy_token: 'Token (fhERC-20)',
  deploy_queue: 'RedemptionQueue',
  deploy_treasury: 'Treasury',
  wire_token_pointers: 'Wire pointers',
  authorize_investor_registry: 'InvestorRegistry · authorize',
  authorize_compliance_callers: 'Compliance · authorize callers',
  configure_oracle: 'Oracle · configure',
  register_token: 'TokenRegistry · register',
}

const JURISDICTIONS: Array<{ value: string; label: string }> = [
  { value: 'KY', label: 'Cayman Islands (KY)' },
  { value: 'SG', label: 'Singapore (SG)' },
  { value: 'CH', label: 'Switzerland (CH)' },
  { value: 'LU', label: 'Luxembourg (LU)' },
  { value: 'BM', label: 'Bermuda (BM)' },
  { value: 'GB', label: 'United Kingdom (GB)' },
]

const ASSET_CLASSES: Array<{ value: 'treasury' | 'money_market' | 'private_credit' | 'real_estate' | 'other'; label: string }> = [
  { value: 'treasury', label: 'Treasury' },
  { value: 'money_market', label: 'Money Market' },
  { value: 'private_credit', label: 'Private Credit' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'other', label: 'Other' },
]

const YIELD_SCHEDULES = ['monthly', 'quarterly', 'annual'] as const

const formError = ref<string | null>(null)
const submittingApply = ref(false)
const showResumeDialog = ref(false)
let eventSource: EventSource | null = null

onMounted(async () => {
  // Skip-welcome shortcut: already-approved issuers landing here from
  // /tokens' empty state jump straight to step 2 without the
  // welcome+KYB form.
  const hadDraft = wizard.hydrate()
  if (route.query['skip-welcome'] !== undefined && wizard.step < 2) {
    wizard.setStep(2)
  } else if (hadDraft && wizard.step > 1 && wizard.finalizeStatus === null) {
    showResumeDialog.value = true
  }

  if (!authStore.isAuthenticated) {
    router.replace({ path: '/login', query: { redirect: '/apply-issuer' } })
    return
  }

  // Phase 9.A · Expansion (F2). Already-approved issuer landing on this
  // route without an in-flight wizard would otherwise see step 1 (the
  // welcome+KYB form), which is no longer applicable — KYB was approved
  // on their first apply. Two paths land here:
  //   (a) /tokens empty-state CTA → routes with `?skip-welcome` query
  //       → handled by the branch above; wizard.step jumps to 2.
  //   (b) Direct URL navigation to `/apply-issuer` (no query) → previously
  //       bounced to /tokens. That created a dead-end for an approved
  //       issuer whose first deploy attempt failed (no tokens visible
  //       on /tokens; nothing actionable beyond the same CTA that they
  //       can't reach without first clicking it). Now: auto-bump to step
  //       2 so the wizard is available at the same shape as path (a).
  //       Surfaced 2026-05-12 during §5 walkthrough setup (operator hit
  //       deploy-lib-disabled error on first attempt; came back to
  //       /apply-issuer and got bounced away). `issuerStatus` is
  //       hydrated by `useAuth.login()` and `main.ts`'s `fetchUserMeta()`
  //       so it's reliable here.
  if (
    authStore.issuerStatus === 'approved'
    && route.query['skip-welcome'] === undefined
    && wizard.step < 2
    && wizard.finalizeStatus === null
  ) {
    wizard.setStep(2)
  }

  // Re-attach to an in-flight deploy if the page reloaded mid-flight.
  if (wizard.deployId && wizard.finalizeStatus === null) {
    await reattachDeploy(wizard.deployId)
  }
})

onBeforeUnmount(() => {
  closeStream()
})

function closeStream() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

function jumpTo(step: 1 | 2 | 3 | 4 | 5 | 6) {
  // Only allow forward jumps after the relevant prerequisites pass —
  // this is also enforced by the Next button's disabled state.
  wizard.setStep(step)
}

function resumeDraft() {
  showResumeDialog.value = false
}
function discardDraft() {
  wizard.reset()
  showResumeDialog.value = false
}

// ── Step 1: KYB submit ─────────────────────────────────────────────
async function handleApply() {
  formError.value = null
  const f = wizard.formData
  if (!f.display_name.trim() || !f.contact_email.trim() || !f.jurisdiction) {
    formError.value = 'Fill out display name, email, and jurisdiction'
    return
  }
  submittingApply.value = true
  try {
    const result = await issuerOnboardingApi.apply({
      display_name: f.display_name.trim(),
      jurisdiction: f.jurisdiction,
      contact_email: f.contact_email.trim(),
      attestation: 'kyb_skipped',
    })
    // Replace tokens + flip role so subsequent calls authenticate as
    // issuer. The auth store mirrors the localStorage shape; we read
    // expires_in from the response and snapshot now-relative.
    authStore.setTokens({
      access_token: result.tokens.access_token,
      refresh_token: result.tokens.refresh_token,
      expires_at: Date.now() + result.tokens.expires_in * 1000,
      wallet_address: result.user.wallet_address,
      role: 'issuer',
    })
    appStore.setRole('issuer')
    // Phase 9.A · Expansion (F2). Server flipped status to 'approved'
    // — mirror into the auth store so the router guard + nav
    // affordance update without waiting for a /me roundtrip.
    authStore.setIssuerStatus(result.user.issuer_status, result.user.issuer_display_name)
    wizard.setStep(2)
  } catch (err) {
    formError.value = parseError(err)
  } finally {
    submittingApply.value = false
  }
}

function parseError(err: unknown): string {
  if (err instanceof HasInvestorActivityError) {
    return 'This wallet has investor activity. Register a new passkey to onboard as an issuer (your portfolio stays where it is).'
  }
  if (err instanceof ApiError) {
    const body = err.body as { details?: { code?: string }; title?: string } | null
    const code = body?.details?.code
    if (code === 'ALREADY_APPROVED') {
      // Already approved → skip the wizard. Mirror the server-side
      // truth into the auth store so the router guard doesn't bounce
      // us back to /apply-issuer on the redirect.
      authStore.setIssuerStatus('approved')
      router.replace('/tokens')
      return 'Already approved — redirecting…'
    }
    if (code === 'HAS_INVESTOR_ACTIVITY') {
      return 'This wallet has investor activity. Register a new passkey to onboard as an issuer (your portfolio stays where it is).'
    }
    if (code === 'SYMBOL_TAKEN') {
      return `Symbol already in use — pick a different one.`
    }
    if (body?.title) return body.title
    return `Request failed (${err.status})`
  }
  return err instanceof Error ? err.message : 'Request failed'
}

// ── Step 5: kick off deploy + open SSE ─────────────────────────────
async function handleDeploy() {
  formError.value = null
  wizard.submitting = true
  try {
    const accepted = await issuerOnboardingApi.startDeploy({
      symbol: wizard.formData.symbol.trim().toUpperCase(),
      name: wizard.formData.name.trim(),
      asset_class: wizard.formData.asset_class,
      initial_nav: wizard.formData.initial_nav,
      min_investment: wizard.formData.min_investment,
      yield_schedule: wizard.formData.yield_schedule,
    })
    wizard.setDeployId(accepted.deploy_id)
    openStream(accepted.deploy_id)
  } catch (err) {
    formError.value = parseError(err)
    wizard.submitting = false
  }
}

function openStream(deployId: string) {
  closeStream()
  eventSource = issuerOnboardingApi.streamDeploy(
    deployId,
    (event: DeployStreamEvent) => {
      wizard.applyEvent(event)
      if (event.step === 'finalize') {
        wizard.submitting = false
        closeStream()
        if (event.status === 'succeeded') {
          invalidateIssuerCaches()
        }
      }
    },
    () => {
      // SSE failed mid-flight — fall back to polling once.
      void pollOnce(deployId)
    },
  )
}

async function reattachDeploy(deployId: string) {
  // Re-hydrate state from the persisted row, then open the live stream.
  try {
    const status = await issuerOnboardingApi.getDeploy(deployId)
    wizard.applyStatusSnapshot(status)
    if (status.status === 'running') {
      openStream(deployId)
    } else if (status.status === 'succeeded') {
      // Re-hydration landed straight on a finished deploy (page reload
      // after success-but-before-navigation): mirror the streamed-success
      // path's cache invalidation so a subsequent /tokens visit picks up
      // the new token.
      invalidateIssuerCaches()
    }
  } catch {
    // The row might not exist any more (cleared cleanup); reset wizard.
    wizard.reset()
  }
}

async function pollOnce(deployId: string) {
  try {
    const status = await issuerOnboardingApi.getDeploy(deployId)
    wizard.applyStatusSnapshot(status)
    if (status.status === 'running') {
      // Try to reconnect the stream on the next tick.
      setTimeout(() => openStream(deployId), 2000)
    } else if (status.status === 'succeeded') {
      // SSE-drop-then-poll-snapshot path landed on a finished success:
      // mirror the streamed path's cache invalidation here too.
      invalidateIssuerCaches()
    }
  } catch {
    // Already finalised or transient — let the user retry manually.
  }
}

// ── Step navigation guards ─────────────────────────────────────────
const canAdvanceFromStep2 = computed(() => {
  const f = wizard.formData
  return /^[A-Z0-9]{3,8}$/.test(f.symbol.trim().toUpperCase()) && f.name.trim().length >= 2
})
const canAdvanceFromStep3 = computed(() => {
  const f = wizard.formData
  return /^\d+$/.test(f.initial_nav) && /^\d+$/.test(f.min_investment)
})

function nextStep() {
  if (wizard.step === 2 && !canAdvanceFromStep2.value) {
    formError.value = 'Symbol (3-8 uppercase alphanumeric) and name (2+ chars) required'
    return
  }
  if (wizard.step === 3 && !canAdvanceFromStep3.value) {
    formError.value = 'NAV + min investment must be non-negative integers (mhUSDC base units)'
    return
  }
  if (wizard.step === 4) {
    // Step 4 → step 5 = deploy kickoff.
    void handleDeploy()
    wizard.setStep(5)
    return
  }
  formError.value = null
  wizard.setStep((wizard.step + 1) as 1 | 2 | 3 | 4 | 5 | 6)
}

function prevStep() {
  formError.value = null
  if (wizard.step <= 1) return
  wizard.setStep((wizard.step - 1) as 1 | 2 | 3 | 4 | 5 | 6)
}

const arbiscanBase = 'https://sepolia.arbiscan.io'
function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}
function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
function deployStepUi(key: DeployStepKey) {
  return wizard.deploySteps.find((s) => s.key === key)
}
</script>

<template>
  <div class="max-w-3xl mx-auto flex flex-col gap-8">
    <!-- Header -->
    <header class="flex flex-col gap-3">
      <p class="font-mono text-[10px] tracking-[0.32em] uppercase text-cool/70">
        Issuer onboarding
      </p>
      <h1 class="font-accent italic text-3xl md:text-4xl tracking-tight text-midnight dark:text-white">
        Become an issuer
      </h1>
      <p class="font-sans text-sm text-cool max-w-2xl">
        Register your SPV, deploy a confidential RWA token, and start
        accepting subscriptions — all from one wizard.
      </p>
    </header>

    <!-- Stepper -->
    <section
      data-testid="apply-stepper"
      class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/30 dark:bg-[#1c1b1b]/30 backdrop-blur-md py-4 px-6"
    >
      <div class="flex items-center justify-between">
        <template v-for="(s, i) in STEP_LABELS" :key="s.label">
          <div class="flex flex-col items-center gap-1.5 min-w-[60px]">
            <div
              :class="[
                'h-7 w-7 rounded-full flex items-center justify-center transition-all duration-300',
                wizard.step > s.idx
                  ? 'bg-gold/15 dark:bg-signal/15 border border-gold/40 dark:border-signal/40 text-compute dark:text-signal'
                  : wizard.step === s.idx
                    ? 'bg-gold dark:bg-signal text-midnight shadow-[0_0_14px_rgba(255,186,32,0.45)] dark:shadow-[0_0_14px_rgba(255,220,161,0.4)]'
                    : 'bg-white dark:bg-[#171717] border border-haze dark:border-white/15 text-cool',
              ]"
            >
              <Check v-if="wizard.step > s.idx" :size="13" :stroke-width="2.5" />
              <span v-else class="font-sans text-[10px] font-bold tabular-nums">{{ s.idx }}</span>
            </div>
            <span
              :class="[
                'font-sans text-[9px] uppercase tracking-[0.22em] text-center font-semibold transition-colors',
                wizard.step > s.idx
                  ? 'text-compute dark:text-signal'
                  : wizard.step === s.idx
                    ? 'text-gold dark:text-signal font-bold'
                    : 'text-cool/60',
              ]"
            >{{ s.label }}</span>
          </div>
          <div
            v-if="i < STEP_LABELS.length - 1"
            aria-hidden="true"
            :class="[
              'flex-1 h-px mx-2 transition-colors mt-3',
              wizard.step > s.idx
                ? 'bg-gold/40 dark:bg-signal/40'
                : 'bg-haze dark:bg-white/10',
            ]"
          />
        </template>
      </div>
    </section>

    <!-- Resume dialog -->
    <section
      v-if="showResumeDialog"
      data-testid="apply-resume-dialog"
      class="rounded-xl border border-gold/30 bg-gold/8 dark:bg-signal/5 px-6 py-4 flex flex-col md:flex-row md:items-center gap-3"
    >
      <p class="font-sans text-sm text-midnight dark:text-white flex-1">
        Resume your application from step {{ wizard.step }}?
      </p>
      <div class="flex items-center gap-2">
        <MButton variant="outline" size="sm" @click="discardDraft">Discard</MButton>
        <MButton variant="primary" size="sm" @click="resumeDraft">Resume</MButton>
      </div>
    </section>

    <!-- Wizard panel -->
    <section
      class="relative overflow-hidden rounded-2xl
             border border-haze dark:border-white/5
             bg-white/90 dark:bg-[#1c1b1b]/80 backdrop-blur-xl
             shadow-[0_14px_40px_-12px_rgba(63,46,12,0.08)]
             dark:shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
    >
      <div aria-hidden="true"
           class="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[90px] pointer-events-none bg-gold/10 dark:bg-signal/8" />

      <div class="relative z-10 p-8 md:p-10 flex flex-col gap-6">
        <!-- ───────────── Step 1: Welcome + KYB ───────────── -->
        <div v-if="wizard.step === 1" class="flex flex-col gap-6">
          <div class="rounded-xl border border-gold/25 bg-gold/8 px-4 py-3 flex items-start gap-3">
            <Lock :size="16" :stroke-width="1.8" class="text-gold mt-0.5" />
            <p class="font-sans text-xs text-midnight/85 dark:text-white/80 leading-relaxed">
              <strong>Hackathon mode.</strong> KYB is auto-approved on submit.
              In production, your filings would route to Sumsub / Persona for
              ~2-day review with the documents listed below.
            </p>
          </div>
          <div class="grid gap-4">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Legal entity name
              </span>
              <input
                v-model="wizard.formData.display_name"
                type="text"
                maxlength="120"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
                placeholder="Acme SPV Cayman Ltd."
              />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Jurisdiction
              </span>
              <select
                v-model="wizard.formData.jurisdiction"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
              >
                <option value="" disabled>Select…</option>
                <option v-for="j in JURISDICTIONS" :key="j.value" :value="j.value">{{ j.label }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Contact email
              </span>
              <input
                v-model="wizard.formData.contact_email"
                type="email"
                maxlength="254"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
                placeholder="ops@acme-spv.example"
              />
            </label>
          </div>
        </div>

        <!-- ───────────── Step 2: Token basics ───────────── -->
        <div v-if="wizard.step === 2" class="flex flex-col gap-6">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="flex flex-col gap-4">
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Symbol (3-8 uppercase)
                </span>
                <input
                  v-model="wizard.formData.symbol"
                  type="text"
                  maxlength="8"
                  class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-mono text-sm uppercase focus:outline-none focus:border-gold/60 transition-colors"
                  placeholder="TBILL2"
                  @input="(e: Event) => wizard.updateForm({ symbol: ((e.target as HTMLInputElement).value || '').toUpperCase() })"
                />
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Display name
                </span>
                <input
                  v-model="wizard.formData.name"
                  type="text"
                  maxlength="64"
                  class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
                  placeholder="MuHaven Treasury Bill Series 2"
                />
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                  Asset class
                </span>
                <select
                  v-model="wizard.formData.asset_class"
                  class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
                >
                  <option v-for="a in ASSET_CLASSES" :key="a.value" :value="a.value">{{ a.label }}</option>
                </select>
              </label>
            </div>
            <div class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/40 dark:bg-white/[0.02] p-5 flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <Landmark :size="16" :stroke-width="1.7" class="text-compute dark:text-signal" />
                <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Preview</span>
              </div>
              <p class="font-accent italic text-2xl text-midnight dark:text-white tracking-tight">
                {{ wizard.formData.symbol || '—' }}
              </p>
              <dl class="grid grid-cols-2 gap-2 font-sans text-xs">
                <dt class="text-cool">Asset class</dt>
                <dd class="text-midnight dark:text-white">{{ wizard.formData.asset_class }}</dd>
                <dt class="text-cool">Decimals</dt>
                <dd class="text-midnight dark:text-white">6 (locked)</dd>
                <dt class="text-cool">Standard</dt>
                <dd class="text-midnight dark:text-white">fhERC-20 + ERC-3643</dd>
              </dl>
              <p class="font-sans text-[11px] text-cool border-t border-haze/40 dark:border-white/5 pt-3">
                This is how investors will see your token on /marketplace.
              </p>
            </div>
          </div>
        </div>

        <!-- ───────────── Step 3: Economics ───────────── -->
        <div v-if="wizard.step === 3" class="flex flex-col gap-6">
          <div class="grid gap-4">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Initial NAV (mhUSDC base units / share)
              </span>
              <input
                v-model="wizard.formData.initial_nav"
                type="text"
                inputmode="numeric"
                pattern="\d*"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-mono text-sm focus:outline-none focus:border-gold/60 transition-colors"
                placeholder="1000000"
              />
              <span class="font-sans text-[11px] text-cool">
                Default <code class="font-mono">1000000</code> = 1.00 mhUSDC. Used by the
                wizard's recap; the kernel publishes the live NAV in step 6.
              </span>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Min investment (mhUSDC base units)
              </span>
              <input
                v-model="wizard.formData.min_investment"
                type="text"
                inputmode="numeric"
                pattern="\d*"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-mono text-sm focus:outline-none focus:border-gold/60 transition-colors"
                placeholder="1"
              />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">
                Yield schedule
              </span>
              <select
                v-model="wizard.formData.yield_schedule"
                class="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-haze dark:border-white/10 font-sans text-sm focus:outline-none focus:border-gold/60 transition-colors"
              >
                <option v-for="y in YIELD_SCHEDULES" :key="y" :value="y">{{ y }}</option>
              </select>
            </label>
          </div>
        </div>

        <!-- ───────────── Step 4: Review ───────────── -->
        <div v-if="wizard.step === 4" class="flex flex-col gap-6">
          <div class="rounded-xl border border-haze/60 dark:border-white/5 bg-mist/40 dark:bg-white/[0.02] p-5">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-3">Review</p>
            <dl class="grid grid-cols-1 md:grid-cols-2 gap-y-2 font-sans text-sm">
              <dt class="text-cool">Issuer</dt>
              <dd class="text-midnight dark:text-white">{{ wizard.formData.display_name }}</dd>
              <dt class="text-cool">Jurisdiction</dt>
              <dd class="text-midnight dark:text-white">{{ wizard.formData.jurisdiction }}</dd>
              <dt class="text-cool">Symbol</dt>
              <dd class="text-midnight dark:text-white font-mono">{{ wizard.formData.symbol }}</dd>
              <dt class="text-cool">Name</dt>
              <dd class="text-midnight dark:text-white">{{ wizard.formData.name }}</dd>
              <dt class="text-cool">Asset class</dt>
              <dd class="text-midnight dark:text-white">{{ wizard.formData.asset_class }}</dd>
              <dt class="text-cool">Initial NAV</dt>
              <dd class="text-midnight dark:text-white font-mono">{{ wizard.formData.initial_nav }} <span class="text-cool font-sans text-[11px]">mhUSDC base units</span></dd>
              <dt class="text-cool">Min investment</dt>
              <dd class="text-midnight dark:text-white font-mono">{{ wizard.formData.min_investment }} <span class="text-cool font-sans text-[11px]">mhUSDC base units</span></dd>
              <dt class="text-cool">Yield schedule</dt>
              <dd class="text-midnight dark:text-white">{{ wizard.formData.yield_schedule }}</dd>
            </dl>
          </div>
          <div class="rounded-xl border border-haze/40 dark:border-white/5 bg-white/40 dark:bg-white/[0.015] p-5 flex flex-col gap-2">
            <p class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold">Locked defaults</p>
            <ul class="font-sans text-xs text-cool list-disc pl-4 space-y-1">
              <li>Compliance bundle: KYC required, no country allow-list, unlimited holders</li>
              <li>Epoch duration: 86400 s · Instant redeem cap: 100 mhUSDC</li>
              <li>Oracle: issuer-controlled (Chainlink path stays operator-only)</li>
              <li>Token registers paused — kernel publishes first NAV + unpauses (step 6)</li>
            </ul>
          </div>
        </div>

        <!-- ───────────── Step 5: Deploy progress ───────────── -->
        <div v-if="wizard.step === 5" class="flex flex-col gap-6">
          <!-- Pre-deploy state: kick off button -->
          <div v-if="!wizard.deployId" class="flex flex-col gap-4">
            <p class="font-sans text-sm text-cool">
              By clicking Deploy, the platform signs the transactions
              that deploy your token + queue + treasury, wire the
              cross-contract pointers, configure the oracle, and
              register everything in the platform's TokenRegistry — all
              on Arb Sepolia (testnet, gas sponsored).
            </p>
            <MButton
              variant="primary"
              size="lg"
              :disabled="wizard.submitting"
              data-testid="apply-deploy-cta"
              @click="handleDeploy"
            >
              <Loader2 v-if="wizard.submitting" :size="16" :stroke-width="2" class="animate-spin mr-2" />
              <span>Deploy issuer stack</span>
            </MButton>
          </div>

          <!-- Deploy rail -->
          <div v-else class="flex flex-col gap-3">
            <p class="font-mono text-[10px] uppercase tracking-[0.22em] text-cool/80">
              Deploy rail · {{ wizard.completedSteps }} of {{ DEPLOY_STEPS.length }}
            </p>
            <ul data-testid="apply-deploy-rail" class="rounded-xl border border-haze/60 dark:border-white/5 bg-white/60 dark:bg-white/[0.02] divide-y divide-haze/40 dark:divide-white/5">
              <li
                v-for="key in DEPLOY_STEPS"
                :key="key"
                class="flex items-center gap-3 px-4 py-3"
                :class="deployStepUi(key)?.status === 'pending' || deployStepUi(key)?.status === 'sent' ? 'bg-gold/8 dark:bg-signal/8' : ''"
              >
                <span
                  :class="[
                    'h-7 w-7 rounded-full flex items-center justify-center text-[10px]',
                    deployStepUi(key)?.status === 'mined'
                      ? 'bg-positive/15 text-positive border border-positive/30'
                      : deployStepUi(key)?.status === 'failed'
                        ? 'bg-negative/15 text-negative border border-negative/30'
                        : deployStepUi(key)?.status === 'pending' || deployStepUi(key)?.status === 'sent'
                          ? 'bg-gold/15 text-gold border border-gold/40 animate-pulse'
                          : 'bg-mist/40 dark:bg-white/5 text-cool border border-haze dark:border-white/10',
                  ]"
                >
                  <Check v-if="deployStepUi(key)?.status === 'mined'" :size="13" :stroke-width="2.5" />
                  <AlertTriangle v-else-if="deployStepUi(key)?.status === 'failed'" :size="13" :stroke-width="2.5" />
                  <Loader2 v-else-if="deployStepUi(key)?.status === 'pending' || deployStepUi(key)?.status === 'sent'" :size="13" :stroke-width="2.5" class="animate-spin" />
                </span>
                <span class="flex-1 font-sans text-sm text-midnight dark:text-white">{{ DEPLOY_STEP_LABELS[key] }}</span>
                <a
                  v-if="(deployStepUi(key)?.txHashes.length ?? 0) > 0"
                  :href="`${arbiscanBase}/tx/${deployStepUi(key)?.txHashes[deployStepUi(key)!.txHashes.length - 1]}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-mono text-[11px] text-cool hover:text-compute dark:hover:text-signal flex items-center gap-1"
                >
                  {{ shortHash(deployStepUi(key)!.txHashes[deployStepUi(key)!.txHashes.length - 1]) }}
                  <ExternalLink :size="11" :stroke-width="1.8" />
                </a>
              </li>
            </ul>
          </div>

          <!-- Success card -->
          <div
            v-if="wizard.finalizeStatus === 'succeeded'"
            data-testid="apply-deploy-success"
            class="rounded-xl border border-positive/30 bg-positive/8 dark:bg-positive/5 p-6 flex flex-col gap-3 items-center"
          >
            <CheckCircle2 :size="56" :stroke-width="1.6" class="text-positive" />
            <p class="font-accent italic text-2xl tracking-tight text-midnight dark:text-white">
              Issuer stack deployed
            </p>
            <p v-if="wizard.tokenAddress" class="font-mono text-xs text-cool">
              Token · <a :href="`${arbiscanBase}/address/${wizard.tokenAddress}`" target="_blank" rel="noopener noreferrer" class="text-compute dark:text-signal hover:underline">{{ shortAddr(wizard.tokenAddress) }}</a>
            </p>
            <div class="flex items-center gap-2 mt-2">
              <MButton variant="outline" size="sm" @click="wizard.reset(); jumpTo(2)">New token</MButton>
              <MButton variant="primary" size="sm" @click="router.push('/tokens')">Go to /tokens</MButton>
            </div>
          </div>

          <!-- Failure card -->
          <div
            v-if="wizard.finalizeStatus === 'failed'"
            data-testid="apply-deploy-failed"
            class="rounded-xl border border-negative/30 bg-negative/8 dark:bg-negative/5 p-6 flex flex-col gap-3 items-center"
          >
            <AlertTriangle :size="56" :stroke-width="1.6" class="text-negative" />
            <p class="font-accent italic text-xl tracking-tight text-midnight dark:text-white">
              Deployment paused
            </p>
            <p class="font-sans text-sm text-cool text-center max-w-md">
              {{ wizard.errorMessage ?? 'Deploy failed mid-flight. The platform team has been notified — you can retry below.' }}
            </p>
            <div class="flex items-center gap-2 mt-2">
              <MButton variant="outline" size="sm" @click="wizard.reset(); jumpTo(4)">Cancel</MButton>
              <MButton variant="primary" size="sm" @click="wizard.reset(); jumpTo(2)">Retry</MButton>
            </div>
          </div>
        </div>

        <!-- ───────────── Step 6 placeholder ───────────── -->
        <div v-if="wizard.step === 6" class="flex flex-col gap-4 items-center text-center py-6">
          <Clock :size="48" :stroke-width="1.6" class="text-gold" />
          <p class="font-accent italic text-xl text-midnight dark:text-white tracking-tight">First NAV publish + unpause</p>
          <p class="font-sans text-sm text-cool max-w-md">
            Two kernel-signed transactions: <code>oracle.setNAV</code> +
            <code>tokenRegistry.setPaused(false)</code>. Step 6 ships in
            a follow-up; for now, head to /tokens and the platform team
            will unpause your token within ~15 minutes.
          </p>
          <MButton variant="primary" size="sm" @click="router.push('/tokens')">Go to /tokens</MButton>
        </div>

        <!-- Inline error -->
        <p v-if="formError" data-testid="apply-error" class="font-sans text-xs text-negative">{{ formError }}</p>

        <!-- Footer (hidden on step 5+ deploy phase + success/failure) -->
        <footer
          v-if="wizard.step !== 5 || (!wizard.deployId && !wizard.finalizeStatus)"
          class="flex items-center justify-between gap-3 pt-4 border-t border-haze/40 dark:border-white/5"
        >
          <button
            v-if="wizard.step > 1"
            type="button"
            class="font-sans text-xs text-cool hover:text-compute dark:hover:text-signal transition-colors"
            @click="prevStep"
          >Back</button>
          <span v-else />
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="font-sans text-xs text-cool hover:text-negative transition-colors"
              @click="router.push('/cash')"
            >Cancel</button>
            <MButton
              v-if="wizard.step === 1"
              variant="primary"
              size="md"
              :disabled="submittingApply"
              data-testid="apply-step1-submit"
              @click="handleApply"
            >
              <Loader2 v-if="submittingApply" :size="16" :stroke-width="2" class="animate-spin mr-2" />
              <span>Submit application</span>
            </MButton>
            <MButton
              v-else
              variant="primary"
              size="md"
              :disabled="(wizard.step === 2 && !canAdvanceFromStep2) || (wizard.step === 3 && !canAdvanceFromStep3)"
              data-testid="apply-next"
              @click="nextStep"
            >
              <span>{{ wizard.step === 4 ? 'Deploy issuer stack' : 'Next' }}</span>
            </MButton>
          </div>
        </footer>
      </div>
    </section>
  </div>
</template>
