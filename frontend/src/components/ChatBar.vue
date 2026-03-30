<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { COLORS, INITIAL_MESSAGES } from '@/data/constants'
import Icon from './Icon.vue'

const expanded = ref(false)
const messages = ref([...INITIAL_MESSAGES])
const input = ref('')
const messagesEndRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

watch(expanded, (val) => {
  if (val) nextTick(() => inputRef.value?.focus())
})

watch(
  () => messages.value.length,
  () => nextTick(() => messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })),
)

function sendMessage() {
  if (!input.value.trim()) return
  messages.value.push({ id: Date.now(), role: 'user' as const, text: input.value })
  input.value = ''
  setTimeout(() => {
    const responses = [
      'I can help with that. Let me check your current allocation and available yield rates.',
      'Your treasury position is currently 70% of your portfolio at 4.8% APY. Would you like me to increase it?',
      "I've checked the current rates. Treasuries are yielding 4.8% and money market is at 5.2%. What adjustment would you like?",
    ]
    messages.value.push({
      id: Date.now() + 1,
      role: 'agent' as const,
      text: responses[Math.floor(Math.random() * responses.length)],
    })
  }, 1200)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <!-- Collapsed bar -->
  <div
    v-if="!expanded"
    @click="expanded = true"
    :style="{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '56px',
      background: COLORS.surface,
      borderTop: `1px solid ${COLORS.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: '0 28px',
      cursor: 'pointer',
      zIndex: 100,
      transition: 'box-shadow 0.2s',
      boxShadow: '0 -2px 12px rgba(0,0,0,0.04)',
    }"
    @mouseenter="($event.currentTarget as HTMLElement).style.boxShadow = '0 -4px 20px rgba(0,0,0,0.08)'"
    @mouseleave="($event.currentTarget as HTMLElement).style.boxShadow = '0 -2px 12px rgba(0,0,0,0.04)'"
  >
    <Icon name="sparkles" :size="18" :color="COLORS.teal" />
    <span :style="{ marginLeft: '12px', fontSize: '14px', color: COLORS.textTertiary, flex: 1 }">Ask MuHaven anything...</span>
    <Icon name="chevronUp" :size="18" :color="COLORS.textTertiary" />
  </div>

  <!-- Expanded chat -->
  <div
    v-else
    :style="{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '52vh',
      background: COLORS.surface,
      borderTop: `1px solid ${COLORS.border}`,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
      boxShadow: '0 -8px 32px rgba(0,0,0,0.1)',
      animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    }"
  >
    <!-- Chat header -->
    <div :style="{ display: 'flex', alignItems: 'center', padding: '14px 24px', borderBottom: `1px solid ${COLORS.borderSubtle}` }">
      <Icon name="sparkles" :size="18" :color="COLORS.teal" />
      <span :style="{ marginLeft: '10px', fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, flex: 1 }">MuHaven Agent</span>
      <button
        @click="expanded = false"
        :style="{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '6px' }"
      >
        <Icon name="chevronDown" :size="18" :color="COLORS.textTertiary" />
      </button>
    </div>

    <!-- Messages -->
    <div :style="{ flex: 1, overflow: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }">
      <div v-for="m in messages" :key="m.id" :style="{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }">
        <div
          :style="{
            maxWidth: '75%',
            padding: '12px 18px',
            borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
            background: m.role === 'user' ? COLORS.tealLight : COLORS.bgSecondary,
            color: COLORS.textPrimary,
            fontSize: '14px',
            lineHeight: 1.6,
          }"
        >
          <div
            v-if="m.role === 'agent'"
            :style="{ fontSize: '11px', fontWeight: 600, color: COLORS.teal, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }"
          >
            Agent
          </div>
          {{ m.text }}
        </div>
      </div>
      <div ref="messagesEndRef" />
    </div>

    <!-- Input -->
    <div :style="{ padding: '16px 24px', borderTop: `1px solid ${COLORS.borderSubtle}`, display: 'flex', gap: '10px' }">
      <input
        ref="inputRef"
        v-model="input"
        @keydown="onKeyDown"
        placeholder="Type a message..."
        :style="{
          flex: 1,
          padding: '12px 16px',
          fontSize: '14px',
          border: `1.5px solid ${COLORS.border}`,
          borderRadius: '10px',
          outline: 'none',
          background: COLORS.bgPrimary,
          color: COLORS.textPrimary,
        }"
        @focus="($event.target as HTMLElement).style.borderColor = COLORS.teal"
        @blur="($event.target as HTMLElement).style.borderColor = COLORS.border"
      />
      <button
        @click="sendMessage"
        :style="{
          padding: '12px 16px',
          background: COLORS.teal,
          border: 'none',
          borderRadius: '10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }"
      >
        <Icon name="send" :size="16" color="#fff" />
      </button>
    </div>
  </div>
</template>
