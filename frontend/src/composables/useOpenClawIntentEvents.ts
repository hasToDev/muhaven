import { onUnmounted, ref } from 'vue'
import { openclawIntentEventsApi, type OpenClawIntentSseEvent } from '@/services/api'

/**
 * Wave 4 P4 — composable wrapping the OpenClaw intent SSE channel.
 *
 * The dashboard `/agent` route mounts an instance of this on its
 * `<script setup>` so a Telegram-confirmed intent (or denied / consumed)
 * fires through the SSE channel and the dashboard's open ConfirmModal
 * can react: `intent_confirmed` → auto-fire the on-chain leg via the
 * existing runner; `intent_denied` → close the modal politely.
 *
 * Reconnect strategy: the native EventSource auto-reconnects on
 * transport drops at the cadence the server's initial `retry: <ms>`
 * line sets (5s in `events.ts`). Our composable wraps the EventSource
 * + ensures `close()` runs on `onUnmounted` so a route navigation
 * doesn't leave a leaked connection. Backend doesn't time out idle
 * subscribers (heartbeat-driven), so reconnects only fire on actual
 * network drops.
 *
 * Privacy posture mirrors the backend channel: events carry the
 * cleartext intent preview the user already saw at propose time —
 * never the OTP, never the confirm-token, never an encrypted handle.
 */

export interface UseOpenClawIntentEventsOpts {
  /** Fired for every `intent_*` event from the server. The handler
   *  decides whether to act on it (e.g., match against the open
   *  ConfirmModal's openClawIntentId). */
  onEvent: (evt: OpenClawIntentSseEvent) => void
  /** Optional — surface transport errors. The composable does NOT
   *  auto-retry on permanent errors (HTTP 4xx); the EventSource
   *  re-connects on transient drops automatically. */
  onError?: (err: Event) => void
}

export function useOpenClawIntentEvents(opts: UseOpenClawIntentEventsOpts): {
  isOpen: ReturnType<typeof ref<boolean>>
  start: () => void
  stop: () => void
} {
  const isOpen = ref(false)
  let es: EventSource | null = null

  function start(): void {
    if (es) return
    es = openclawIntentEventsApi.open((evt) => {
      // Backend emits `open` once after subscribe handshake — flag the
      // composable so callers can disable polling fallbacks if any.
      if (evt.type === 'open') {
        isOpen.value = true
        return
      }
      opts.onEvent(evt)
    }, opts.onError)
    if (es === null) {
      // No JWT in localStorage — user isn't logged in. Caller (the
      // page) should re-invoke `start()` after auth lands; AgentPage
      // is auth-gated upstream so this branch is rarely hit, but it
      // defends against a route-mount race during JWT bootstrapping.
      isOpen.value = false
    }
  }

  function stop(): void {
    if (es) {
      es.close()
      es = null
    }
    isOpen.value = false
  }

  onUnmounted(stop)

  return { isOpen, start, stop }
}
