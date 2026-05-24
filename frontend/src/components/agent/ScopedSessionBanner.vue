<script setup lang="ts">
/**
 * Wave 5 Option D · Commit 4 — global, navigation-persistent banner for
 * the user's Scoped (MCP-broker autonomy) session. Mounted once in
 * App.vue; reads the shared `useScopedSession` state and renders ONE of
 * two mutually-exclusive variants:
 *
 *   1. **Broker-purge reminder** (when a revoke just happened) — the
 *      "sticky panel" from the C4 spec. The mirror flip is only half the
 *      kill-switch; the broker daemon still holds the on-disk key until
 *      the operator restarts it. This variant PERSISTS across page
 *      navigation (the spec's requirement) until the operator dismisses
 *      it, and shows everywhere — including the policy page itself.
 *
 *   2. **Active-session banner** (when a live Scoped session exists and
 *      no purge is pending) — a standing "agent autonomy active" signal
 *      with a "Manage session" CTA into the PolicyTransitionPage revoke
 *      zone. Hidden on the policy page (redundant there).
 *
 * Auto-clear on a broker IPC ack lands in a later slice; today the purge
 * reminder is a manual dismiss.
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

/** The broker session-key purge one-liner the sticky reminder offers to
 *  copy. POSIX shape (the operator's broker daemon runs on a *nix-style
 *  host per the homelab/runbook); the visible copy explains the intent so
 *  a Windows operator can adapt. */
const BROKER_PURGE_CMD = 'pkill -f muhaven-broker && unset MUHAVEN_BROKER_SESSION_KEY'

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
    && isSessionLive(session.value, nowMs.value),
)

const expiresLabel = computed(() =>
  session.value
    ? formatExpiresIn(scopedExpiresInSec(session.value.validUntilSec, nowMs.value))
    : '',
)

function goManage(): void {
  void router.push(`${POLICY_PATH}?surface=mcp&focus=revoke`)
}

// ── Broker-purge copy ───────────────────────────────────────────────
const purgeCopied = ref(false)
let purgeCopyTimer: ReturnType<typeof setTimeout> | null = null
async function copyPurgeCmd(): Promise<void> {
  try {
    await navigator.clipboard.writeText(BROKER_PURGE_CMD)
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
// resolves, or auth may land mid-session (silent re-login). A bare
// `onMounted` fetch would skip those and leave the banner permanently
// blank. `{ immediate: true }` covers the already-authed mount case.
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
    class="mt-6 mb-2 rounded-xl px-4 py-3 space-y-2.5
           border border-negative/40 bg-negative/5
           dark:border-negative/30 dark:bg-negative/10"
  >
    <div class="flex items-start gap-2">
      <CircleCheck :size="15" class="mt-0.5 flex-shrink-0 text-positive" aria-hidden="true" />
      <p class="font-sans text-[12px] text-midnight dark:text-white leading-relaxed">
        <span class="font-semibold">Step 1 / 2 · Mirror revoked.</span>
        The backend will no longer hand your policy to the broker.
      </p>
    </div>
    <div class="flex items-start gap-2">
      <span
        class="mt-0.5 inline-flex h-[15px] w-[15px] items-center justify-center flex-shrink-0
               text-[11px] text-gold dark:text-signal"
        aria-hidden="true"
      >⏳</span>
      <div class="min-w-0 flex-1">
        <p class="font-sans text-[12px] text-midnight dark:text-white leading-relaxed">
          <span class="font-semibold">Step 2 / 2 · Broker still holds the key.</span>
          Restart your broker daemon to drop its in-memory session key.
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <code
            class="font-mono text-[10.5px] px-2 py-1 rounded-md min-w-0 truncate
                   bg-midnight/5 dark:bg-white/5 text-cool dark:text-body-dark"
          >{{ BROKER_PURGE_CMD }}</code>
          <button
            type="button"
            data-testid="scoped-session-purge-copy"
            @click="copyPurgeCmd"
            class="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md
                   text-[11px] font-medium cursor-pointer
                   text-compute dark:text-signal
                   border border-haze dark:border-white/10
                   hover:bg-mist/60 dark:hover:bg-white/5 transition-colors"
          >
            <Check v-if="purgeCopied" :size="11" class="text-positive" aria-hidden="true" />
            <Copy v-else :size="11" aria-hidden="true" />
            {{ purgeCopied ? 'Copied' : 'Copy command' }}
          </button>
        </div>
        <!-- A11y (R1 Issue 3): announce the clipboard result to SR users —
             the inline icon/label swap alone is silent. -->
        <span class="sr-only" role="status" aria-live="polite">
          {{ purgeCopied ? 'Broker purge command copied to clipboard' : '' }}
        </span>
      </div>
    </div>
    <div class="flex justify-end">
      <button
        type="button"
        data-testid="scoped-session-purge-dismiss"
        @click="dismissBrokerPurge"
        class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md
               text-[11px] font-medium cursor-pointer
               text-cool hover:text-midnight dark:hover:text-white transition-colors"
      >
        <X :size="11" aria-hidden="true" />
        I've restarted the broker — dismiss
      </button>
    </div>
  </div>

  <!-- Variant 2 — active-session standing signal -->
  <transition name="banner-fade">
    <div
      v-if="showActiveBanner"
      data-testid="active-session-banner"
      role="status"
      class="mt-6 mb-2 flex items-center gap-3 rounded-xl px-4 py-3
             border border-gold/40 dark:border-signal/30
             bg-gold/8 dark:bg-signal/8
             shadow-[0_4px_20px_-12px_rgba(184,134,11,0.35)]"
    >
      <div
        class="w-8 h-8 rounded-full bg-gold/15 dark:bg-signal/15
               flex items-center justify-center flex-shrink-0"
      >
        <KeyRound :size="15" :stroke-width="1.9" class="text-compute dark:text-signal" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="font-sans text-[13px] font-semibold text-compute dark:text-signal leading-tight">
          Agent autonomy active
        </p>
        <p class="font-sans text-[11px] text-cool dark:text-body-dark/80 leading-relaxed truncate">
          Signer
          <span class="font-mono">{{ signerPrefix(session?.signerAddress) }}</span>
          · expires
          <span class="font-mono" data-testid="active-session-banner-expiry">{{ expiresLabel }}</span>
          · up to
          <span class="font-mono">{{ formatMhUsdc6(session?.maxPerOpUsd6) }}</span>
          mhUSDC / buy
        </p>
      </div>
      <button
        type="button"
        data-testid="active-session-banner-cta"
        @click="goManage"
        class="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg
               text-[12px] font-sans font-semibold cursor-pointer
               text-compute dark:text-signal
               border border-gold/45 dark:border-signal/35
               bg-white/50 dark:bg-white/5
               hover:bg-white/80 dark:hover:bg-white/10 transition-colors duration-150"
      >
        Manage session
        <ChevronRight :size="13" aria-hidden="true" />
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
