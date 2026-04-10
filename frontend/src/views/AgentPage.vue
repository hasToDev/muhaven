<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { useAgentStore } from '@/stores/agent'
import { toast } from 'vue-sonner'
import { cn } from '@/lib/utils'
import MCard from '@/components/ui/MCard.vue'
import MGoldRule from '@/components/ui/MGoldRule.vue'
import MSkeleton from '@/components/ui/MSkeleton.vue'
import ActionCard from '@/components/agent/ActionCard.vue'
import DataCard from '@/components/agent/DataCard.vue'
import FormCard from '@/components/agent/FormCard.vue'
import StatusCard from '@/components/agent/StatusCard.vue'
import InsightCard from '@/components/agent/InsightCard.vue'
import { Sparkles, Send, Zap, PieChart, ArrowDown, Shield } from 'lucide-vue-next'

const store = useAppStore()
const agentStore = useAgentStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const inputFocused = ref(false)

const suggestedPrompts = [
  { text: 'Optimize my yield allocation', icon: Zap },
  { text: 'Show portfolio breakdown', icon: PieChart },
  { text: 'Deposit $5,000 USDC', icon: ArrowDown },
  { text: 'Check compliance status', icon: Shield },
]

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

function handleAction(label: string) {
  toast.success(`Action: ${label}`, { description: 'Transaction would be submitted here' })
}

function handleSuggest(text: string) {
  sendMessage(text)
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
})
</script>

<template>
  <div>
  <!-- Skeleton -->
  <div v-if="store.isLoading" class="flex flex-col h-[calc(100vh-10rem)]">
    <div class="mb-6">
      <MSkeleton variant="title" width="240px" />
      <MSkeleton width="300px" height="16px" class="mt-3" />
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <MSkeleton variant="card" v-for="i in 4" :key="i" height="56px" />
    </div>
  </div>

  <!-- Content -->
  <div v-else class="flex flex-col h-[calc(100vh-10rem)]">
    <!-- Header -->
    <div
      class="mb-6"
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visible-once="{ opacity: 1, y: 0, transition: { duration: 500 } }"
    >
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-compute/12 flex items-center justify-center">
          <Sparkles :size="20" class="text-compute" />
        </div>
        <div>
          <h1 class="text-4xl font-sans font-bold text-midnight dark:text-white tracking-tight">MuHaven Agent</h1>
          <p class="text-sm text-cool mt-0.5">AI-powered portfolio management on encrypted data</p>
        </div>
      </div>
      <MGoldRule />
    </div>

    <!-- Chat area -->
    <div ref="messagesEl" class="flex-1 overflow-y-auto space-y-4 pb-4 max-w-5xl w-full mx-auto no-scrollbar">
      <!-- Suggested prompts -->
      <div v-if="agentStore.messages.length <= 1" class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <MCard
          v-for="(p, i) in suggestedPrompts"
          :key="i"
          hover
          glow
          padding="sm"
          @click="sendMessage(p.text)"
          v-motion
          :initial="{ opacity: 0, y: 12 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 300, delay: i * 80 } }"
        >
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-compute/12 flex items-center justify-center transition-transform duration-300 group-hover:rotate-12">
              <component :is="p.icon" :size="16" class="text-compute" />
            </div>
            <span class="text-base font-sans text-midnight dark:text-white">{{ p.text }}</span>
          </div>
        </MCard>
      </div>

      <!-- Messages -->
      <div
        v-for="(msg, mi) in agentStore.messages"
        :key="msg.id"
        v-motion
        :initial="{ opacity: 0, scale: 0.95, y: 8 }"
        :enter="{ opacity: 1, scale: 1, y: 0, transition: { duration: 300 } }"
        :class="msg.role === 'user' ? 'flex justify-end' : 'flex justify-start gap-2.5'"
      >
        <!-- Agent avatar -->
        <div v-if="msg.role === 'agent'" class="w-7 h-7 rounded-full bg-compute/12 flex items-center justify-center shrink-0 mt-1">
          <Sparkles :size="12" class="text-compute" />
        </div>

        <div
          :class="cn(
            'max-w-[80%] rounded-2xl px-4 py-3 text-sm font-sans leading-relaxed',
            msg.role === 'user'
              ? 'bg-midnight text-white rounded-br-sm'
              : 'bg-mist dark:bg-midnight-mid text-midnight dark:text-white rounded-bl-sm',
          )"
        >
          <div v-if="msg.role === 'agent'" class="text-[10px] uppercase tracking-wider text-compute font-medium font-mono mb-1.5">
            Agent
          </div>
          <p>{{ msg.text }}</p>

          <template v-if="msg.cardType && msg.cardData">
            <ActionCard
              v-if="msg.cardType === 'action'"
              :title="(msg.cardData.title as string)"
              :description="(msg.cardData.description as string)"
              :actions="(msg.cardData.actions as any[])"
              @action="handleAction"
            />
            <DataCard
              v-else-if="msg.cardType === 'data'"
              :title="(msg.cardData.title as string)"
            />
            <FormCard
              v-else-if="msg.cardType === 'form'"
              :type="(msg.cardData.type as 'deposit' | 'withdraw')"
              @submit="(amt: string) => toast.success(`${msg.cardData!.type} of $${amt}`)"
            />
            <StatusCard
              v-else-if="msg.cardType === 'status'"
              :status="(msg.cardData.status as any)"
              :description="(msg.cardData.description as string)"
            />
            <InsightCard
              v-else-if="msg.cardType === 'insight'"
              :title="(msg.cardData.title as string)"
              :body="(msg.cardData.body as string)"
              :suggestions="(msg.cardData.suggestions as string[])"
              @suggest="handleSuggest"
            />
          </template>
        </div>
      </div>

      <!-- Typing indicator -->
      <div v-if="agentStore.isTyping" class="flex justify-start gap-2.5">
        <div class="w-7 h-7 rounded-full bg-compute/12 flex items-center justify-center shrink-0">
          <Sparkles :size="12" class="text-compute" />
        </div>
        <div class="flex items-center gap-1.5 bg-mist dark:bg-midnight-mid rounded-2xl rounded-bl-sm px-4 py-3">
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 0ms" />
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 150ms" />
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 300ms" />
        </div>
      </div>
    </div>

    <!-- Input area -->
    <div class="max-w-5xl w-full mx-auto pt-4 border-t border-haze/50 dark:border-white/8">
      <div
        :class="cn(
          'flex items-center gap-3 rounded-xl border transition-all duration-200',
          inputFocused
            ? 'border-compute ring-2 ring-compute/20 bg-white dark:bg-midnight'
            : 'border-haze dark:border-white/10 bg-mist dark:bg-midnight',
        )"
      >
        <input
          v-model="input"
          @keydown="handleKeydown"
          @focus="inputFocused = true"
          @blur="inputFocused = false"
          type="text"
          placeholder="Ask about your portfolio, yields, or compliance..."
          class="flex-1 bg-transparent px-4 py-3 text-sm font-sans text-midnight dark:text-white placeholder:text-cool focus:outline-none"
        />
        <button
          @click="sendMessage()"
          :disabled="!input.trim()"
          class="mr-1.5 p-2.5 bg-midnight dark:bg-signal text-white dark:text-midnight rounded-lg hover:bg-compute dark:hover:bg-signal-hover disabled:opacity-40 transition-all cursor-pointer disabled:cursor-not-allowed"
        >
          <Send :size="16" />
        </button>
      </div>
    </div>
  </div>
  </div>
</template>
