<script setup lang="ts">
import { ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { useAgentStore } from '@/stores/agent'
import { Sparkles, X } from 'lucide-vue-next'
import { onClickOutside } from '@vueuse/core'

const props = defineProps<{
  text: string
  detail: string
  agentPrompt: string
}>()

const isOpen = ref(false)
const chipRef = ref<HTMLElement | null>(null)

const appStore = useAppStore()
const agentStore = useAgentStore()

function askAgent() {
  agentStore.openWithPrompt(props.agentPrompt)
  appStore.openAgentPanel()
  isOpen.value = false
}

onClickOutside(chipRef, () => { isOpen.value = false })
</script>

<template>
  <span ref="chipRef" class="relative inline-flex">
    <button
      @click="isOpen = !isOpen"
      class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-compute/12 text-compute text-[11px] font-sans font-medium rounded-full border border-compute/25 hover:bg-compute/20 transition-colors cursor-pointer"
    >
      <Sparkles :size="10" />
      {{ text }}
    </button>

    <Transition name="chip-expand">
      <div
        v-if="isOpen"
        class="absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-midnight-mid border border-haze dark:border-white/10 rounded-xl shadow-elevated p-5 z-30"
      >
        <div class="flex items-start justify-between gap-2 mb-2">
          <Sparkles :size="14" class="text-compute mt-0.5 flex-shrink-0" />
          <button @click="isOpen = false" class="text-cool hover:text-midnight dark:hover:text-white cursor-pointer">
            <X :size="12" />
          </button>
        </div>
        <p class="text-sm text-midnight dark:text-white leading-relaxed mb-3">{{ detail }}</p>
        <button
          @click="askAgent"
          class="text-xs text-compute font-medium hover:underline cursor-pointer"
        >
          Ask Agent &rarr;
        </button>
      </div>
    </Transition>
  </span>
</template>

<style scoped>
.chip-expand-enter-active, .chip-expand-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.chip-expand-enter-from, .chip-expand-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
