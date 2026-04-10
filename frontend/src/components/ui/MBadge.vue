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
      'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-sans font-medium tracking-wide',
      variant === 'positive' ? 'bg-compute/12 text-compute'
        : variant === 'negative' ? 'bg-negative/10 text-negative'
        : variant === 'teal' ? 'bg-compute/12 text-compute border border-compute/25'
        : variant === 'gold' ? 'bg-gold/10 text-gold'
        : variant === 'fhe' ? 'bg-compute/12 border border-compute/25 text-cipher font-mono text-[11px] uppercase tracking-widest'
        : variant === 'privacy' ? 'bg-midnight/80 text-signal border border-signal/20 font-mono text-[11px] uppercase tracking-widest dark:bg-signal/10'
        : 'bg-mist text-slate dark:bg-midnight/50 dark:text-cool',
      $attrs.class as string,
    )"
  >
    <span v-if="pulse" class="relative flex h-2 w-2">
      <span
        :class="[
          'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
          variant === 'negative' ? 'bg-negative' : 'bg-compute',
        ]"
      />
      <span
        :class="[
          'relative inline-flex rounded-full h-2 w-2',
          variant === 'negative' ? 'bg-negative' : 'bg-compute',
        ]"
      />
    </span>
    <Lock v-if="variant === 'privacy'" :size="10" />
    <slot />
  </span>
</template>
