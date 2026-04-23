import { defineStore } from 'pinia'
import { ref } from 'vue'
import { agentApi, type AgentHistoryMessage, type AgentCardType } from '@/services/api'

export interface AgentMessage {
  id: number
  role: 'user' | 'agent'
  text: string
  cardType?: AgentCardType
  cardData?: Record<string, unknown>
  timestamp: Date
}

const MAX_HISTORY = 10

let nextId = 2

// Generic fallback used when the backend returns no card data — keeps the
// "Recommended Actions" panel consistent across every agent reply so users
// always have follow-up affordances.
const FALLBACK_RECOMMENDED_ACTIONS = {
  title: 'Recommended Actions',
  description: 'Pick one to keep exploring — the agent will respond based on your choice.',
  actions: [
    { label: 'Show portfolio breakdown', variant: 'primary' as const },
    { label: 'Optimize my yield allocation', variant: 'secondary' as const },
    { label: 'Explain the trade-offs', variant: 'ghost' as const },
  ],
}

// Always render an action-shaped card under every agent reply. If the backend
// already returned `card_type === 'action'` with the right shape, use it as-is.
// Otherwise (no card / different card type / malformed data), fall back so the
// in-chat Recommended Actions card stays visually consistent.
function normalizeAgentCard(
  cardType: AgentCardType | undefined,
  cardData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (
    cardType === 'action'
    && cardData
    && typeof cardData.title === 'string'
    && typeof cardData.description === 'string'
    && Array.isArray(cardData.actions)
    && cardData.actions.length > 0
  ) {
    return cardData
  }
  return FALLBACK_RECOMMENDED_ACTIONS
}

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<AgentMessage[]>([
    {
      id: 1,
      role: 'agent',
      text: 'Welcome back. Your portfolio is up 2.3% this month. Treasury bonds are performing well at 4.8% APY. How can I help you today?',
      cardType: 'action',
      cardData: {
        title: 'Recommended Actions',
        description: 'Based on your encrypted positions and current rate environment, here are three moves the agent recommends reviewing.',
        actions: [
          { label: 'Rebalance to 60% treasuries', variant: 'primary' },
          { label: 'Increase allocation to private credit', variant: 'secondary' },
          { label: 'Explain the trade-offs', variant: 'ghost' },
        ],
      },
      timestamp: new Date(),
    },
  ])

  const isTyping = ref(false)
  const pendingPrompt = ref('')

  function buildHistory(): AgentHistoryMessage[] {
    return messages.value
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, text: m.text }))
  }

  async function sendMessage(text: string) {
    // Build history BEFORE pushing the new message to avoid duplicating
    // the current message in both `message` and `history`
    const history = buildHistory()

    messages.value.push({
      id: nextId++,
      role: 'user',
      text,
      timestamp: new Date(),
    })

    isTyping.value = true

    try {
      const result = await agentApi.chat({
        message: text,
        history,
      })

      messages.value.push({
        id: nextId++,
        role: 'agent',
        text: result.response.text,
        cardType: 'action',
        cardData: normalizeAgentCard(result.response.card_type, result.response.card_data),
        timestamp: new Date(),
      })
    } catch (e) {
      messages.value.push({
        id: nextId++,
        role: 'agent',
        text: e instanceof Error
          ? `Sorry, I encountered an error: ${e.message}. Please try again.`
          : 'Sorry, something went wrong. Please try again.',
        timestamp: new Date(),
      })
    } finally {
      isTyping.value = false
    }
  }

  function openWithPrompt(prompt: string) {
    pendingPrompt.value = prompt
  }

  function consumePrompt(): string {
    const p = pendingPrompt.value
    pendingPrompt.value = ''
    return p
  }

  return { messages, isTyping, pendingPrompt, sendMessage, openWithPrompt, consumePrompt }
})
