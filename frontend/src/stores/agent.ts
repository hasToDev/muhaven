import { defineStore } from 'pinia'
import { ref, nextTick } from 'vue'

export interface AgentMessage {
  id: number
  role: 'user' | 'agent'
  text: string
  cardType?: 'action' | 'data' | 'form' | 'status' | 'insight'
  cardData?: Record<string, unknown>
  timestamp: Date
}

const MOCK_RESPONSES: AgentMessage[] = [
  {
    id: 0, role: 'agent', timestamp: new Date(),
    text: 'Your portfolio is well diversified. Treasury bonds (70%) provide stability while money market (20%) offers higher yield. Your cash buffer at 10% is healthy.',
    cardType: 'insight',
    cardData: {
      title: 'Portfolio Health',
      body: 'Allocation is within target ranges. Treasury yield is competitive at 4.8% APY.',
      suggestions: ['Optimize allocation', 'Show yield forecast'],
    },
  },
  {
    id: 0, role: 'agent', timestamp: new Date(),
    text: 'I can help rebalance your portfolio. Based on current rates, here\'s my recommendation:',
    cardType: 'action',
    cardData: {
      title: 'Suggested Rebalance',
      description: 'Move 5% from Cash Buffer to Money Market Fund for +0.3% portfolio APY',
      actions: [
        { label: 'Approve', variant: 'primary' },
        { label: 'Modify', variant: 'secondary' },
        { label: 'Reject', variant: 'ghost' },
      ],
    },
  },
  {
    id: 0, role: 'agent', timestamp: new Date(),
    text: 'Here\'s your yield summary for this quarter:',
    cardType: 'data',
    cardData: {
      title: 'Quarterly Yield',
      chartType: 'line',
    },
  },
  {
    id: 0, role: 'agent', timestamp: new Date(),
    text: 'I\'ve checked the current rates. Treasury bonds are yielding 4.8% and money market is at 5.2%. Would you like me to adjust your allocation?',
  },
  {
    id: 0, role: 'agent', timestamp: new Date(),
    text: 'Your next yield distribution is in approximately 3 days. You have $201.34 in pending claims across 2 tokens.',
    cardType: 'status',
    cardData: {
      status: 'pending',
      description: 'Yield distribution processing — estimated 3 days',
    },
  },
]

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

  function sendMessage(text: string) {
    messages.value.push({
      id: nextId++,
      role: 'user',
      text,
      timestamp: new Date(),
    })

    isTyping.value = true

    setTimeout(() => {
      const template = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)]
      messages.value.push({
        ...template,
        id: nextId++,
        timestamp: new Date(),
      })
      isTyping.value = false
    }, 1200 + Math.random() * 800)
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
