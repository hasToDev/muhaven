<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
}>()
</script>

<template>
  <button
    :disabled="disabled || loading"
    :class="cn(
      'inline-flex items-center justify-center font-sans font-medium transition-all duration-200 rounded-md cursor-pointer group',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      variant === 'danger'
        ? 'bg-negative text-white hover:bg-negative/90 active:scale-[0.98]'
        : variant === 'ghost'
          ? 'bg-transparent text-slate hover:text-midnight hover:bg-mist dark:hover:text-white dark:hover:bg-midnight-mid'
          : variant === 'secondary'
            ? 'bg-mist text-midnight border border-haze hover:bg-haze/30 dark:bg-midnight-mid dark:text-white dark:border-white/8 dark:hover:bg-midnight/70'
            : variant === 'outline'
              ? 'bg-transparent text-midnight border border-midnight/20 hover:border-compute hover:text-compute dark:text-white dark:border-white/20 dark:hover:border-signal dark:hover:text-signal'
              : 'bg-midnight text-white hover:bg-compute hover:scale-[1.02] active:scale-[0.98] hover:shadow-button dark:bg-signal dark:text-midnight dark:hover:bg-signal-hover',
      size === 'sm' ? 'text-xs px-3.5 py-2 gap-1.5'
        : size === 'lg' ? 'text-base px-7 py-3.5 gap-2.5'
        : 'text-sm px-5 py-2.5 gap-2',
      fullWidth ? 'w-full' : '',
      $attrs.class as string,
    )"
  >
    <Loader2 v-if="loading" :size="size === 'sm' ? 14 : 16" class="animate-spin" />
    <slot />
  </button>
</template>
