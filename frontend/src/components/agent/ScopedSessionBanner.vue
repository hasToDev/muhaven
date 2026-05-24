<script setup lang="ts">
/**
 * Wave 5 Option D · Commit 4 — global, navigation-persistent banner for
 * the user's Scoped (MCP-broker autonomy) session. Mounted once in
 * App.vue; reads the shared `useScopedSession` state and renders ONE of
 * two mutually-exclusive variants:
 *
 *   1. **Broker-purge reminder** (after a revoke) — the mirror flip is
 *      only half the kill-switch; the broker daemon still holds its
 *      on-disk key until restarted. Persists across navigation until
 *      dismissed.
 *   2. **Active-session banner** (a live Scoped session exists, no purge
 *      pending) — a compact standing "agent autonomy active" strip with a
 *      "Manage session" CTA into the PolicyTransitionPage revoke zone, and
 *      a dismiss (×) that hides it for THIS session. Hidden on the policy
 *      page (redundant there).
 *
 * Placement note (C4 smoke fix): App.vue wraps this in a `relative z-40`
 * container so the strip paints ABOVE per-page fixed asides (e.g. the
 * `/cash` wallet aside is `xl:fixed … z-30`, which previously covered the
 * right-aligned "Manage session" button). The dismiss × is the escape
 * valve when the strip is in the way.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, ChevronRight, Copy, Check, CircleCheck, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/stores/auth'
import { useScopedSession } from '@/composables/useScopedSession'
import {
  scopedExpiresInSec,
  formatExpiresIn,
  signerPrefix,
  formatMhUsdc6,
  isSessionLive,
} from '@/composables/scoped-session.helpers'

const POLICY_PATH = '/agent/policy/transition'

/** The env var the operator must clear from the broker daemon's
 *  environment before restarting it. OS-neutral on purpose — the prior
 *  `pkill …` one-liner was POSIX-only and failed on the Windows operator
 *  box (no `pkill`). The reminder copies THIS name; the visible text gives
 *  the platform-agnostic steps (stop → clear → restart). */
const BROKER_SESSION_KEY_ENV = 'MUHAVEN_BROKER_SESSION_KEY'

/** Module-level so a dismiss survives the banner's mount/unmount as the
 *  user moves between chrome and non-chrome routes. Keyed by sessionId →
 *  a NEW session (different id) re-shows the banner automatically; stale
 *  ids never match, so it self-heals across logout / re-mint. */
const dismissedSessionId = ref<string | null>(null)

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const { session, refresh, pendingBrokerPurge, dismissBrokerPurge } = useScopedSession()

// 1s ticker for the live expiry countdown + lapsed-TTL hide.
const nowMs = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

const showPurgeReminder = computed(() => pendingBrokerPurge.value !== null)

const showActiveBanner = computed(
  () =>
    !showPurgeReminder.value
    && authStore.isAuthenticated
    && route.path !== POLICY_PATH
    && isSessionLive(session.value, nowMs.value)
    && session.value?.sessionId !== dismissedSessionId.value,
)

const expiresLabel = computed(() =>
  session.value
    ? formatExpiresIn(scopedExpiresInSec(session.value.validUntilSec, nowMs.value))
    : '',
)

function goManage(): void {
  void router.push(`${POLICY_PATH}?surface=mcp&focus=revoke`)
}

function dismissActiveBanner(): void {
  dismissedSessionId.value = session.value?.sessionId ?? null
}

// ── Broker-purge env-var copy ───────────────────────────────────────
const purgeCopied = ref(false)
let purgeCopyTimer: ReturnType<typeof setTimeout> | null = null
async function copyEnvVar(): Promise<void> {
  try {
    await navigator.clipboard.writeText(BROKER_SESSION_KEY_ENV)
    purgeCopied.value = true
    if (purgeCopyTimer) clearTimeout(purgeCopyTimer)
    purgeCopyTimer = setTimeout(() => {
      purgeCopied.value = false
    }, 1500)
  } catch (e) {
    toast.error('Copy failed', {
      description: e instanceof Error ? e.message : 'Clipboard access denied',
    })
  }
}

// FE-R2 H-1 — fetch reactively on auth, not just at mount: the banner is
// mounted once (App.vue) and may be present before `useAuth.initialize()`
// resolves, or auth may land mid-session (silent re-login). `{ immediate:
// true }` covers the already-authed mount case.
watch(
  () => authStore.isAuthenticated,
  (authed) => {
    if (authed && session.value === null) void refresh()
  },
  { immediate: true },
)

onMounted(() => {
  ticker = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
  if (purgeCopyTimer !== null) {
    clearTimeout(purgeCopyTimer)
    purgeCopyTimer = null
  }
})
</script>

<template>
  <!-- Variant 1 — post-revoke broker-purge reminder (persists across nav) -->
  <div
    v-if="showPurgeReminder"
    data-testid="scoped-session-purge-reminder"
    role="status"
    class="mb-3 rounded-xl px-3.5 py-2.5 space-y-1.5
           border border-negative/40 bg-negative/5
           dark:border-negative/30 dark:bg-negative/10 backdrop-blur-sm"
  >
    <div class="flex items-start gap-2">
      <CircleCheck :size="14" class="mt-0.5 flex-shrink-0 text-positive" aria-hidden="true" />
      <p class="font-sans text-[12px] text-midnight dark:text-white leading-relaxed">
        <span class="font-semibold">Session revoked.</span>
        The backend no longer hands your policy to the broker — but the broker
        daemon still holds its key until you restart it. Stop
        <code class="font-mono text-[11px]">muhaven-broker</code>, remove
        <code class="font-mono text-[11px]">{{ BROKER_SESSION_KEY_ENV }}</code>
        from its environment, then start it again.
      </p>
    </div>
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        data-testid="scoped-session-purge-copy"
        @click="copyEnvVar"
        class="inline-flex items-center gap-1 px-2 py-1 rounded-md
               text-[11px] font-medium cursor-pointer
               text-compute dark:text-signal
               border border-haze dark:border-white/10
               hover:bg-mist/60 dark:hover:bg-white/5 transition-colors"
      >
        <Check v-if="purgeCopied" :size="11" class="text-positive" aria-hidden="true" />
        <Copy v-else :size="11" aria-hidden="true" />
        {{ purgeCopied ? 'Copied' : 'Copy env var' }}
      </button>
      <button
        type="button"
        data-testid="scoped-session-purge-dismiss"
        @click="dismissBrokerPurge"
        class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md
               text-[11px] font-medium cursor-pointer
               text-cool hover:text-midnight dark:hover:text-white transition-colors"
      >
        <X :size="11" aria-hidden="true" />
        Restarted — dismiss
      </button>
    </div>
    <span class="sr-only" role="status" aria-live="polite">
      {{ purgeCopied ? 'Environment variable name copied to clipboard' : '' }}
    </span>
  </div>

  <!-- Variant 2 — active-session standing signal (compact single row) -->
  <transition name="banner-fade">
    <div
      v-if="showActiveBanner"
      data-testid="active-session-banner"
      role="status"
      class="mb-3 flex items-center gap-2.5 rounded-xl px-3.5 py-2
             border border-gold/40 dark:border-signal/30
             bg-gold/12 dark:bg-signal/10 backdrop-blur-sm"
    >
      <KeyRound
        :size="15"
        :stroke-width="1.9"
        class="flex-shrink-0 text-compute dark:text-signal"
        aria-hidden="true"
      />
      <p class="min-w-0 flex-1 text-[12px] leading-tight truncate">
        <span class="font-sans font-semibold text-compute dark:text-signal">Agent autonomy active</span>
        <span class="font-sans text-cool dark:text-body-dark/80">
          · <span class="font-mono">{{ signerPrefix(session?.signerAddress) }}</span>
          · expires <span class="font-mono" data-testid="active-session-banner-expiry">{{ expiresLabel }}</span>
          · ≤<span class="font-mono">{{ formatMhUsdc6(session?.maxPerOpUsd6) }}</span> mhUSDC/buy
        </span>
      </p>
      <button
        type="button"
        data-testid="active-session-banner-cta"
        @click="goManage"
        class="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-lg
               text-[12px] font-sans font-semibold cursor-pointer
               text-compute dark:text-signal
               border border-gold/45 dark:border-signal/35
               bg-white/60 dark:bg-white/5
               hover:bg-white/90 dark:hover:bg-white/10 transition-colors duration-150"
      >
        Manage session
        <ChevronRight :size="13" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="active-session-banner-dismiss"
        @click="dismissActiveBanner"
        aria-label="Hide the agent-autonomy banner for this session"
        class="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md cursor-pointer
               text-cool hover:text-midnight dark:hover:text-white
               hover:bg-white/60 dark:hover:bg-white/10 transition-colors"
      >
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </transition>
</template>

<style scoped>
.banner-fade-enter-active,
.banner-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.banner-fade-enter-from,
.banner-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .banner-fade-enter-active,
  .banner-fade-leave-active {
    transition: none;
  }
}
</style>
