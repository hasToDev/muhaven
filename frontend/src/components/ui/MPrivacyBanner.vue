<script setup lang="ts">
import { Shield } from 'lucide-vue-next'

defineProps<{
  text: string
}>()
</script>

<template>
  <div class="flex items-center gap-4 bg-mist dark:bg-compute/8 rounded-xl p-4 border border-haze/50 dark:border-compute/20">
    <Shield :size="18" class="text-compute flex-shrink-0" />
    <p class="text-sm text-slate dark:text-cool leading-relaxed font-sans">{{ text }}</p>
  </div>
</template>
