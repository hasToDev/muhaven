<script setup lang="ts">
import { Lightbulb, ArrowRight } from 'lucide-vue-next'

defineProps<{
  title: string
  description: string
  actions: Array<{ label: string; variant: 'primary' | 'secondary' | 'ghost' }>
}>()

const emit = defineEmits<{
  action: [label: string]
}>()
</script>

<template>
  <div
    class="bg-white dark:bg-[#1c1b1b] rounded-2xl border border-haze dark:border-white/10
           overflow-hidden shadow-2xl w-full"
  >
    <!-- Bold gradient top accent bar (deep amber → bright gold → cream — all warm) -->
    <div
      aria-hidden="true"
      class="h-1.5 w-full bg-gradient-to-r from-compute via-gold to-signal opacity-70"
    />

    <div class="p-6 md:p-7">
      <!-- Icon + title header -->
      <div class="flex items-center gap-3 mb-2">
        <div
          class="w-9 h-9 rounded-xl bg-gold/10 dark:bg-signal/10
                 border border-gold/25 dark:border-signal/25
                 flex items-center justify-center flex-shrink-0"
        >
          <Lightbulb :size="16" :stroke-width="1.8" class="text-compute dark:text-signal" />
        </div>
        <h4 class="font-sans font-semibold text-lg text-midnight dark:text-white tracking-tight">
          {{ title }}
        </h4>
      </div>

      <!-- Description -->
      <p class="font-sans text-sm text-cool leading-relaxed mb-5 md:mb-6">
        {{ description }}
      </p>

      <!-- Action button grid (3 cols on md+, sliding arrow on hover) -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          v-for="a in actions"
          :key="a.label"
          type="button"
          @click="emit('action', a.label)"
          class="group/btn flex items-center justify-between gap-3
                 bg-white dark:bg-[#1f1e1e]
                 border border-haze dark:border-white/10
                 hover:border-gold/45 dark:hover:border-signal/40
                 hover:bg-mist/40 dark:hover:bg-[#252323]
                 text-midnight dark:text-white text-sm font-sans font-medium
                 py-4 px-5 rounded-xl shadow-sm
                 transition-all duration-200 cursor-pointer text-left"
        >
          <span class="leading-snug">{{ a.label }}</span>
          <ArrowRight
            :size="16"
            :stroke-width="2"
            aria-hidden="true"
            class="text-compute dark:text-signal flex-shrink-0
                   group-hover/btn:translate-x-1 transition-transform duration-200"
          />
        </button>
      </div>
    </div>
  </div>
</template>
