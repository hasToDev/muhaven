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
      'inline-flex items-center justify-center font-sans font-semibold transition-all duration-200 rounded-md cursor-pointer group',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      variant === 'danger'
        ? 'bg-negative text-white hover:bg-negative/90 active:scale-[0.98]'
        : variant === 'ghost'
          ? 'bg-transparent text-slate hover:text-compute hover:bg-mist/60 dark:text-[#d5c4ab] dark:hover:text-signal dark:hover:bg-midnight-mid'
          : variant === 'secondary'
            ? 'bg-mist text-slate border border-haze hover:bg-haze/40 hover:text-compute dark:bg-midnight-mid dark:text-[#e3e2e5] dark:border-[#343537] dark:hover:bg-[#343537]/80 dark:hover:text-signal'
            : variant === 'outline'
              ? 'bg-transparent text-slate border border-haze hover:border-compute hover:text-compute dark:text-[#e3e2e5] dark:border-[#514532]/60 dark:hover:border-signal dark:hover:text-signal'
              : 'bg-compute text-white hover:bg-compute-hover hover:-translate-y-0.5 active:scale-[0.98] shadow-[0_4px_14px_rgba(184,134,11,0.22)] hover:shadow-[0_8px_24px_rgba(184,134,11,0.32)] dark:bg-signal dark:text-[#412d00] dark:hover:bg-signal-hover dark:shadow-[0_4px_14px_rgba(255,220,161,0.20)] dark:hover:shadow-[0_8px_28px_rgba(255,220,161,0.32)]',
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
