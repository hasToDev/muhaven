<script setup lang="ts">
import { cn } from '@/lib/utils'

defineProps<{
  hover?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  glow?: boolean
}>()
</script>

<template>
  <div
    :class="cn(
      'bg-white dark:bg-midnight-mid ring-1 ring-haze/30 dark:ring-white/6 rounded-xl shadow-lg shadow-compute/5 transition-all duration-300',
      hover && 'hover:-translate-y-1.5 hover:shadow-xl hover:shadow-compute/10 hover:ring-compute/20 cursor-pointer group',
      glow && 'hover:ring-compute/25',
      padding === 'none' ? ''
        : padding === 'sm' ? 'p-5'
        : padding === 'lg' ? 'p-8'
        : 'p-6',
      $attrs.class as string,
    )"
  >
    <slot />
  </div>
</template>
