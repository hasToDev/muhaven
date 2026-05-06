<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useAgentStore } from '@/stores/agent'
import { cn } from '@/lib/utils'
import ActionCard from '@/components/agent/ActionCard.vue'
import ConfirmModal from '@/components/agent/ConfirmModal.vue'
import { runAgentAction } from '@/composables/useAgentActionRunner'
import type { ActionDescriptor } from '@/services/api'
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

async function onAuthorize(action: ActionDescriptor): Promise<void> {
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
}

function onConfirmComplete(payload: {
  action: ActionDescriptor
  ok: boolean
  txHash?: string | null
  error?: string
}): void {
  // Remove the action from the pending queue regardless of ok/fail —
  // the user has either authorized + (succeeded|failed) or cancelled.
  agentStore.consumePendingAction(payload.action.toolCallId)
  // Defer modal close until status="success" / "deferred" so the user
  // can see the receipt or follow-up CTA. The modal closes on Done tap.
  if (!payload.ok && payload.error !== 'deferred') {
    activeAction.value = null
    if (payload.error) {
      toast.error('Authorization failed', { description: payload.error })
    }
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
              Agent · System Initialization
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
          v-for="msg in agentStore.messages"
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
              {{ msg.role === 'user' ? 'User · Request' : 'Agent · Response' }}
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

        <!-- Typing indicator -->
        <div v-if="agentStore.isTyping" class="flex justify-start gap-6 w-full">
          <div class="w-10 h-10 rounded-xl bg-mist dark:bg-[#171717] border border-haze dark:border-white/10 flex items-center justify-center flex-shrink-0">
            <Sparkles :size="15" :stroke-width="1.8" class="text-compute dark:text-signal" />
          </div>
          <div
            class="relative overflow-hidden bg-mist/40 dark:bg-[#0d0e10]
                   border border-haze dark:border-white/5 rounded-2xl rounded-tl-sm
                   py-3 pl-5 pr-4 flex items-center gap-2 shadow-2xl"
          >
            <span aria-hidden="true" class="absolute top-0 bottom-0 left-0 w-1.5 bg-gold/60 dark:bg-signal/60" />
            <span class="w-1.5 h-1.5 bg-compute dark:bg-signal rounded-full animate-bounce" style="animation-delay: 0ms" />
            <span class="w-1.5 h-1.5 bg-compute dark:bg-signal rounded-full animate-bounce" style="animation-delay: 150ms" />
            <span class="w-1.5 h-1.5 bg-compute dark:bg-signal rounded-full animate-bounce" style="animation-delay: 300ms" />
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
