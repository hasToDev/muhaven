<script setup lang="ts">
/**
 * Q4 + Q5 (post-§4 queue, 2026-05-14) — LinkTelegramModal
 *
 * Surfaces the existing `issueTelegramLink()` API as a visible UI
 * flow. Without this, the only way to mint a link code was via
 * DevTools console — operator workaround during the §4 walkthrough.
 * The bot DM ceremony is the gate for the entire post-§4 Telegram
 * propose-confirm flow + the grant-narrative-worthy demo.
 *
 * Flow:
 *  1. On open, calls `issueTelegramLink()` to mint a fresh link code.
 *  2. Renders three surfaces in one panel:
 *     a) A "Open in Telegram" deep-link button (botStartUrl) — works
 *        when phone + dashboard are on the same device.
 *     b) A "Copy link" affordance for cross-device flows (paste into
 *        the phone's Telegram).
 *     c) A QR code (Q5) encoding the same botStartUrl — desktop
 *        dashboard + phone Telegram scan-then-confirm is the
 *        cross-device UX win.
 *  3. Countdown to `expiresInSec`; the code is single-use AND time-
 *     bounded server-side. On expiry, surfaces a "Re-issue" CTA.
 *
 * Privacy note: the botStartUrl carries the `linkCode` after `?start=`.
 * The QR generation stays client-side (the QR generator gets the URL
 * + emits SVG inline); no third-party renderer sees the code.
 */

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { openClawApi, type TelegramLinkIssueResponse } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { toast } from 'vue-sonner'
import { Send, Copy, Check, X, RefreshCcw, Smartphone, Unlink2 } from 'lucide-vue-next'
import QRCode from 'qrcode'

const props = withDefaults(
  defineProps<{
    /** Q4 Part B — when set, modal mounts in "agent-triggered" mode:
     *  seeds linkData from the HavenBot tool result without re-issuing
     *  a fresh code. Stays optional so the sidebar's button-driven
     *  flow keeps its existing fresh-issue posture. */
    prefetched?: TelegramLinkIssueResponse | null
  }>(),
  { prefetched: null },
)

const emit = defineEmits<{ close: [] }>()

const authStore = useAuthStore()

const linkData = ref<TelegramLinkIssueResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const copied = ref(false)
const qrSvg = ref<string>('')
const now = ref(Date.now())
const issuedAtMs = ref<number | null>(null)
let tickHandle: ReturnType<typeof setInterval> | null = null
let pollHandle: ReturnType<typeof setInterval> | null = null
const unlinking = ref(false)

// Plan A — short-poll /me every 2s while the modal is open + the
// link code is unconsumed. As soon as the bot DM lands and the
// backend writes the link row, /me surfaces `telegram_link.linked=true`
// and we auto-close.
const POLL_INTERVAL_MS = 2000

const isLinked = computed(() => authStore.telegramLink?.linked === true)

const expiresAtMs = computed<number | null>(() => {
  if (!linkData.value || issuedAtMs.value === null) return null
  return issuedAtMs.value + linkData.value.expiresInSec * 1000
})

const remainingSec = computed<number>(() => {
  if (!expiresAtMs.value) return 0
  return Math.max(0, Math.round((expiresAtMs.value - now.value) / 1000))
})

const isExpired = computed(() => {
  return expiresAtMs.value !== null && now.value >= expiresAtMs.value
})

const countdownLabel = computed<string>(() => {
  const s = remainingSec.value
  if (s <= 0) return 'Expired'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m ${sec.toString().padStart(2, '0')}s` : `${sec}s`
})

async function seedFromPrefetched(data: TelegramLinkIssueResponse): Promise<void> {
  linkData.value = data
  issuedAtMs.value = Date.now()
  qrSvg.value = ''
  if (data.botStartUrl) {
    try {
      qrSvg.value = await QRCode.toString(data.botStartUrl, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        color: { dark: '#1a1714', light: '#00000000' },
      })
    } catch (e) {
      console.warn('[LinkTelegramModal] QR render failed', e)
    }
  }
}

async function issue(): Promise<void> {
  loading.value = true
  error.value = null
  qrSvg.value = ''
  try {
    const data = await openClawApi.issueTelegramLink()
    await seedFromPrefetched(data)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to issue link code'
  } finally {
    loading.value = false
  }
}

// Plan A — Unlink CTA on the linked-state branch.
async function unlink(): Promise<void> {
  if (unlinking.value) return
  unlinking.value = true
  try {
    await openClawApi.unlinkTelegram()
    // Invalidate the cached /me promise + refetch so the sidebar
    // pill + this modal's linked-state both flip in one tick.
    authStore.invalidateUserMeta()
    await authStore.fetchUserMeta()
    toast.success('Telegram unlinked')
    close()
  } catch (e) {
    toast.error('Unlink failed', {
      description: e instanceof Error ? e.message : String(e),
    })
  } finally {
    unlinking.value = false
  }
}

async function copyLink(): Promise<void> {
  if (!linkData.value?.botStartUrl) return
  try {
    await navigator.clipboard.writeText(linkData.value.botStartUrl)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch (e) {
    console.warn('[LinkTelegramModal] clipboard copy failed', e)
  }
}

function close(): void {
  emit('close')
}

// Re-issue refreshes the modal in-place — `issue()` overwrites
// `linkData.value` + `issuedAtMs.value`, the countdown re-derives.
async function reissue(): Promise<void> {
  await issue()
}

// ESC closes the modal — table-stakes UX. Hoisted out of onMounted
// so the listener teardown in onBeforeUnmount can reference the same
// function reference.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

onMounted(() => {
  // Q4 Part B — when the HavenBot triggers the modal it passes a
  // pre-minted linkCode through `prefetched`; reuse it instead of
  // burning another code.
  if (props.prefetched && !isLinked.value) {
    void seedFromPrefetched(props.prefetched)
  } else if (!isLinked.value) {
    void issue()
  }

  tickHandle = setInterval(() => {
    now.value = Date.now()
  }, 1000)

  // Plan A — short-poll /me so a successful link from the bot side
  // flips this modal closed without operator intervention. Only the
  // pending-link path polls; the linked-state branch is static.
  pollHandle = setInterval(async () => {
    if (isLinked.value) return
    try {
      authStore.invalidateUserMeta()
      await authStore.fetchUserMeta()
    } catch {
      // /me transient failure — keep polling; the next tick may
      // succeed. The cached telegramLink is preserved.
    }
  }, POLL_INTERVAL_MS)

  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
  if (pollHandle !== null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  window.removeEventListener('keydown', onKeydown)
})

// Plan A — auto-close on linked. Watcher fires whenever the
// authStore's telegramLink flips to truthy, regardless of whether
// the change came from the poll, the AgentPage's lookup, or a
// neighbouring tab updating localStorage.
watch(isLinked, (linked, prev) => {
  // Only auto-close on the unlinked → linked transition while the
  // modal is in its issue-and-wait state (prevents flickering close
  // when the modal mounts already-linked — that's the unlink surface).
  if (linked && !prev && linkData.value !== null) {
    const username = authStore.telegramLink?.telegram_username
    toast.success(username ? `Linked to @${username}` : 'Telegram linked')
    close()
  }
})
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center p-4
           bg-black/55 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="link-telegram-title"
    @click.self="close"
  >
    <div
      class="relative w-full max-w-[440px] rounded-2xl p-6 sm:p-7
             max-h-[calc(100dvh-2rem)] overflow-y-auto
             border border-haze dark:border-white/10
             bg-frost dark:bg-midnight-mid
             shadow-2xl"
    >
      <button
        type="button"
        class="absolute top-3 right-3 p-2 rounded-lg
               text-cool hover:text-compute
               dark:text-body-dark dark:hover:text-signal
               focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        :aria-label="'Close link Telegram dialog'"
        @click="close"
      >
        <X :size="18" />
      </button>

      <div class="flex items-center gap-3 mb-4">
        <div
          class="grid place-items-center size-10 rounded-xl
                 bg-gold/15 text-gold dark:text-signal"
        >
          <Send :size="20" />
        </div>
        <div>
          <h2
            id="link-telegram-title"
            class="font-accent text-[1.25rem] leading-tight text-compute dark:text-signal"
          >
            {{ isLinked ? 'Telegram connected' : 'Link your Telegram' }}
          </h2>
          <p class="text-xs text-cool dark:text-body-dark/70 mt-0.5">
            {{ isLinked
              ? 'Your account is linked — you can unlink any time'
              : 'Tap the bot in Telegram to finish linking' }}
          </p>
        </div>
      </div>

      <!-- Plan A — linked-state branch. Renders first so the modal
           mounts in this surface when the user re-opens it after
           a successful link (Sidebar pill click). -->
      <div
        v-if="isLinked"
        class="p-4 rounded-xl border border-positive/30 bg-positive/5 space-y-3"
      >
        <p class="text-sm text-compute dark:text-body-dark">
          Connected to
          <span class="font-mono text-compute dark:text-signal">
            {{ authStore.telegramLink?.telegram_username
              ? `@${authStore.telegramLink.telegram_username}`
              : 'Telegram' }}
          </span>
          since
          <span class="text-cool">
            {{ authStore.telegramLink ? new Date(authStore.telegramLink.linked_at).toLocaleDateString() : '' }}
          </span>.
        </p>
        <p class="text-xs text-cool dark:text-body-dark/70">
          The bot will DM you with confirmation prompts when an agent
          surface proposes a write. Unlink to stop receiving them.
        </p>
        <button
          type="button"
          :disabled="unlinking"
          class="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg
                 text-sm font-medium
                 border border-negative/40 text-negative
                 hover:bg-negative/10
                 disabled:opacity-50 disabled:cursor-not-allowed
                 transition-colors"
          data-testid="link-telegram-unlink"
          @click="unlink"
        >
          <Unlink2 :size="14" />
          {{ unlinking ? 'Unlinking…' : 'Unlink Telegram' }}
        </button>
      </div>

      <!-- Loading + error states -->
      <div
        v-else-if="loading"
        class="py-8 flex items-center justify-center text-cool dark:text-body-dark/70"
        role="status"
        aria-live="polite"
      >
        <span class="text-sm">Issuing link code…</span>
      </div>

      <div
        v-else-if="error"
        class="p-4 rounded-xl border border-negative/40 bg-negative/5 text-negative text-sm"
        role="alert"
      >
        {{ error }}
        <button
          type="button"
          class="mt-2 ml-auto block text-xs underline hover:no-underline"
          @click="reissue"
        >
          Try again
        </button>
      </div>

      <!-- Active link, with bot configured (the common path) -->
      <template v-else-if="linkData && !isExpired && linkData.botStartUrl">
        <!-- QR code (Q5). The container ALWAYS renders (reserves 180×180
             slot + caption row) so the modal doesn't visibly resize when
             the QR resolves. Skeleton placeholder fades into the SVG when
             ready. Operator-walkthrough fix 2026-05-14. -->
        <div class="mt-1 mb-4 flex flex-col items-center gap-2">
          <div
            class="rounded-xl p-3 bg-white dark:bg-frost
                   border border-haze dark:border-white/10
                   shadow-[0_2px_10px_-4px_rgba(63,46,12,0.18)]
                   dark:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.55)]"
            :style="{ width: '180px', height: '180px' }"
            role="img"
            :aria-label="qrSvg ? 'QR code — scan with phone to open the Telegram bot' : 'QR code rendering…'"
            :aria-busy="!qrSvg"
          >
            <div
              v-if="qrSvg"
              v-html="qrSvg"
              class="w-full h-full [&>svg]:w-full [&>svg]:h-full"
            />
            <!-- Skeleton: subtle pulsing block while qrcode lib resolves
                 (typically <50ms but can spike on slow devices). Same
                 dimensions as the QR, so no layout shift on swap. -->
            <div
              v-else
              class="w-full h-full rounded-lg bg-haze/50 dark:bg-white/10
                     animate-pulse"
              aria-hidden="true"
            />
          </div>
          <p class="text-[10px] uppercase tracking-[0.18em] text-cool/80">
            <Smartphone :size="11" class="inline-block mr-1 -mt-0.5" />
            Scan with phone
          </p>
        </div>

        <!-- Deep-link button (same-device flow) -->
        <a
          v-if="linkData.botStartUrl"
          :href="linkData.botStartUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="block w-full text-center py-3 px-5 rounded-xl
                 bg-gradient-to-r from-signal to-gold
                 text-midnight font-medium
                 hover:brightness-105 active:scale-[0.99]
                 shadow-[0_8px_28px_rgba(255,220,161,0.22)]
                 transition-all"
        >
          Open in Telegram
        </a>

        <!-- Copy link affordance -->
        <button
          type="button"
          class="mt-2 w-full text-center py-2.5 px-5 rounded-xl
                 border border-haze dark:border-white/10
                 text-compute dark:text-body-dark
                 hover:bg-haze/30 dark:hover:bg-white/5
                 inline-flex items-center justify-center gap-2
                 text-sm transition-colors"
          @click="copyLink"
        >
          <Check v-if="copied" :size="14" class="text-positive" />
          <Copy v-else :size="14" />
          {{ copied ? 'Copied' : 'Copy link' }}
        </button>

        <!-- Countdown + hint -->
        <p
          class="mt-3 text-center text-xs text-cool dark:text-body-dark/70"
          aria-live="polite"
        >
          Code expires in
          <span class="font-mono text-compute dark:text-signal">{{ countdownLabel }}</span>
        </p>
      </template>

      <!-- Post-review fix: bot not configured in this environment.
           `issueTelegramLink` succeeded (we got a linkCode) but the
           backend's TELEGRAM_BOT_USERNAME env var is unset, so we
           can't build a `t.me/<bot>?start=<code>` URL. Surface the
           raw linkCode so a sufficiently-motivated operator can DM
           the bot manually with `/start <linkCode>`. -->
      <template v-else-if="linkData && !isExpired && !linkData.botStartUrl">
        <div
          class="p-4 rounded-xl border border-haze dark:border-white/10 bg-mist dark:bg-midnight-deep text-sm text-cool dark:text-body-dark"
        >
          <p class="mb-2">
            The Telegram bot isn't configured in this environment, so
            we can't open a deep-link automatically. Paste this code
            into the bot manually with <code class="font-mono text-compute dark:text-signal">/start &lt;code&gt;</code>:
          </p>
          <code
            class="block px-3 py-2 rounded-lg bg-frost dark:bg-midnight font-mono text-xs text-compute dark:text-signal break-all"
            >{{ linkData.linkCode }}</code
          >
          <p
            class="mt-2 text-xs"
            aria-live="polite"
          >
            Code expires in
            <span class="font-mono text-compute dark:text-signal">{{ countdownLabel }}</span>
          </p>
        </div>
      </template>

      <!-- Expired state -->
      <div
        v-else-if="isExpired"
        class="p-4 rounded-xl border border-haze dark:border-white/10 bg-mist dark:bg-midnight-deep text-sm text-cool dark:text-body-dark"
      >
        <p class="mb-2">
          That link expired. Issue a fresh one — same flow.
        </p>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-compute dark:text-signal hover:underline text-sm font-medium"
          @click="reissue"
        >
          <RefreshCcw :size="13" />
          Re-issue link
        </button>
      </div>
    </div>
  </div>
</template>
