<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuth, RoleMismatchError } from '@/composables/useAuth'
import { useHomeTarget } from '@/composables/useHomeTarget'
import { cn } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import { Shield, Fingerprint, Loader2, AlertCircle, CheckCircle2, BadgeCheck } from 'lucide-vue-next'
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

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  localError.value = null
  username.value = ''
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4 py-12">
    <div
      v-motion
      :initial="{ opacity: 0, y: 24, scale: 0.97 }"
      :enter="{ opacity: 1, y: 0, scale: 1, transition: { duration: 500, ease: 'easeOut' } }"
      class="w-full max-w-md"
    >
      <!-- Glass card -->
      <div
        :class="cn(
          'relative overflow-hidden rounded-2xl',
          'bg-white/80 dark:bg-midnight-mid/80 backdrop-blur-xl',
          'ring-1 ring-haze dark:ring-white/8',
          'shadow-elevated',
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
                   they can change roles silently. -->
              <div
                v-if="isRegister"
                v-motion
                :initial="{ opacity: 0, y: 8 }"
                :enter="{ opacity: 1, y: 0, transition: { delay: 200, duration: 400 } }"
                class="mb-6"
              >
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

              <!-- Login mode intentionally renders no role-hint card.
                   The role selector is hidden (server-side source of
                   truth via ROLE_MISMATCH); a hint that explains the
                   absence read as redundant chrome to the user. The
                   ROLE_MISMATCH inline error below the form remains
                   the recovery path if a typo'd kernel returns the
                   wrong role. -->

              <!-- Username (register mode only) -->
              <transition
                enter-active-class="transition-all duration-300 ease-out"
                leave-active-class="transition-all duration-200 ease-in"
                enter-from-class="opacity-0 -translate-y-2 max-h-0"
                enter-to-class="opacity-100 translate-y-0 max-h-24"
                leave-from-class="opacity-100 translate-y-0 max-h-24"
                leave-to-class="opacity-0 -translate-y-2 max-h-0"
              >
                <div v-if="isRegister" class="mb-6 overflow-hidden">
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
                  {{ isRegister ? 'Create Account' : 'Sign In' }}
                </MButton>
              </div>

              <!-- Mode toggle -->
              <div
                v-motion
                :initial="{ opacity: 0 }"
                :enter="{ opacity: 1, transition: { delay: 400, duration: 400 } }"
                class="text-center"
              >
                <button
                  @click="toggleMode"
                  data-testid="auth-mode-toggle"
                  class="text-xs font-sans text-cool hover:text-compute transition-colors duration-200 cursor-pointer"
                >
                  {{ isRegister ? 'Already have an account? Sign in' : 'New here? Create account' }}
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
