<script setup lang="ts">
import { Lock } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

defineProps<{
  variant?: 'default' | 'teal' | 'positive' | 'negative' | 'gold' | 'fhe' | 'privacy'
  pulse?: boolean
}>()
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-label tracking-[0.12em] uppercase font-medium',
      variant === 'positive' ? 'bg-positive/12 text-positive'
        : variant === 'negative' ? 'bg-negative/10 text-negative'
        : variant === 'teal' ? 'bg-compute/10 text-compute border border-compute/25 dark:bg-signal/10 dark:text-signal dark:border-signal/25'
        : variant === 'gold' ? 'bg-gold/10 text-gold border border-gold/25'
        : variant === 'fhe' ? 'bg-compute/10 border border-compute/25 text-compute font-mono text-[11px] tracking-[0.18em] dark:bg-gold/10 dark:border-gold/30 dark:text-gold'
        : variant === 'privacy' ? 'bg-midnight/5 text-compute border border-compute/20 font-mono text-[11px] tracking-[0.18em] dark:bg-signal/10 dark:text-signal dark:border-signal/20'
        : 'bg-mist text-slate dark:bg-midnight-mid dark:text-[#d5c4ab]',
      $attrs.class as string,
    )"
  >
    <span v-if="pulse" class="relative flex h-2 w-2">
      <span
        :class="[
          'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
          variant === 'negative' ? 'bg-negative' : 'bg-signal',
        ]"
      />
      <span
        :class="[
          'relative inline-flex rounded-full h-2 w-2',
          variant === 'negative' ? 'bg-negative' : 'bg-signal',
        ]"
      />
    </span>
    <Lock v-if="variant === 'privacy'" :size="10" />
    <slot />
  </span>
</template>
