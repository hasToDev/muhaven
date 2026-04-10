<script setup lang="ts">
import { computed } from 'vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'

const props = defineProps<{
  value: number
  color?: string
  animated?: boolean
}>()

const { target, isVisible } = useScrollAnimation(0.2)

const barWidth = computed(() => {
  if (props.animated === false) return `${props.value}%`
  return isVisible.value ? `${props.value}%` : '0%'
})
</script>

<template>
  <div ref="target" class="h-2 bg-haze/40 dark:bg-white/8 rounded-full overflow-hidden">
    <div
      class="h-full rounded-full transition-all duration-1000 ease-out"
      :class="color || 'bg-compute'"
      :style="{ width: barWidth }"
    />
  </div>
</template>
