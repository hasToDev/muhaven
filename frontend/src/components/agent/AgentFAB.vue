<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MessageCircle } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const isAgentPage = computed(() => route.path === '/agent')

// Operator request (2026-05-30): the FAB now navigates to the full Agent
// page rather than toggling the AgentSidePanel. The side panel is NOT
// removed — InsightChip still opens it via store.openAgentPanel(). Since
// the FAB always navigates (and is hidden on /agent via `isAgentPage`),
// there's no "close" state to represent, so the icon is a single
// MessageCircle (the prior X/MessageCircle toggle is gone).
function openAgent() {
  router.push('/agent')
}
</script>

<template>
  <Transition name="fab">
    <button
      v-if="!isAgentPage"
      @click="openAgent"
      aria-label="Open AI agent"
      :class="[
        'fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full flex items-center justify-center',
        'bg-gradient-to-br from-signal via-gold to-compute text-midnight',
        'shadow-fab hover:shadow-elevated hover:scale-105 hover:brightness-110',
        'transition-all duration-200 cursor-pointer',
      ]"
    >
      <MessageCircle :size="22" />
    </button>
  </Transition>
</template>

<style scoped>
.fab-enter-active, .fab-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}
.fab-enter-from, .fab-leave-to {
  transform: scale(0.5);
  opacity: 0;
}
</style>
