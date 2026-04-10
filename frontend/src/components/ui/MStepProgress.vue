<script setup lang="ts">
import { Check } from 'lucide-vue-next'

defineProps<{
  steps: Array<{ label: string; description?: string }>
  currentStep: number
}>()
</script>

<template>
  <div class="flex items-center gap-0 w-full">
    <template v-for="(step, i) in steps" :key="i">
      <div class="flex flex-col items-center gap-1.5 relative">
        <div
          :class="[
            'w-8 h-8 rounded-full flex items-center justify-center text-xs font-sans font-medium transition-all duration-300',
            i < currentStep
              ? 'bg-compute text-white'
              : i === currentStep
                ? 'border-2 border-compute bg-mist text-compute'
                : 'bg-mist text-cool dark:bg-midnight dark:text-cool border border-haze dark:border-white/10',
          ]"
        >
          <Check v-if="i < currentStep" :size="14" :stroke-width="2.5" />
          <span v-else>{{ i + 1 }}</span>
        </div>
        <span
          :class="[
            'text-xs font-sans whitespace-nowrap absolute -bottom-6',
            i <= currentStep ? 'text-midnight dark:text-white font-medium' : 'text-cool',
          ]"
        >
          {{ step.label }}
        </span>
      </div>

      <div
        v-if="i < steps.length - 1"
        :class="[
          'flex-1 h-px mx-2 transition-colors duration-300',
          i < currentStep ? 'bg-compute' : 'bg-haze dark:bg-white/10',
        ]"
      />
    </template>
  </div>
</template>
