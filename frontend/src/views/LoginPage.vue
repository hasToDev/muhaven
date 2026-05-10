<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuth, RoleMismatchError } from '@/composables/useAuth'
import { useHomeTarget } from '@/composables/useHomeTarget'
import { cn } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import { Shield, Fingerprint, Loader2, AlertCircle, CheckCircle2, BadgeCheck, ArrowRight } from 'lucide-vue-next'
import { demoApi, type UserRole } from '@/services/api'
import { IdentityRegistryClient } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext } from '@/services/v35/context'
import { useAppVersion } from '@/composables/useAppVersion'

const { fullLabel: versionLabel } = useAppVersion()

const router = useRouter()
const route = useRoute()
const auth = useAuth()
const homeTarget = useHomeTarget()

// Clear stale auth state when arriving at login page (e.g. after session expiry redirect)
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
const authStore = useAuthStore()
const walletStore = useWalletStore()
if (!authStore.isAuthenticated && (authStore.accessToken || authStore.walletAddress)) {
  authStore.clearAuth()
  walletStore.disconnect()
}

const mode = ref<'login' | 'register'>('login')
const selectedRole = ref<UserRole>('investor')
const username = ref('')
const authStep = ref<'idle' | 'working' | 'done' | 'awaiting-whitelist'>('idle')
const localError = ref<string | null>(null)
const whitelistState = ref<'idle' | 'working' | 'done' | 'error'>('idle')
const whitelistError = ref<string | null>(null)
// Soft warning surfaced when KYC landed but MINTER_ROLE grant did not — user
// can still proceed but the encrypted-mint path on Deposit will fail until
// they retry. Null when mint-grant succeeded or wasn't attempted.
const minterWarning = ref<string | null>(null)

const isRegister = computed(() => mode.value === 'register')
const isWorking = computed(() => authStep.value === 'working')

const stepLabel = computed(() => {
  switch (authStep.value) {
    case 'working': return isRegister.value ? 'Creating passkey & signing in...' : 'Authenticating with passkey...'
    case 'awaiting-whitelist': return 'Passkey created'
    case 'done': return 'Welcome to MuHaven'
    default: return ''
  }
})

// Redirect if already authenticated when the page loads (e.g. someone navigates
// to /login while they still have a valid JWT). The three active-session paths —
// login completes, register completes + whitelist, register completes + skip —
// each call redirectToDashboard explicitly, so no isAuthenticated watcher is
// needed. A watcher here was the cause of the "banner auto-closes before the
// user can click Enable demo access" bug: when auth.login() flips isAuthenticated
// inside setTokens(), Vue's scheduler runs the watcher callback BEFORE
// handleAuth's await-continuation can set authStep = 'awaiting-whitelist', so the
// `authStep !== 'awaiting-whitelist'` guard always sees 'working' and redirects.
// `flush: 'post'` doesn't fix it because Vue's scheduler still queues the update
// job ahead of the promise continuation.
onMounted(() => {
  if (auth.isAuthenticated.value) {
    redirectToDashboard()
  }
})

// True when Wave 3.5 IdentityRegistry is wired AND dev-mode is on.
// `isVerified` returns true for every address in this state so the legacy
// whitelist step adds no value.
async function isV35DevModeOn(): Promise<boolean> {
  if (isZeroAddress(v35Addresses.identityRegistry)) return false
  try {
    const client = new IdentityRegistryClient(
      buildReadContext(),
      v35Addresses.identityRegistry,
    )
    return await client.devMode()
  } catch (e) {
    // If the read fails (RPC flake / misconfig), assume dev-mode is OFF
    // and fall through to the legacy whitelist UI — safer than auto-skip.
    console.warn('[LoginPage] devMode check failed; falling back to whitelist UI:', e)
    return false
  }
}

function redirectToDashboard() {
  const redirect = route.query.redirect as string | undefined
  // Only allow relative paths to prevent open redirect.
  const safeRedirect = redirect?.startsWith('/') ? redirect : undefined
  // Phase 9.A · Expansion (F2). Issuers route based on `issuerStatus`:
  // `unregistered` (fresh register OR returning issuer who never
  // finished KYB) → /apply-issuer; `approved` → /tokens. The /me
  // fetch in `useAuth.login()` resolves the status before we get
  // here. Investors always land on /cash. A query-param `?redirect`
  // wins over the role default — but the router's beforeEach guard
  // will still bounce an unregistered issuer back to /apply-issuer
  // if the redirect target isn't on the allowlist, so this is safe.
  const status = authStore.issuerStatus
  const issuerTarget = status === 'approved' ? '/tokens' : '/apply-issuer'
  const target = safeRedirect || (auth.role.value === 'issuer' ? issuerTarget : '/cash')
  router.replace(target)
}

async function handleAuth() {
  localError.value = null

  if (isRegister.value && !username.value.trim()) {
    localError.value = 'Enter a name for your passkey'
    return
  }

  try {
    // The auth.login() call handles wallet→nonce→sign→verify internally.
    // We show a combined progress indicator.
    authStep.value = 'working'

    // Phase 9.A · role guardrail. On login mode we don't pre-pick a
    // role — the backend uses the wallet's stored role as the source
    // of truth. On register mode we send the user's pick so the new
    // user record carries the correct role. `selectedRole` defaults
    // to 'investor' for the register-mode form; we don't read it on
    // login to avoid sending a stale guess that a registered-as-issuer
    // user would hit as a 403 ROLE_MISMATCH on first click.
    await auth.login(
      mode.value,
      isRegister.value ? selectedRole.value : undefined,
      isRegister.value ? username.value.trim() : undefined,
    )

    // On register: when the Wave 3.5 IdentityRegistry is wired AND
    // dev-mode is on, every kernel address is auto-verified — the
    // legacy `Enable demo access` whitelist step is a no-op against
    // an obsolete adapter. Skip it entirely. The MDevModeBanner at
    // the top of the dashboard already advertises the dev-mode state.
    //
    // Pause for the whitelist UI only when dev-mode is OFF (post
    // production cutover) — that's when the legacy whitelist actually
    // does something the user might want.
    if (isRegister.value) {
      if (await isV35DevModeOn()) {
        authStep.value = 'done'
        await new Promise(r => setTimeout(r, 600))
        redirectToDashboard()
        return
      }
      authStep.value = 'awaiting-whitelist'
      return
    }

    authStep.value = 'done'
    await new Promise(r => setTimeout(r, 600))
    redirectToDashboard()
  } catch (e) {
    authStep.value = 'idle'
    if (e instanceof RoleMismatchError) {
      // Phase 9.A · role guardrail. Auto-flip the selector to the
      // registered role so the user's next click is the success path.
      // Inline error names the registered role explicitly — actionable
      // disambiguation, not security theater. Researcher's "forgiveness"
      // pattern (Nielsen): one-step recovery from a typo.
      const registered = e.registeredRole
      localError.value =
        `This passkey is registered as ${registered === 'investor' ? 'an Investor' : 'an Issuer'}. `
        + `Switched the role selector — sign in again to continue.`
      selectedRole.value = registered
      // The selector flips to the registered role; user clicks Sign In
      // again to retry. We don't auto-resubmit because the password-less
      // ZeroDev passkey kernel may have already consumed an enableSig
      // ceremony for this attempt.
      return
    }
    localError.value = auth.error.value || (e instanceof Error ? e.message : 'Authentication failed')
  }
}

async function requestWhitelist() {
  whitelistError.value = null
  minterWarning.value = null
  whitelistState.value = 'working'
  try {
    const result = await demoApi.whitelistSelf()
    if (!result.minterGranted) {
      minterWarning.value = result.minterError ?? 'Mint role grant did not land — encrypted-mint deposit will need retry.'
    }
    whitelistState.value = 'done'
    // Small pause so the user sees the success state, then continue.
    await new Promise(r => setTimeout(r, 800))
    authStep.value = 'done'
    await new Promise(r => setTimeout(r, 400))
    redirectToDashboard()
  } catch (e) {
    whitelistState.value = 'error'
    whitelistError.value = e instanceof Error ? e.message : 'Whitelist request failed'
  }
}

function skipWhitelist() {
  authStep.value = 'done'
  setTimeout(redirectToDashboard, 300)
}

/**
 * Mode toggle — flips between login and register. Always clears the
 * inline error + passkey-name input so stale state from the prior
 * mode never leaks into the new form.
 */
function toggleMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  localError.value = null
  username.value = ''
}

/**
 * Smooth collapse transition for register-mode-only fields (role
 * selector + username). The prior `<transition>`-with-class pattern
 * used a static `max-h` ceiling that almost always overshot the
 * actual element height — the leave animation would spend the first
 * ~20% of its duration with nothing visibly changing while max-h
 * dropped from the ceiling down to the real content height, then
 * jump-collapse the rest. The `mb-6` margin-bottom outside the
 * transitioning element also popped out discretely on unmount,
 * adding a final "click."
 *
 * These hooks measure `scrollHeight` at leave time + animate height
 * + margin-bottom + opacity together from real values down to 0
 * (and reverse on enter). Surfaced 2026-05-10 from operator feedback
 * on the Sign In ↔ Create Account toggle pacing.
 */
const ENTER_DURATION = 500
const LEAVE_DURATION = 400

function onCollapseBeforeEnter(el: Element): void {
  const e = el as HTMLElement
  e.style.height = '0px'
  e.style.marginBottom = '0px'
  e.style.opacity = '0'
  e.style.overflow = 'hidden'
}

function onCollapseEnter(el: Element, done: () => void): void {
  const e = el as HTMLElement
  // Capture the natural height + the natural margin-bottom (set by
  // the element's class — `mb-6` = 24px). We animate both up from 0
  // to the natural values, then clear the inline styles so the
  // element resumes responsive layout.
  const naturalMb = getNaturalMarginBottom(e)
  const naturalH = e.scrollHeight
  // Reflow after the before-enter zeros are applied, then animate.
  requestAnimationFrame(() => {
    e.style.transition = `height ${ENTER_DURATION}ms ease-out, margin-bottom ${ENTER_DURATION}ms ease-out, opacity ${ENTER_DURATION}ms ease-out`
    e.style.height = `${naturalH}px`
    e.style.marginBottom = `${naturalMb}px`
    e.style.opacity = '1'
    const cleanup = (ev: TransitionEvent): void => {
      if (ev.propertyName !== 'height') return
      e.removeEventListener('transitionend', cleanup as EventListener)
      e.style.transition = ''
      e.style.height = ''
      e.style.marginBottom = ''
      e.style.opacity = ''
      e.style.overflow = ''
      done()
    }
    e.addEventListener('transitionend', cleanup as EventListener)
  })
}

function onCollapseLeave(el: Element, done: () => void): void {
  const e = el as HTMLElement
  const currentH = e.scrollHeight
  const currentMb = getNaturalMarginBottom(e)
  // Lock the current rendered height + margin to inline styles so
  // the transition has a concrete starting point (without this the
  // browser would treat `auto` as the from-value and skip the
  // animation entirely).
  e.style.height = `${currentH}px`
  e.style.marginBottom = `${currentMb}px`
  e.style.overflow = 'hidden'
  // Force reflow so the inline styles register before we change them.
  void e.offsetHeight
  e.style.transition = `height ${LEAVE_DURATION}ms ease-in, margin-bottom ${LEAVE_DURATION}ms ease-in, opacity ${LEAVE_DURATION}ms ease-in`
  e.style.height = '0px'
  e.style.marginBottom = '0px'
  e.style.opacity = '0'
  const cleanup = (ev: TransitionEvent): void => {
    if (ev.propertyName !== 'height') return
    e.removeEventListener('transitionend', cleanup as EventListener)
    done()
  }
  e.addEventListener('transitionend', cleanup as EventListener)
}

/**
 * Read the element's class-defined margin-bottom by temporarily
 * clearing any inline override. Falls back to 0 when no margin is
 * set or the value can't be parsed.
 */
function getNaturalMarginBottom(el: HTMLElement): number {
  const inline = el.style.marginBottom
  el.style.marginBottom = ''
  const computed = parseFloat(getComputedStyle(el).marginBottom) || 0
  if (inline !== '') el.style.marginBottom = inline
  return computed
}

</script>

<template>
  <div class="relative min-h-screen flex items-center justify-center px-4 py-12 overflow-hidden">
    <!-- Ambient gradient — lg+ only.
         Two static amber bloom orbs in opposite corners + a thin
         horizon hairline behind the card. Pure CSS gradient, no
         motion. Opacity tuned low so the card stays the visual
         subject (the orbs add warm depth without competing for
         attention against the card's accents). sm/md keeps the
         bare centered card. -->
    <div
      class="absolute inset-0 pointer-events-none hidden lg:block"
      aria-hidden="true"
    >
      <!-- Bloom orb — top-left, gold -->
      <div
        class="absolute -top-[12%] -left-[14%] w-[720px] h-[720px] rounded-full
               bg-gold/10 dark:bg-gold/5 blur-3xl"
      />
      <!-- Bloom orb — bottom-right, signal -->
      <div
        class="absolute -bottom-[12%] -right-[14%] w-[720px] h-[720px] rounded-full
               bg-signal/10 dark:bg-signal/5 blur-3xl"
      />
      <!-- Horizon hairline -->
      <div
        class="absolute top-1/2 inset-x-0 h-px
               bg-gradient-to-r from-transparent via-gold/20 dark:via-signal/15 to-transparent"
      />
    </div>

    <div
      v-motion
      :initial="{ opacity: 0 }"
      :enter="{ opacity: 1, transition: { duration: 600, ease: 'easeOut' } }"
      class="relative z-10 w-full max-w-md"
    >
      <!-- Glass card.
           Shadow tuned to live alongside the ambient corner-orb gradient
           without competing with it: warm brown tint in light mode,
           deeper black in dark mode, both with a small negative spread
           so the shadow stays tight to the card silhouette and doesn't
           bleed into the corners. Sits between the original
           `shadow-elevated` (too heavy) and the first softened pass
           (too light) — visible card lift without slamming the canvas. -->
      <div
        :class="cn(
          'relative overflow-hidden rounded-2xl',
          'bg-white/80 dark:bg-midnight-mid/80 backdrop-blur-xl',
          'ring-1 ring-haze dark:ring-white/8',
          'shadow-[0_18px_42px_-10px_rgba(63,46,12,0.26)]',
          'dark:shadow-[0_22px_52px_-12px_rgba(0,0,0,0.62)]',
        )"
      >
        <!-- Subtle gradient accent at top -->
        <div class="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-compute/40 to-transparent" />

        <div class="p-8 sm:p-10">
          <!-- Logo + brand -->
          <div
            v-motion
            :initial="{ opacity: 0, y: 12 }"
            :enter="{ opacity: 1, y: 0, transition: { delay: 100, duration: 400 } }"
            class="flex flex-col items-center mb-8"
          >
            <router-link
              :to="homeTarget"
              data-testid="login-logo-home"
              class="flex items-center gap-3 mb-3 group cursor-pointer rounded-xl px-2 py-1 -mx-2 -my-1 transition-all duration-200 hover:bg-mist/60 dark:hover:bg-white/5"
              aria-label="Back to MuHaven home"
            >
              <img
                src="/logo.png"
                alt="MuHaven"
                class="w-10 h-10 rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-105
                       mix-blend-multiply dark:mix-blend-normal
                       dark:drop-shadow-[0_0_10px_rgba(255,186,32,0.45)]"
              />
              <span class="text-2xl font-sans font-bold text-midnight dark:text-white tracking-tight transition-colors group-hover:text-compute">
                MuHaven
              </span>
            </router-link>
            <p class="text-sm text-cool font-sans">
              Confidential RWA portfolio management
            </p>
          </div>

          <!-- Auth step indicator (visible during auth flow) -->
          <transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 -translate-y-2"
            leave-to-class="opacity-0 translate-y-2"
          >
            <div
              v-if="isWorking || authStep === 'done'"
              class="mb-8 flex flex-col items-center gap-3"
            >
              <div
                :class="cn(
                  'w-12 h-12 rounded-full flex items-center justify-center',
                  authStep === 'done'
                    ? 'bg-compute/10'
                    : 'bg-mist dark:bg-midnight/60',
                )"
              >
                <Loader2
                  v-if="isWorking"
                  :size="22"
                  class="animate-spin text-compute"
                />
                <CheckCircle2
                  v-else-if="authStep === 'done'"
                  :size="22"
                  class="text-compute"
                />
              </div>
              <span class="text-sm font-sans font-medium text-slate dark:text-cool">
                {{ stepLabel }}
              </span>
            </div>
          </transition>

          <!-- Demo-mode self-serve whitelist (shown post-register) -->
          <transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 -translate-y-2"
            leave-to-class="opacity-0 translate-y-2"
          >
            <div v-if="authStep === 'awaiting-whitelist'" class="mb-2">
              <div
                class="mb-5 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-gold/10 border border-gold/25"
              >
                <BadgeCheck :size="16" class="text-gold shrink-0 mt-0.5" />
                <div class="flex flex-col gap-1">
                  <p class="text-xs font-sans font-semibold text-gold leading-relaxed">
                    Demo mode — self-serve KYC
                  </p>
                  <p class="text-xs font-sans text-slate dark:text-cool leading-relaxed">
                    Production uses issuer-approved whitelisting + atomic on-chain purchase.
                    For this demo, click below to whitelist your passkey
                    and grant it <span class="font-mono">MINTER_ROLE</span> on MuHavenToken so
                    you can mint encrypted tokens directly.
                  </p>
                </div>
              </div>

              <MButton
                variant="primary"
                size="lg"
                full-width
                data-testid="auth-demo-whitelist-cta"
                :loading="whitelistState === 'working'"
                :disabled="whitelistState === 'working' || whitelistState === 'done'"
                @click="requestWhitelist"
              >
                <BadgeCheck v-if="whitelistState !== 'done'" :size="18" />
                <CheckCircle2 v-else :size="18" />
                {{ whitelistState === 'done' ? 'Whitelisted — redirecting' : 'Enable demo access' }}
              </MButton>

              <transition
                enter-active-class="transition-all duration-200 ease-out"
                enter-from-class="opacity-0"
              >
                <div
                  v-if="whitelistError"
                  class="mt-3 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-negative/8 border border-negative/15"
                >
                  <AlertCircle :size="16" class="text-negative shrink-0 mt-0.5" />
                  <p class="text-xs font-sans text-negative leading-relaxed">{{ whitelistError }}</p>
                </div>
              </transition>

              <transition
                enter-active-class="transition-all duration-200 ease-out"
                enter-from-class="opacity-0"
              >
                <div
                  v-if="minterWarning && !whitelistError"
                  class="mt-3 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-gold/8 border border-gold/25"
                >
                  <AlertCircle :size="16" class="text-gold shrink-0 mt-0.5" />
                  <p class="text-xs font-sans text-slate dark:text-cool leading-relaxed">
                    KYC landed, but MINTER_ROLE grant failed. You can still use the vault-wrap
                    deposit path. To retry the mint grant, refresh and click "Enable demo access" again.
                  </p>
                </div>
              </transition>

              <button
                @click="skipWhitelist"
                data-testid="auth-demo-skip"
                class="mt-4 block mx-auto text-xs font-sans text-cool hover:text-compute transition-colors cursor-pointer"
              >
                Skip for now
              </button>
            </div>
          </transition>

          <!-- Form (hidden during auth flow) -->
          <transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0"
            leave-to-class="opacity-0"
          >
            <div v-if="!isWorking && authStep !== 'done' && authStep !== 'awaiting-whitelist'">
              <!-- Role selector — register mode only. Phase 9.A · role
                   guardrail: roles lock at registration; on login the
                   wallet's registered role is the source of truth (server
                   returns ROLE_MISMATCH if the submitted role disagrees).
                   Showing the selector on login would let users assume
                   they can change roles silently.
                   Mode-flip animation: same `<transition>` shape as the
                   username input below — both collapse together when
                   flipping to login, both expand together when flipping
                   to register. The prior `v-motion`-only setup hard-
                   popped on leave (no fade) and slow-staggered on enter
                   (200ms delay), causing the visible jank when toggling
                   modes. Surfaced 2026-05-10 from operator feedback. -->
              <transition
                :css="false"
                @before-enter="onCollapseBeforeEnter"
                @enter="onCollapseEnter"
                @leave="onCollapseLeave"
              >
                <div v-if="isRegister" class="mb-6">
                  <label class="block text-xs font-sans font-medium text-cool mb-2 uppercase tracking-wider">
                    I am an
                  </label>
                  <div class="flex bg-mist dark:bg-midnight/60 rounded-lg p-0.5 border border-haze dark:border-white/8">
                    <button
                      v-for="r in (['investor', 'issuer'] as const)"
                      :key="r"
                      @click="selectedRole = r"
                      :data-testid="`auth-role-${r}`"
                      :class="cn(
                        'flex-1 px-4 py-2.5 text-sm font-sans font-medium rounded-md transition-all duration-200 capitalize cursor-pointer',
                        selectedRole === r
                          ? 'bg-white dark:bg-midnight shadow-sm text-compute'
                          : 'text-cool hover:text-midnight dark:hover:text-white',
                      )"
                    >
                      {{ r }}
                    </button>
                  </div>
                  <p
                    data-testid="auth-role-lock-hint"
                    class="mt-2 font-sans text-[11px] text-cool italic leading-relaxed"
                  >
                    Choose carefully — this passkey can't switch roles later.
                    Create a separate passkey if you need both.
                  </p>
                </div>
              </transition>

              <!-- Login mode intentionally renders no role-hint card.
                   The role selector is hidden (server-side source of
                   truth via ROLE_MISMATCH); a hint that explains the
                   absence read as redundant chrome to the user. The
                   ROLE_MISMATCH inline error below the form remains
                   the recovery path if a typo'd kernel returns the
                   wrong role. -->

              <!-- Username (register mode only) -->
              <transition
                :css="false"
                @before-enter="onCollapseBeforeEnter"
                @enter="onCollapseEnter"
                @leave="onCollapseLeave"
              >
                <div v-if="isRegister" class="mb-6">
                  <label
                    for="username"
                    class="block text-xs font-sans font-medium text-cool mb-2 uppercase tracking-wider"
                  >
                    Passkey name
                  </label>
                  <input
                    id="username"
                    v-model="username"
                    type="text"
                    placeholder="e.g. My MuHaven key"
                    autocomplete="username webauthn"
                    data-testid="auth-passkey-name-input"
                    :class="cn(
                      'w-full px-4 py-3 text-sm font-sans rounded-lg transition-all duration-200',
                      'bg-mist dark:bg-midnight/60',
                      'border border-haze dark:border-white/8',
                      'text-midnight dark:text-white',
                      'focus:outline-none focus:ring-2 focus:ring-compute/30 focus:border-compute',
                    )"
                  />
                </div>
              </transition>

              <!-- CTA button -->
              <div
                v-motion
                :initial="{ opacity: 0, y: 8 }"
                :enter="{ opacity: 1, y: 0, transition: { delay: 300, duration: 400 } }"
                class="mb-5"
              >
                <MButton
                  variant="primary"
                  size="lg"
                  full-width
                  data-testid="auth-cta"
                  :loading="auth.loading.value"
                  :disabled="auth.loading.value"
                  @click="handleAuth"
                >
                  <Fingerprint :size="18" />
                  <!-- Cross-fade the label so the text doesn't snap on
                       mode flip while the form below is still animating.
                       `mode="out-in"` runs leave → enter sequentially;
                       `:key="mode"` makes Vue treat the two strings as
                       different elements. The icon stays put. -->
                  <Transition
                    mode="out-in"
                    enter-active-class="transition-opacity duration-200 ease-out"
                    leave-active-class="transition-opacity duration-150 ease-in"
                    enter-from-class="opacity-0"
                    leave-to-class="opacity-0"
                  >
                    <span :key="mode">{{ isRegister ? 'Create Account' : 'Sign In' }}</span>
                  </Transition>
                </MButton>
              </div>

              <!-- Mode toggle — split-emphasis pattern.
                   Question half ("New here?" / "Already have an account?")
                   stays muted because it's contextual; the action half
                   ("Create account →" / "Sign in →") carries the
                   gold/signal accent + semibold weight + underline +
                   nudge-on-hover so the user immediately sees the
                   alternative action. A thin divider above separates
                   it from the CTA so the toggle reads as its own
                   navigation lever rather than a footnote. -->
              <div
                v-motion
                :initial="{ opacity: 0 }"
                :enter="{ opacity: 1, transition: { delay: 400, duration: 400 } }"
                class="mt-7 pt-5 border-t border-haze/70 dark:border-white/5"
              >
                <button
                  type="button"
                  @click="toggleMode"
                  data-testid="auth-mode-toggle"
                  class="group w-full text-center cursor-pointer
                         font-sans text-sm flex items-center justify-center gap-1.5
                         transition-colors duration-200"
                >
                  <!-- Cross-fade entire toggle content on mode flip so
                       the question + action text don't snap while the
                       form above is animating. Wrapped span carries the
                       layout (flex + gap) so the cross-fade child stays
                       a single keyed element. -->
                  <Transition
                    mode="out-in"
                    enter-active-class="transition-opacity duration-200 ease-out"
                    leave-active-class="transition-opacity duration-150 ease-in"
                    enter-from-class="opacity-0"
                    leave-to-class="opacity-0"
                  >
                    <span :key="mode" class="inline-flex items-center gap-1.5">
                      <span class="text-cool">
                        {{ isRegister ? 'Already have an account?' : 'New here?' }}
                      </span>
                      <span
                        class="font-semibold text-compute dark:text-signal underline decoration-compute/40 dark:decoration-signal/40
                               underline-offset-4 group-hover:decoration-compute dark:group-hover:decoration-signal
                               inline-flex items-center gap-1 transition-all duration-200"
                      >
                        {{ isRegister ? 'Sign in' : 'Create account' }}
                        <ArrowRight
                          :size="14"
                          :stroke-width="2"
                          class="transition-transform duration-200 group-hover:translate-x-0.5"
                        />
                      </span>
                    </span>
                  </Transition>
                </button>
              </div>
            </div>
          </transition>

          <!-- Error display -->
          <transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 translate-y-2"
            leave-to-class="opacity-0 -translate-y-2"
          >
            <div
              v-if="localError"
              class="mt-5 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-negative/8 border border-negative/15"
            >
              <AlertCircle :size="16" class="text-negative shrink-0 mt-0.5" />
              <p class="text-xs font-sans text-negative leading-relaxed">{{ localError }}</p>
            </div>
          </transition>
        </div>
      </div>

      <!-- Trust indicator below card -->
      <div
        v-motion
        :initial="{ opacity: 0 }"
        :enter="{ opacity: 1, transition: { delay: 600, duration: 500 } }"
        class="flex items-center justify-center gap-2 mt-6"
      >
        <Shield :size="12" class="text-cool/50" />
        <span class="text-[11px] font-sans text-cool/50">
          Secured by Fhenix FHE on Arbitrum
        </span>
      </div>

      <!-- Build version (whisper-quiet — pre-auth bug reports cite this
           when the sidebar isn't reachable). Appears below the trust
           indicator at lower opacity so it doesn't compete with the
           trust signal but is always available for support. -->
      <div
        v-motion
        :initial="{ opacity: 0 }"
        :enter="{ opacity: 1, transition: { delay: 700, duration: 500 } }"
        class="flex items-center justify-center mt-2"
      >
        <span
          data-testid="login-app-version"
          class="font-mono text-[10px] text-cool/40 tabular-nums"
          :title="`MuHaven ${versionLabel}`"
        >{{ versionLabel }}</span>
      </div>
    </div>
  </div>
</template>
