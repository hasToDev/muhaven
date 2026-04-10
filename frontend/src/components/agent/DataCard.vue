<script setup lang="ts">
import MCard from '@/components/ui/MCard.vue'

defineProps<{
  title: string
}>()
</script>

<template>
  <MCard class="my-2">
    <p class="text-sm font-sans font-medium text-midnight dark:text-white mb-4">{{ title }}</p>
    <div class="h-32 bg-mist dark:bg-midnight rounded-xl flex items-center justify-center text-xs text-cool">
      <slot>
        <span class="opacity-50">Chart placeholder</span>
      </slot>
    </div>
  </MCard>
</template>
