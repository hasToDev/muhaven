import { onUnmounted, ref } from 'vue'
import {
  AUTH_TOKENS_ROTATED_EVENT,
  TOKEN_KEY,
  openclawIntentEventsApi,
  type OpenClawIntentSseEvent,
} from '@/services/api'

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
  // Track whether `start()` has ever been called so the JWT-rotation
  // listener doesn't open an EventSource for a page that never asked
  // for one in the first place (e.g., a non-/agent page that imported
  // the composable but never mounted).
  let started = false

  function start(): void {
    started = true
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

  // JWT-rotation handling: the access token is encoded into the
  // EventSource URL via `?access_token=…` (browser EventSource cannot
  // set custom headers). When `setStoredTokens` writes a fresh JWT to
  // `localStorage` (silent refresh on a 401, login flow, etc.), the
  // existing EventSource holds the now-stale URL — its native auto-
  // reconnect will 401 indefinitely. The fix: listen for the
  // same-tab `muhaven:auth-tokens-rotated` event AND the cross-tab
  // `storage` event (both fire on rotation paths) and tear down +
  // reopen the EventSource so the next `openclawIntentEventsApi.open`
  // call reads the freshest token from localStorage. Without this,
  // a >1h dashboard session silently loses SSE on the first reconnect
  // after the JWT TTL elapses.
  function reopenOnRotation(): void {
    if (!started) return
    if (!es) {
      // Not currently subscribed (e.g., page mounted without auth);
      // a future `start()` will use the rotated token naturally.
      return
    }
    stop()
    start()
  }

  function onStorageEvent(evt: StorageEvent): void {
    // Cross-tab rotation: `storage` fires in OTHER tabs when the
    // origin's localStorage changes. Filter on the auth-tokens key
    // to avoid restarting on unrelated localStorage writes.
    if (evt.key === TOKEN_KEY) reopenOnRotation()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_TOKENS_ROTATED_EVENT, reopenOnRotation)
    window.addEventListener('storage', onStorageEvent)
  }

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener(AUTH_TOKENS_ROTATED_EVENT, reopenOnRotation)
      window.removeEventListener('storage', onStorageEvent)
    }
    stop()
  })

  return { isOpen, start, stop }
}
