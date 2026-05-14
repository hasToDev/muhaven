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

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { openClawApi, type TelegramLinkIssueResponse } from '@/services/api'
import { Send, Copy, Check, X, RefreshCcw, Smartphone } from 'lucide-vue-next'
import QRCode from 'qrcode'

const emit = defineEmits<{ close: [] }>()

const linkData = ref<TelegramLinkIssueResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const copied = ref(false)
const qrSvg = ref<string>('')
const now = ref(Date.now())
const issuedAtMs = ref<number | null>(null)
let tickHandle: ReturnType<typeof setInterval> | null = null

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

async function issue(): Promise<void> {
  loading.value = true
  error.value = null
  qrSvg.value = ''
  try {
    const data = await openClawApi.issueTelegramLink()
    linkData.value = data
    issuedAtMs.value = Date.now()
    // Render QR for the bot-start URL. Fail soft — if QR rendering
    // throws (e.g., unsupported character) the deep-link + copy
    // surfaces remain functional.
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
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to issue link code'
  } finally {
    loading.value = false
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
  void issue()
  tickHandle = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
  window.removeEventListener('keydown', onKeydown)
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
      class="relative w-full max-w-[440px] rounded-2xl p-7
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
            Link your Telegram
          </h2>
          <p class="text-xs text-cool dark:text-body-dark/70 mt-0.5">
            Tap the bot in Telegram to finish linking
          </p>
        </div>
      </div>

      <!-- Loading + error states -->
      <div
        v-if="loading"
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
