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

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<AgentMessage[]>([
    {
      id: 1,
      role: 'agent',
      text: 'Welcome back. Your portfolio is up 2.3% this month. Treasury bonds are performing well at 4.8% APY. How can I help you today?',
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
        cardType: result.response.card_type,
        cardData: result.response.card_data,
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
