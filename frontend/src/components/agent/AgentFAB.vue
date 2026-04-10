<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { MessageCircle, X } from 'lucide-vue-next'

const route = useRoute()
const store = useAppStore()

const isAgentPage = computed(() => route.path === '/agent')
</script>

<template>
  <Transition name="fab">
    <button
      v-if="!isAgentPage"
      @click="store.agentPanelOpen ? store.closeAgentPanel() : store.openAgentPanel()"
      :class="[
        'fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full flex items-center justify-center',
        'bg-midnight dark:bg-signal text-white dark:text-midnight shadow-fab hover:shadow-elevated hover:scale-105',
        'hover:bg-compute dark:hover:bg-signal-hover',
        'transition-all duration-200 cursor-pointer',
      ]"
    >
      <Transition name="icon-rotate" mode="out-in">
        <X v-if="store.agentPanelOpen" :size="22" key="close" />
        <MessageCircle v-else :size="22" key="chat" />
      </Transition>
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
.icon-rotate-enter-active, .icon-rotate-leave-active {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.icon-rotate-enter-from { opacity: 0; transform: rotate(-90deg); }
.icon-rotate-leave-to { opacity: 0; transform: rotate(90deg); }
</style>
