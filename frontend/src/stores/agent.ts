import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  agentApi,
  type ActionDescriptor,
  type AgentHistoryMessage,
  type AgentCardType,
} from '@/services/api'
import { useAgentChat } from '@/composables/useAgentChat'

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
  let inflightAgentMessageId: number | null = null
  watch(
    () => chat.streamingText.value,
    (text) => {
      if (inflightAgentMessageId === null) return
      const msg = messages.value.find((m) => m.id === inflightAgentMessageId)
      if (msg) msg.text = text
    },
  )

  function reset(): void {
    chat.abort()
    messages.value = []
    nextId = 1
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
      inflightAgentMessageId = agentMessage.id
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
        // Stream failed — fall back to the legacy keyword endpoint so
        // the user sees something. The composable already set
        // `chat.lastError` for surfacing.
        agentMessage.text = `Streaming error — using fallback. ${
          err instanceof Error ? err.message : ''
        }`.trim()
        useStreaming.value = false
      } finally {
        inflightAgentMessageId = null
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
