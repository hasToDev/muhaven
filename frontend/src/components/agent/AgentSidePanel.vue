<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAgentStore } from '@/stores/agent'
import { Sparkles, X, Send, ArrowUpRight } from 'lucide-vue-next'

const router = useRouter()
const appStore = useAppStore()
const agentStore = useAgentStore()

const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

function sendMessage() {
  const text = input.value.trim()
  if (!text) return
  agentStore.sendMessage(text)
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

function goFullChat() {
  appStore.closeAgentPanel()
  router.push('/agent')
}

watch(() => agentStore.messages.length, scrollToBottom)

watch(() => appStore.agentPanelOpen, (open) => {
  if (open) {
    const prompt = agentStore.consumePrompt()
    if (prompt) {
      input.value = prompt
    }
    scrollToBottom()
  }
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <!-- Backdrop -->
  <Transition name="fade">
    <div
      v-if="appStore.agentPanelOpen"
      class="fixed inset-0 bg-midnight/20 backdrop-blur-sm z-40"
      @click="appStore.closeAgentPanel()"
    />
  </Transition>

  <!-- Panel -->
  <Transition name="slide-right">
    <div
      v-if="appStore.agentPanelOpen"
      class="fixed top-0 right-0 h-full w-full md:w-[400px] max-w-[90vw] z-50 flex flex-col bg-white dark:bg-midnight-mid shadow-elevated"
    >
      <!-- Header -->
      <div class="flex items-center gap-3 px-5 py-4 bg-midnight text-white">
        <Sparkles :size="18" class="text-signal" />
        <span class="font-sans font-bold text-lg flex-1">MuHaven Agent</span>
        <button
          @click="goFullChat()"
          class="flex items-center gap-1 text-xs text-signal hover:text-signal-hover transition-colors cursor-pointer"
        >
          Full chat <ArrowUpRight :size="12" />
        </button>
        <button
          @click="appStore.closeAgentPanel()"
          class="p-1 text-white/60 hover:text-white transition-colors cursor-pointer"
        >
          <X :size="18" />
        </button>
      </div>

      <!-- Messages -->
      <div ref="messagesEl" class="flex-1 overflow-y-auto p-5 space-y-4">
        <div
          v-for="msg in agentStore.messages"
          :key="msg.id"
          :class="[
            'max-w-[85%] rounded-2xl px-4 py-3 text-sm font-sans leading-relaxed',
            msg.role === 'user'
              ? 'ml-auto bg-midnight text-white rounded-br-sm'
              : 'mr-auto bg-mist dark:bg-midnight text-midnight dark:text-white rounded-bl-sm',
          ]"
        >
          <div v-if="msg.role === 'agent'" class="text-[10px] uppercase tracking-wider text-compute font-medium font-mono mb-1">
            Agent
          </div>
          {{ msg.text }}
        </div>

        <!-- Typing indicator -->
        <div v-if="agentStore.isTyping" class="flex items-center gap-1.5 mr-auto bg-mist dark:bg-midnight rounded-2xl rounded-bl-sm px-4 py-3">
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 0ms" />
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 150ms" />
          <span class="w-1.5 h-1.5 bg-compute rounded-full animate-bounce" style="animation-delay: 300ms" />
        </div>
      </div>

      <!-- Input -->
      <div class="p-4 border-t border-haze dark:border-white/8">
        <div class="flex items-center gap-2">
          <input
            v-model="input"
            @keydown="handleKeydown"
            type="text"
            placeholder="Ask something..."
            class="flex-1 bg-mist dark:bg-midnight border border-haze dark:border-white/10 rounded-xl px-4 py-2.5 text-sm font-sans text-midnight dark:text-white placeholder:text-cool focus:outline-none focus:border-compute focus:ring-2 focus:ring-compute/20 transition-colors"
          />
          <button
            @click="sendMessage"
            :disabled="!input.trim()"
            class="p-2.5 bg-midnight dark:bg-signal text-white dark:text-midnight rounded-xl hover:bg-compute dark:hover:bg-signal-hover disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <Send :size="16" />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
.slide-right-enter-active, .slide-right-leave-active {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.slide-right-enter-from, .slide-right-leave-to {
  transform: translateX(100%);
}
</style>
