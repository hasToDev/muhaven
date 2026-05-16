import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  agentApi,
  type ActionDescriptor,
  type AgentHistoryMessage,
  type AgentCardType,
} from '@/services/api'
import { useAgentChat } from '@/composables/useAgentChat'
import { findStableBoundary, clearMarkdownCache } from '@/lib/markdown'

/**
 * Wave 4 P2 — agent chat store.
 *
 * Wraps `useAgentChat` so the SSE stream + pending ActionDescriptors
 * are available to the dashboard UI through Pinia. The legacy
 * `/agent/chat` keyword stub stays as the no-stream fallback for
 * environments where the streaming endpoint isn't reachable (tests,
 * pre-deploy probe, network failures).
 */
export interface AgentMessage {
  id: number
  role: 'user' | 'agent'
  text: string
  cardType?: AgentCardType
  cardData?: Record<string, unknown>
  timestamp: Date
  /** ActionDescriptors emitted by the LLM tool loop on this turn. */
  actions?: ActionDescriptor[]
}

const MAX_HISTORY = 10

let nextId = 1

const FALLBACK_RECOMMENDED_ACTIONS = {
  title: 'Recommended Actions',
  description: 'Pick one to keep exploring — the agent will respond based on your choice.',
  actions: [
    { label: 'Show portfolio breakdown', variant: 'primary' as const },
    { label: 'Optimize my yield allocation', variant: 'secondary' as const },
    { label: 'Explain the trade-offs', variant: 'ghost' as const },
  ],
}

export const useAgentStore = defineStore('agent', () => {
  const chat = useAgentChat()
  const messages = ref<AgentMessage[]>([])
  const pendingPrompt = ref('')
  const useStreaming = ref(true)

  // Live-stream the streamingText into the latest in-progress agent
  // message so the existing AgentPage.vue render path picks it up
  // without changing the template (msg.text reactivity wins).
  //
  // CR-1 (round-1 Thread-10 review): exposed as a `ref` (was a `let`
  // local) so AgentPage's `renderedMessages` computed can key its
  // inflight-vs-settled branch off the EXACT lifecycle window. The
  // race the change closes: `chat.isStreaming` flips false inside
  // `chat.send()`'s `finally` BEFORE `agentMessage.text = finalText`
  // runs at line 119 below. Vue's scheduler can flush in that
  // microtask gap; if `renderedMessages` keys off `isStreaming`, it
  // sees `isStreaming=false` + a stale partial `msg.text` that may
  // still contain an unclosed code fence → settled-branch routes the
  // mid-fence text through `renderMarkdownSafe` → exactly the
  // `<pre>` snap-back the streaming split is meant to eliminate, for
  // one tick. Keying off `inflightAgentMessageId` instead (which we
  // clear AFTER `agentMessage.text = finalText` lands) closes the
  // window: the inflight branch stays in force until the SETTLED
  // text replaces the partial.
  const inflightAgentMessageId = ref<number | null>(null)
  watch(
    () => chat.streamingText.value,
    (text) => {
      if (inflightAgentMessageId.value === null) return
      const msg = messages.value.find((m) => m.id === inflightAgentMessageId.value)
      if (msg) msg.text = text
    },
  )

  /**
   * Auth-boundary teardown — wipes the visible chat surface AND the
   * underlying composable's internal refs (pending actions, in-flight
   * stream text, last error, telegram-link prefetch) so a subsequent
   * login as a different smart account starts with a blank slate.
   * Surfaced 2026-05-22: operator observed chat history persisting
   * across issuer↔investor passkey switches because this store
   * wasn't wired into `useAuth.tearDownUserStores`. Now it is.
   */
  function reset(): void {
    chat.reset()
    messages.value = []
    pendingPrompt.value = ''
    inflightAgentMessageId.value = null
    nextId = 1
    useStreaming.value = true
    // SE L-1 (Thread-10 review): drop the module-level markdown render
    // cache on auth-boundary teardown. The cache stores HTML keyed by
    // markdown text — output is a pure function of input, so no PII
    // can leak across the boundary today. But the
    // `feedback_auth_boundary_teardown` invariant ("every user-scoped
    // state clears on switch") is worth honoring explicitly: a future
    // change that adds per-user customisation to the render path
    // (e.g. locale-aware anchor `aria-label`) would otherwise quietly
    // serve User A's renders to User B until 64 evictions later.
    clearMarkdownCache()
  }

  async function sendMessage(text: string): Promise<void> {
    const history: AgentHistoryMessage[] = messages.value
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, text: m.text }))

    messages.value.push({
      id: nextId++,
      role: 'user',
      text,
      timestamp: new Date(),
    })

    // Push a plain object then re-fetch the reactive proxy by id. Vue 3's
    // ref<Array<Object>> wraps each pushed element with a Proxy, but the
    // local `agentMessage` reference returned from a literal still points
    // at the plain object — mutations on it BYPASS the Proxy's set trap,
    // so the post-stream `agentMessage.text = finalText` etc. would NOT
    // trigger a re-render until some unrelated event flushed Vue's
    // scheduler (caught 2026-05-09 — operator saw ActionCard mount only
    // after clicking the SSE response in the network tab).
    const agentMessageId = nextId++
    messages.value.push({
      id: agentMessageId,
      role: 'agent',
      text: '',
      timestamp: new Date(),
    })
    const agentMessage = messages.value.find((m) => m.id === agentMessageId)!

    if (useStreaming.value) {
      inflightAgentMessageId.value = agentMessage.id
      try {
        const { text: finalText, actions, toolsCalled, suggestions } = await chat.send({
          message: text,
          history,
        })
        agentMessage.text = finalText
        agentMessage.actions = actions
        // Only fire the "I'm not sure how to help" fallback when the turn
        // produced literally nothing — no synthesised text, no actions,
        // and no successful tool dispatch. Read tools (portfolio_summary
        // on an empty wallet, audit_query with zero hits) trip toolsCalled
        // > 0 even when the LLM emits no closing text; in that case the
        // backend already streamed a result-aware sentence.
        if (!agentMessage.text && actions.length === 0 && toolsCalled === 0) {
          agentMessage.text =
            "I'm not sure how to help with that yet. Try asking about your portfolio, yields, or a buy."
        }
        if (actions.length === 0) {
          // Use backend-emitted context-aware suggestions when present
          // (e.g. fresh wallet → "Wrap mhUSDC", successful quote →
          // "Buy N TBILL1"). Fall back to static chips only when the
          // backend didn't send any (legacy / non-Gemini path).
          agentMessage.cardType = 'action'
          agentMessage.cardData =
            suggestions.length > 0
              ? {
                  title: 'Recommended Actions',
                  description:
                    'Pick one to keep exploring — the agent will respond based on your choice.',
                  actions: suggestions,
                }
              : FALLBACK_RECOMMENDED_ACTIONS
        }
        return
      } catch (err) {
        // Round-2 review CR-H2: detect AbortError and short-circuit
        // BEFORE the legacy-keyword fallback. The fallback path
        // (agentApi.chat at line 168) carries the user's prompt + the
        // CURRENT JWT — if `chat.abort()` fired because of an auth
        // boundary teardown (logout/silent-expiry/relogin-as-other-user),
        // the fallback would send the OLD user's prompt under the
        // NEW user's JWT, server-side recording it as the new user's
        // chat history. Closes that cross-user leak class.
        //
        // AbortError is the standard DOMException name for
        // controller.abort(); fetch + readable streams both throw it.
        // The check covers Error.name === 'AbortError' (modern fetch)
        // AND the legacy `err.code === 20` shape (older spec).
        const isAbort =
          err instanceof Error
          && (err.name === 'AbortError' || (err as { code?: number }).code === 20)
        if (isAbort) {
          // CR-2 (Thread-10 round-1 review): truncate the partial msg.text
          // to the last STABLE boundary before clearing the inflight slot.
          // Otherwise an aborted stream that stopped mid-fence leaves the
          // unclosed `\`\`\`` in msg.text; the next render routes through
          // the settled branch which calls `renderMarkdownSafe` on the
          // partial → marked treats the unclosed fence as code-to-EOI →
          // user sees `<pre>` containing any trailing prose, the exact
          // snap-back this PR is meant to eliminate. Truncation preserves
          // every CLOSED paragraph and drops only the in-flight tail.
          if (agentMessage.text) {
            const boundary = findStableBoundary(agentMessage.text)
            agentMessage.text = agentMessage.text.slice(0, boundary)
          }
          inflightAgentMessageId.value = null
          // The orphan agentMessage already-empty text is harmless —
          // the bus reset/teardown that triggered the abort also
          // typically clears `messages`, so the stub never renders.
          // If somehow it survives (race with non-teardown abort),
          // the empty text is a no-op visually.
          return
        }
        // Non-abort stream failure — surface + fall back to legacy
        // keyword endpoint so the user still sees something. The
        // composable already set `chat.lastError` for surfacing. Same
        // truncation rationale as above: an error mid-fence shouldn't
        // leave the unclosed fence baked into msg.text once we route
        // through the settled-render branch. The fallback-error sentence
        // we ASSIGN below replaces the partial text outright, so this is
        // belt-and-suspenders rather than load-bearing — but it keeps the
        // invariant tight in case future error-handling code paths read
        // `agentMessage.text` before overwriting it.
        agentMessage.text = `Streaming error — using fallback. ${
          err instanceof Error ? err.message : ''
        }`.trim()
        useStreaming.value = false
      } finally {
        inflightAgentMessageId.value = null
      }
    }

    // Legacy keyword stub — only reached on streaming failure.
    try {
      const result = await agentApi.chat({ message: text, history })
      agentMessage.text = result.response.text
      agentMessage.cardType = result.response.card_type ?? 'action'
      agentMessage.cardData = (result.response.card_data as Record<string, unknown>) ?? FALLBACK_RECOMMENDED_ACTIONS
    } catch (err) {
      agentMessage.text =
        err instanceof Error
          ? `Sorry, I encountered an error: ${err.message}. Please try again.`
          : 'Sorry, something went wrong. Please try again.'
    }
  }

  function consumePendingAction(toolCallId: string): ActionDescriptor | null {
    return chat.consumePendingAction(toolCallId)
  }

  /** Q4 Part B (2026-05-15) — drain the prefetched Telegram-link
   *  payload from the agent stream so AgentPage's modal lifecycle
   *  owns the close. */
  function consumePendingTelegramLink() {
    return chat.consumePendingTelegramLink()
  }

  function openWithPrompt(prompt: string): void {
    pendingPrompt.value = prompt
  }

  function consumePrompt(): string {
    const p = pendingPrompt.value
    pendingPrompt.value = ''
    return p
  }

  return {
    messages,
    isTyping: chat.isStreaming,
    /**
     * id of the currently-streaming agent message, or `null` when no
     * stream is in flight. Cleared AFTER `agentMessage.text = finalText`
     * lands so consumers (AgentPage's `renderedMessages` computed)
     * can use it as a tight inflight predicate without racing
     * `isTyping` (which flips earlier — see CR-1 in DEV_LOG).
     */
    inflightAgentMessageId,
    streamingText: chat.streamingText,
    pendingActions: chat.pendingActions,
    pendingTelegramLink: chat.pendingTelegramLink,
    lastError: chat.lastError,
    pendingPrompt,
    consumePendingAction,
    consumePendingTelegramLink,
    sendMessage,
    openWithPrompt,
    consumePrompt,
    reset,
  }
})
