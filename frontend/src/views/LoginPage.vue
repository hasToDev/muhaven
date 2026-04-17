<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { cn } from '@/lib/utils'
import MButton from '@/components/ui/MButton.vue'
import { Shield, Fingerprint, Loader2, AlertCircle, CheckCircle2 } from 'lucide-vue-next'
import type { UserRole } from '@/services/api'

const router = useRouter()
const route = useRoute()
const auth = useAuth()

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
const authStep = ref<'idle' | 'working' | 'done'>('idle')
const localError = ref<string | null>(null)

const isRegister = computed(() => mode.value === 'register')
const isWorking = computed(() => authStep.value === 'working')

const stepLabel = computed(() => {
  switch (authStep.value) {
    case 'working': return isRegister.value ? 'Creating passkey & signing in...' : 'Authenticating with passkey...'
    case 'done': return 'Welcome to MuHaven'
    default: return ''
  }
})

// Redirect if already authenticated
onMounted(() => {
  if (auth.isAuthenticated.value) {
    redirectToDashboard()
  }
})

watch(() => auth.isAuthenticated.value, (v) => {
  if (v) redirectToDashboard()
})

function redirectToDashboard() {
  const redirect = route.query.redirect as string | undefined
  // Only allow relative paths to prevent open redirect
  const safeRedirect = redirect?.startsWith('/') ? redirect : undefined
  const target = safeRedirect || (auth.role.value === 'issuer' ? '/tokens' : '/portfolio')
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

    await auth.login(
      mode.value,
      selectedRole.value,
      isRegister.value ? username.value.trim() : undefined,
    )

    authStep.value = 'done'
    await new Promise(r => setTimeout(r, 600))
    redirectToDashboard()
  } catch (e) {
    authStep.value = 'idle'
    localError.value = auth.error.value || (e instanceof Error ? e.message : 'Authentication failed')
  }
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
            <div class="flex items-center gap-3 mb-3">
              <img
                src="/logo.jpg"
                alt="MuHaven"
                class="w-10 h-10 rounded-xl shadow-sm"
                style="mix-blend-mode: multiply"
              />
              <span class="text-2xl font-sans font-bold text-midnight dark:text-white tracking-tight">
                MuHaven
              </span>
            </div>
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

          <!-- Form (hidden during auth flow) -->
          <transition
            enter-active-class="transition-all duration-300 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0"
            leave-to-class="opacity-0"
          >
            <div v-if="!isWorking && authStep !== 'done'">
              <!-- Role selector -->
              <div
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
              </div>

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
    </div>
  </div>
</template>
