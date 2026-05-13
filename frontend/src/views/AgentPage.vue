<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useAgentStore } from '@/stores/agent'
import { cn } from '@/lib/utils'
import ActionCard from '@/components/agent/ActionCard.vue'
import ConfirmModal from '@/components/agent/ConfirmModal.vue'
import { runAgentAction } from '@/composables/useAgentActionRunner'
import { useOpenClawIntentEvents } from '@/composables/useOpenClawIntentEvents'
import type { ActionDescriptor } from '@/services/api'
import { openClawApi } from '@/services/api'
import { toast } from 'vue-sonner'
import {
  Sparkles, Send, Zap, PieChart, ArrowDown, Shield, User, ShieldCheck, Lightbulb,
} from 'lucide-vue-next'

const agentStore = useAgentStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const inputFocused = ref(false)
const confirmModalRef = ref<InstanceType<typeof ConfirmModal> | null>(null)
const activeAction = ref<ActionDescriptor | null>(null)

// When a propose_* tool result arrives, mount the ConfirmModal for the
// next pending action. The composable maintains a queue; we pop the
// front whenever the modal closes.
watch(
  () => agentStore.pendingActions.length,
  (n) => {
    if (n > 0 && !activeAction.value) {
      activeAction.value = agentStore.pendingActions[0] ?? null
    }
  },
)

// Within-tab dedupe for Telegram-linked actions. The cross-tab
// localStorage `tryAcquireFireLock` below covers "two open dashboard
// tabs both auto-fire on SSE". The within-tab `firingIntents` set
// covers Q6 (i)'s new shape: ONE tab where the user taps "Use
// dashboard instead" → manual Authorize starts the runner, AND moments
// later the SSE `intent_confirmed` event lands and tries to call
// onAuthorize a second time. Without this guard, the runner fires
// twice (double on-chain Subscription.purchase, drained mhUSDC,
// wasted gas — the second commit POST fails on confirm-token
// single-use but the on-chain leg already fired). The lock is
// acquired at the top of `onAuthorize` and released in its `try…finally`
// — the only call site, so terminal-state hooks (`onConfirmComplete` /
// `onConfirmCancel`) don't need to release it. Cancel is disabled
// during awaiting/submitting/committing so a user cannot dismiss
// mid-flight; the finally always runs whether the runner returns or
// throws.
const firingIntents = new Set<string>()

function tryAcquireWithinTabIntentLock(intentId: string): boolean {
  if (firingIntents.has(intentId)) return false
  firingIntents.add(intentId)
  return true
}

function releaseWithinTabIntentLock(intentId: string): void {
  firingIntents.delete(intentId)
}

async function onAuthorize(action: ActionDescriptor): Promise<void> {
  // Q6 (i) — for Telegram-linked actions, the same intent can be
  // dispatched by either (a) the dashboard's Authorize CTA in
  // "Use dashboard instead" fallback mode, or (b) the SSE
  // intent_confirmed handler below. The lock makes the second caller
  // a silent no-op so the runner only fires once.
  const intentIdRaw = action.preview.openClawIntentId
  const intentId =
    typeof intentIdRaw === 'string' && intentIdRaw.length > 0 ? intentIdRaw : null
  if (intentId !== null && !tryAcquireWithinTabIntentLock(intentId)) {
    return
  }
  try {
    // Tell the modal we're submitting so it shows the spinner state.
    confirmModalRef.value?.setSubmitting()
    const result = await runAgentAction(action)
    await confirmModalRef.value?.reportResult(result)
    if (result.ok === true) {
      toast.success('Confirmed', {
        description: `Action ${action.kind} settled. The audit log has the receipt.`,
      })
    } else if (result.ok === 'deferred') {
      toast.info('Continue on the next page', { description: result.reason })
    }
  } finally {
    if (intentId !== null) releaseWithinTabIntentLock(intentId)
  }
}

// ── Wave 4 P4 — back-to-dashboard auto-fire on Telegram confirm ─────
//
// When the open ConfirmModal carries an `openClawIntentId` (set by
// `propose-buy.use-case` when the user has linked Telegram), an
// `intent_confirmed` SSE event for that id auto-fires the runner so the
// user doesn't need to walk back to the dashboard tab and re-click
// Authorize — the kernel session-key signs the on-chain leg in this
// already-open tab. `intent_denied` closes the modal politely. Other
// events (different intent, different tier, different action kind) are
// ignored.
//
// Wave 4 limitation pinned in the runbook: this is single-process MVP
// (one backend replica → in-memory EventEmitter). Multi-replica deploys
// (Wave 5) need Redis pub/sub.

// Cross-tab fire-lock: prevent two open dashboard tabs from BOTH
// auto-firing `Subscription.purchase` for the same intent (would fire
// the on-chain tx twice + drain mhUSDC twice + waste gas; only the
// first commit POST would succeed because the confirm-token is
// single-use, but the on-chain leg already fired before that). This is
// best-effort dedupe via localStorage — the practical race window
// (sub-millisecond) is small enough that a check-then-set is reliable
// for the SSE-arrival-in-multiple-tabs scenario.
const FIRE_LOCK_TTL_MS = 90_000
const FIRE_LOCK_KEY_PREFIX = 'muhaven-openclaw-firelock:'
const TAB_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`

function tryAcquireFireLock(intentId: string): boolean {
  const key = `${FIRE_LOCK_KEY_PREFIX}${intentId}`
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      try {
        const claim = JSON.parse(raw) as { tabId: string; ts: number }
        if (Date.now() - claim.ts < FIRE_LOCK_TTL_MS) {
          // Active claim — back off regardless of which tab claimed it.
          // (Same-tab dedupe matters too: a bot worker retry could
          // publish the same `intent_confirmed` twice for one intent;
          // the second dispatch must NOT fire `Subscription.purchase`
          // again. The tabId field below is for forensic logging only,
          // not for gating.)
          return false
        }
      } catch {
        // Malformed payload — overwrite.
      }
    }
    localStorage.setItem(key, JSON.stringify({ tabId: TAB_ID, ts: Date.now() }))
    return true
  } catch {
    // localStorage may throw in incognito / strict-storage modes; cross-
    // tab dedupe is best-effort, so fall through to fire on this tab
    // (single-tab user → no race to dedupe; multi-tab user in a
    // restricted-storage browser is a rare combination).
    return true
  }
}

const intentEvents = useOpenClawIntentEvents({
  onEvent: (evt) => {
    if (evt.type !== 'intent_confirmed' && evt.type !== 'intent_denied') return
    const action = activeAction.value
    if (!action) return
    if (action.kind !== 'buy') return
    // `action.preview` is typed as `Record<string, unknown>` upstream
    // (the frontend ActionDescriptor isn't a per-kind discriminated
    // union yet), so explicitly narrow to `string` before comparing
    // against `evt.intentId`. The backend always emits this field as a
    // string (or omits it entirely) per the BuyActionDescriptor wire
    // shape — the typeof guard is defense-in-depth against a future
    // backend bug, not a real expected runtime branch.
    const openClawIntentIdRaw = action.preview.openClawIntentId
    if (typeof openClawIntentIdRaw !== 'string' || openClawIntentIdRaw.length === 0) return
    const openClawIntentId: string = openClawIntentIdRaw
    if (openClawIntentId !== evt.intentId) return
    if (evt.type === 'intent_confirmed') {
      // Acquire the cross-tab fire-lock BEFORE any toast / runner call
      // so a losing tab is silent (no misleading "Authorizing…" toast,
      // no on-chain tx fired). The winning tab proceeds with the
      // toast + onAuthorize call.
      if (!tryAcquireFireLock(openClawIntentId)) {
        return
      }
      // Surface to operator that the cross-surface confirm landed
      // BEFORE we fire on-chain — it makes the auto-fire less magical.
      const sourceLabel =
        evt.payload?.source === 'telegram_inline'
          ? 'Telegram'
          : evt.payload?.source === 'mini_app'
            ? 'Telegram Mini App'
            : 'cross-surface'
      toast.info(`Confirmed via ${sourceLabel}`, {
        description: 'Authorizing the on-chain leg from this tab…',
      })
      // Reuse the same path the manual Authorize button takes — the
      // ConfirmModal flips status='awaiting' → runner → reportResult.
      // The runner's commit POST closes the audit loop with the same
      // confirmTokenId the dashboard already holds.
      void onAuthorize(action)
    } else {
      // intent_denied — clear the modal + audit-row already lands on
      // the backend side; no commit POST fires from here.
      toast.info('Denied via Telegram', {
        description: 'Nothing was submitted on-chain.',
      })
      onConfirmCancel(action)
    }
  },
  onError: (err) => {
    // Transient drops auto-reconnect. A persistent 401 / 403 means the
    // JWT expired between subscribe-time and now; the next `/me` poll
    // refreshes it and AgentPage's mount hook will re-invoke `start()`
    // on next route entry.
    console.warn('[openclaw-intent-events] sse error', err)
  },
})

// ── Q7 (post-§4 queue, 2026-05-14) — intent-status lookup on
// activeAction change ──────────────────────────────────────────────
//
// When a Telegram-linked descriptor mounts (or is advanced into via the
// H-1 success fix in onConfirmComplete), call `lookupIntent` once to
// catch up with the backend's state. The race window this closes:
//   1. User proposes buy A (Telegram-linked, openClawIntentId = idA).
//      Modal mounts. activeAction = A.
//   2. User proposes buy B BEFORE A's runner completes (modal A still
//      open, B sits at pendingActions[1]).
//   3. Bot DM A — user confirms A. SSE intent_confirmed for A → onAuthorize(A)
//      runs. A settles. onConfirmComplete advances activeAction → B.
//   4. Meanwhile bot DM B — user confirms B. SSE intent_confirmed for B
//      arrived at step 3.5 (BEFORE A's modal closed), so the SSE handler
//      checked activeAction = A and bailed (idA !== idB). The event was
//      DROPPED — B's modal renders "Waiting for Telegram…" forever even
//      though the backend has B at status='confirmed'.
//
// This watcher catches up: on every activeAction → non-null transition
// (initial mount OR H-1 auto-advance), if the new descriptor has an
// openClawIntentId AND we haven't looked it up yet in this page session,
// fire one lookup. Dispatch:
//   - status === 'confirmed' → call onAuthorize (within-tab firingIntents
//     lock prevents double-fire if SSE also arrives concurrently).
//   - status === 'denied' | 'consumed' | 'expired' → call onConfirmCancel
//     + surface a toast so the operator knows why the modal closed.
//   - status === 'pending' → no action (waiting for SSE as today).
//
// Idempotency: track looked-up intent IDs in a Set. The "Use dashboard
// instead" escape hatch remains as belt-and-suspenders for the case
// where lookup itself fails (5xx / network).
const lookedUpIntents = new Set<string>()

async function lookupAndDispatchForActiveAction(
  action: ActionDescriptor,
): Promise<void> {
  if (action.kind !== 'buy') return
  const intentIdRaw = action.preview.openClawIntentId
  if (typeof intentIdRaw !== 'string' || intentIdRaw.length === 0) return
  const intentId = intentIdRaw
  if (lookedUpIntents.has(intentId)) return
  lookedUpIntents.add(intentId)
  let summary
  try {
    summary = await openClawApi.lookupIntent(intentId)
  } catch (err) {
    console.warn('[openclaw-intent-lookup] failed', err)
    // Lookup failure isn't fatal — the escape hatch (Use dashboard
    // instead) + SSE channel both remain. Don't remove from the set;
    // a retry would re-spam the backend on every watcher tick. Trust
    // the operator to refresh the page if it persists.
    return
  }
  switch (summary.status) {
    case 'confirmed':
      // Fire the runner. The within-tab `firingIntents` lock (acquired
      // at the top of onAuthorize) makes a concurrent SSE-driven call
      // a silent no-op.
      void onAuthorize(action)
      break
    case 'denied':
      toast.info('Denied via Telegram', {
        description: 'Nothing was submitted on-chain.',
      })
      onConfirmCancel(action)
      break
    case 'consumed':
      // Backend has already processed this intent (probably via a
      // different tab or device). The audit row exists; just close
      // the modal so the user doesn't see a stale "Waiting…" panel.
      toast.info('Already handled', {
        description: 'This intent was settled from another surface.',
      })
      onConfirmCancel(action)
      break
    case 'expired':
      toast.info('Confirmation window expired', {
        description: 'Re-issue the action to try again.',
      })
      onConfirmCancel(action)
      break
    case 'pending':
    default:
      // Continue waiting for SSE.
      break
  }
}

watch(
  () => activeAction.value,
  (action) => {
    if (action) {
      void lookupAndDispatchForActiveAction(action)
    }
  },
)

function onConfirmComplete(payload: {
  action: ActionDescriptor
  ok: boolean
  txHash?: string | null
  error?: string
}): void {
  // Remove the action from the pending queue regardless of ok/fail —
  // the user has either authorized + (succeeded|failed) or cancelled.
  agentStore.consumePendingAction(payload.action.toolCallId)
  // Q6 (i) follow-up — when a SUCCESS terminal state lands, advance
  // immediately to the next queued action (if any). Two back-to-back
  // propose-buy calls with Telegram linked produce a window where the
  // second intent's `intent_confirmed` SSE event can arrive before its
  // ConfirmModal mounts (the prior success modal is still open + the
  // watcher's `!activeAction.value` guard suppresses the swap). That
  // would strand the second auto-fire silently (the SSE handler reads
  // the stale prior `activeAction.preview.openClawIntentId` and
  // refuses to match the new intent). The success-receipt toast +
  // audit row preserve the prior tx-hash / Arbiscan link, so dropping
  // the success modal is lossless. ERROR and DEFERRED terminal states
  // continue to keep the modal mounted because their actionable copy
  // (e.g. "you have $5, need $100; wrap more first") is load-bearing
  // and the toast auto-dismisses too fast — operator feedback
  // 2026-05-09 on the runner balance gate.
  //
  // EXCEPTION (third-pass walkthrough operator feedback 2026-05-1?):
  // `create_checkout` is a single-shot action whose SUCCESS terminal
  // state IS the load-bearing surface — the buyer URL + fragment key
  // (after `#k=`) are surfaced ONCE inside `CreateCheckoutSuccessCard`,
  // backend can never reproduce the key, and there's no audit-row /
  // toast fallback that carries the URL. Auto-advancing dismisses the
  // modal before the operator can Copy / Open. Keep the success modal
  // mounted; the operator dismisses via X or backdrop when done.
  if (payload.ok === true && payload.action.kind !== 'create_checkout') {
    const next = agentStore.pendingActions[0] ?? null
    activeAction.value = next
  }
}

function onConfirmCancel(action: ActionDescriptor): void {
  agentStore.consumePendingAction(action.toolCallId)
  activeAction.value = null
}

// Teleport the right aside to <body> on xl+ so `position: fixed` works
// against the viewport. Without teleport, the page-transition transform
// on the wrapper makes `xl:fixed` resolve against the wrapper, breaking
// the fixed-right layout (same fix as Deposit, D-041).
const isXl = useMediaQuery('(min-width: 1280px)')

const suggestedPrompts = [
  { text: 'Optimize my yield allocation', hint: 'Rebalance based on risk profile', icon: Zap, accent: 'gold' as const },
  { text: 'Show portfolio breakdown', hint: 'View current asset distribution', icon: PieChart, accent: 'compute' as const },
  { text: 'Deposit $5,000 USDC', hint: 'Initiate a secure transfer', icon: ArrowDown, accent: 'gold' as const },
  { text: 'Check compliance status', hint: 'Review KYC and regulatory flags', icon: Shield, accent: 'compute' as const },
]

const WELCOME_GREETING = "Hi — I'm your MuHaven portfolio agent. I operate entirely on encrypted data. How can I help?"

// The "Recommended Actions" / form / status / insight card only renders on the
// LATEST agent message — older messages keep their text but drop their card so
// stale action prompts don't accumulate in the chat (matches reference behavior).
const latestAgentMessageId = computed(() => {
  for (let i = agentStore.messages.length - 1; i >= 0; i--) {
    if (agentStore.messages[i].role === 'agent') {
      return agentStore.messages[i].id
    }
  }
  return null
})

// Hide the empty agent placeholder bubble while we're still waiting on
// the SSE stream. The store pushes a `text: ''` agent message at
// send-time so the streamingText watcher has a target to mirror into,
// but rendering it before any token / tool_call lands produces a
// double bubble next to the typing indicator below. Surfaced
// 2026-05-09 — operator wanted "1 line of dots, not an empty bubble +
// dots". Once a delta or tool_call lands, msg.text / actions /
// cardData populates and the bubble shows normally.
const visibleMessages = computed(() =>
  agentStore.messages.filter((m) => {
    if (m.role === 'user') return true
    return Boolean(m.text)
      || Boolean(m.cardData)
      || (Array.isArray(m.actions) && m.actions.length > 0)
  }),
)

function sendMessage(text?: string) {
  const msg = text || input.value.trim()
  if (!msg) return
  agentStore.sendMessage(msg)
  input.value = ''
  scrollToBottom()
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  })
}

// Clicking a Recommended Action button is identical to typing the label into
// the input — it forwards the user's pick back to the agent so the next reply
// continues the conversation around that recommendation.
function handleAction(label: string) {
  sendMessage(label)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

watch(() => agentStore.messages.length, scrollToBottom)

onMounted(() => {
  const prompt = agentStore.consumePrompt()
  if (prompt) {
    input.value = prompt
  }
  scrollToBottom()
  // Subscribe to OpenClaw intent events so a Telegram-confirmed mid-tier
  // intent can auto-fire the on-chain leg without the operator coming
  // back here and re-clicking Authorize. composable's onUnmounted hook
  // closes the EventSource on route navigation.
  intentEvents.start()
})
</script>

<template>
  <div>
    <!-- Wave 4 P2 — per-action confirmation surface. Mounts when the
         LLM emits a propose_* tool result and the user has not yet
         authorized + the queue isn't empty. Teleported to <body> so
         the backdrop covers the full viewport regardless of layout. -->
    <Teleport to="body">
      <ConfirmModal
        ref="confirmModalRef"
        :action="activeAction"
        @confirm="onAuthorize"
        @cancel="onConfirmCancel"
        @complete="onConfirmComplete"
      />
    </Teleport>

    <!-- ── Chat column (with input bar pinned at bottom).
         On xl+: `xl:mr-80` reserves space for the fixed right aside. ── -->
    <div class="flex flex-col h-[calc(100vh-2.75rem)] xl:mr-80">
      <!-- Scrollable messages -->
      <div
        ref="messagesEl"
        class="flex-1 overflow-y-auto px-2 lg:px-4 pb-9 space-y-6 no-scrollbar scroll-smooth"
      >
        <!-- Welcome greeting (rendered as a static agent-styled bubble when empty) -->
        <div
          v-if="agentStore.messages.length === 0"
          v-motion
          :initial="{ opacity: 0, y: 12 }"
          :enter="{ opacity: 1, y: 0, transition: { duration: 360 } }"
          class="flex justify-start gap-6 w-full group"
        >
          <div
            class="w-10 h-10 rounded-xl bg-mist dark:bg-[#171717] border border-haze dark:border-white/10
                   flex items-center justify-center flex-shrink-0 shadow-sm self-start"
          >
            <Sparkles :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>
          <div class="flex-1 min-w-0">
            <span
              class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2 block
                     opacity-60 group-hover:opacity-100 transition-opacity"
            >
              HavenBot
            </span>
            <div
              class="relative overflow-hidden rounded-2xl rounded-tl-sm pl-5 pr-4 py-3.5
                     font-sans text-base leading-relaxed
                     bg-mist/40 dark:bg-[#0d0e10] text-midnight dark:text-white
                     border border-haze dark:border-white/5 shadow-2xl"
            >
              <span aria-hidden="true" class="absolute top-0 bottom-0 left-0 w-1.5 bg-gold dark:bg-signal" />
              {{ WELCOME_GREETING }}
            </div>
          </div>
        </div>

        <!-- Messages -->
        <div
          v-for="msg in visibleMessages"
          :key="msg.id"
          v-motion
          :initial="{ opacity: 0, y: 12 }"
          :enter="{ opacity: 1, y: 0, transition: { duration: 320 } }"
          :data-testid="msg.role === 'user' ? 'agent-message-user' : 'agent-message-agent'"
          :data-message-id="msg.id"
          :class="['flex w-full gap-6 group', msg.role === 'user' ? 'justify-end' : 'justify-start']"
        >
          <!-- Agent avatar (left) -->
          <div
            v-if="msg.role === 'agent'"
            class="w-10 h-10 rounded-xl bg-mist dark:bg-[#171717] border border-haze dark:border-white/10
                   flex items-center justify-center flex-shrink-0 shadow-sm self-start"
          >
            <Sparkles :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>

          <!-- Content column: full-width inside the row, minus the avatar -->
          <div class="flex-1 min-w-0">
            <span
              :class="[
                'font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-semibold mb-2 opacity-60 group-hover:opacity-100 transition-opacity block',
                msg.role === 'user' ? 'text-right' : 'text-left',
              ]"
            >
              {{ msg.role === 'user' ? 'You' : 'HavenBot' }}
            </span>
            <div
              :class="cn(
                'relative font-sans text-base leading-relaxed w-full rounded-2xl',
                msg.role === 'user'
                  ? 'bg-midnight dark:bg-[#171717] text-white border border-transparent dark:border-white/5 rounded-tr-sm text-right shadow-xl px-4 py-3.5'
                  : 'overflow-hidden bg-mist/40 dark:bg-[#0d0e10] text-midnight dark:text-white border border-haze dark:border-white/5 rounded-tl-sm shadow-2xl pl-5 pr-4 py-3.5',
              )"
            >
              <span
                v-if="msg.role === 'agent'"
                aria-hidden="true"
                class="absolute top-0 bottom-0 left-0 w-1.5 bg-gold dark:bg-signal"
              />
              <p>{{ msg.text }}</p>
            </div>

            <!-- Recommended Actions card (always ActionCard, normalized in
                 the agent store). Only the latest agent reply shows it so
                 stale recommendations don't pile up in the scroll. -->
            <div
              v-if="msg.role === 'agent'
                && msg.id === latestAgentMessageId
                && msg.cardData"
              class="mt-6 text-left"
            >
              <ActionCard
                :title="(msg.cardData.title as string)"
                :description="(msg.cardData.description as string)"
                :actions="(msg.cardData.actions as any[])"
                @action="handleAction"
              />
            </div>
          </div>

          <!-- User avatar (right) -->
          <div
            v-if="msg.role === 'user'"
            class="w-10 h-10 rounded-full bg-gold/15 dark:bg-signal/15 border border-gold/30 dark:border-signal/30
                   flex items-center justify-center flex-shrink-0 self-start"
          >
            <User :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>
        </div>

        <!-- Typing indicator — "Sealed Channel" loading state.
             Four coordinated motions: avatar ring breathe + bubble
             ring pulse + left-bar vertical shimmer + dot pulse-and-
             glow. Eyebrow label matches the settled-message labels so
             the indicator feels like a first-class HavenBot moment.
             Wrapper carries role/aria-live so screen readers announce
             the wait politely. Reduced-motion freezes animations to a
             visible mid-state via global.css. -->
        <div
          v-if="agentStore.isTyping"
          role="status"
          aria-live="polite"
          aria-label="HavenBot is thinking"
          class="flex justify-start gap-6 w-full"
        >
          <div
            class="w-10 h-10 rounded-xl bg-mist dark:bg-[#171717]
                   border border-haze dark:border-white/10
                   flex items-center justify-center flex-shrink-0
                   havenbot-avatar-breathe"
          >
            <Sparkles :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>
          <div class="flex-1 min-w-0">
            <span
              class="font-sans text-[10px] uppercase tracking-[0.22em] font-semibold
                     mb-2 block"
            >
              <span class="text-cool">HavenBot</span>
              <span class="text-cool/40 mx-1">·</span>
              <span class="text-gold dark:text-signal">Thinking</span>
            </span>
            <div
              class="relative overflow-hidden bg-mist/40 dark:bg-[#0d0e10]
                     border border-haze dark:border-white/5 rounded-2xl rounded-tl-sm
                     py-3.5 pl-6 pr-5 inline-flex items-center gap-2.5 shadow-2xl
                     havenbot-bubble-pulse"
            >
              <span
                aria-hidden="true"
                class="absolute top-0 bottom-0 left-0 w-[3px] havenbot-shimmer-vert dark:opacity-90"
              />
              <span
                class="w-2 h-2 bg-gold dark:bg-signal rounded-full
                       havenbot-dot-pulse shadow-[0_0_8px_currentColor]"
                style="animation-delay: 0ms"
              />
              <span
                class="w-2 h-2 bg-gold dark:bg-signal rounded-full
                       havenbot-dot-pulse shadow-[0_0_8px_currentColor]"
                style="animation-delay: 200ms"
              />
              <span
                class="w-2 h-2 bg-gold dark:bg-signal rounded-full
                       havenbot-dot-pulse shadow-[0_0_8px_currentColor]"
                style="animation-delay: 400ms"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Input bar pinned below the chat (spans the chat column width) -->
      <div class="pt-4 relative shrink-0">
        <div
          :class="cn(
            'flex items-center gap-2 p-2 rounded-2xl border transition-all duration-300',
            'bg-white/85 dark:bg-[#1c1b1b]/75 backdrop-blur-2xl',
            'shadow-[0_18px_48px_-16px_rgba(63,46,12,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.6)]',
            'border-haze dark:border-white/10',
            'border-b-gold/30 dark:border-b-signal/30 border-r-gold/30 dark:border-r-signal/30',
            inputFocused ? 'ring-2 ring-gold/20 dark:ring-signal/20' : '',
          )"
        >
          <label for="agent-chat-input" class="sr-only">Ask the MuHaven agent</label>
          <input
            id="agent-chat-input"
            v-model="input"
            @keydown="handleKeydown"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
            type="text"
            placeholder="Ask about your portfolio, yields, or compliance…"
            aria-label="Ask the MuHaven agent"
            data-testid="agent-chat-input"
            class="flex-1 bg-transparent px-3 py-3 font-sans text-sm text-midnight dark:text-white
                   placeholder:text-cool focus:outline-none min-w-0"
          />
          <button
            type="button"
            @click="sendMessage()"
            :disabled="!input.trim()"
            aria-label="Send message"
            data-testid="agent-send-cta"
            class="btn-gold-sweep w-11 h-11 rounded-xl flex items-center justify-center cursor-pointer
                   transition-transform duration-200 hover:scale-105 active:scale-95 shrink-0"
          >
            <Send :size="15" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <div
          class="absolute -top-1.5 right-6 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full
                 bg-white dark:bg-[#1c1b1b]
                 border border-haze dark:border-white/10
                 font-sans text-[9px] uppercase tracking-[0.22em] text-cool font-semibold shadow-sm"
        >
          <ShieldCheck :size="10" :stroke-width="1.8" class="text-compute dark:text-signal" />
          <span>CoFHE Secure</span>
        </div>
      </div>
    </div>

    <!-- ── RIGHT: Suggested Actions aside (Deposit pattern).
         <xl: stacked below the chat column inline.
         xl+: teleported to <body>, fixed-right, viewport-relative. ── -->
    <Teleport to="body" :disabled="!isXl">
      <aside
        class="mt-10 xl:mt-0 flex flex-col gap-5 w-full
               xl:fixed xl:right-0 xl:top-0 xl:bottom-0 xl:w-80 xl:z-30
               xl:overflow-y-auto xl:px-7 xl:pt-10 xl:pb-10"
      >
        <div class="flex items-center gap-2">
          <Lightbulb :size="14" :stroke-width="1.8" class="text-compute dark:text-signal flex-shrink-0" />
          <h2 class="font-sans text-[10px] uppercase tracking-[0.22em] text-cool font-bold">
            Suggested Actions
          </h2>
        </div>
        <div
          class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-4
                 xl:overflow-y-auto xl:pr-1 xl:no-scrollbar"
        >
          <button
            v-for="p in suggestedPrompts"
            :key="p.text"
            type="button"
            @click="sendMessage(p.text)"
            class="group flex flex-col gap-3 p-5 rounded-2xl text-left
                   border border-haze dark:border-white/5
                   bg-white dark:bg-[#171717]
                   shadow-[0_8px_24px_-12px_rgba(63,46,12,0.08)]
                   dark:shadow-[0_12px_32px_-16px_rgba(0,0,0,0.55)]
                   hover:bg-mist/60 dark:hover:bg-[#1f1e1e]
                   xl:hover:-translate-x-1
                   hover:-translate-y-0.5 xl:hover:translate-y-0
                   hover:shadow-[0_14px_40px_-14px_rgba(255,186,32,0.22)]
                   transition-all duration-300 cursor-pointer"
          >
            <div
              :class="[
                'w-10 h-10 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform shadow-inner',
                p.accent === 'gold'
                  ? 'bg-gold/10 dark:bg-signal/10 text-compute dark:text-signal'
                  : 'bg-positive/10 text-positive',
              ]"
            >
              <component :is="p.icon" :size="18" :stroke-width="1.8" />
            </div>
            <div>
              <h3 class="font-sans font-semibold text-midnight dark:text-white text-sm leading-tight">
                {{ p.text }}
              </h3>
              <p class="font-sans text-[10px] text-cool mt-1.5 leading-tight">
                {{ p.hint }}
              </p>
            </div>
          </button>
        </div>
      </aside>
    </Teleport>
  </div>
</template>
