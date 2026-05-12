<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import type { CheckoutSessionStatus } from '@/services/api'

const props = defineProps<{
  status: CheckoutSessionStatus
  size?: 'sm' | 'md'
}>()

interface StatusAccent {
  label: string
  text: string
  ring: string
  bg: string
  dot: string
}

const accent = computed<StatusAccent>(() => {
  switch (props.status) {
    case 'pending':
      return {
        label: 'Pending',
        text: 'text-gold',
        ring: 'border-gold/30',
        bg: 'bg-gold/10',
        dot: 'bg-gold animate-pulse',
      }
    case 'funded':
      return {
        label: 'Funded',
        text: 'text-compute dark:text-signal',
        ring: 'border-compute/30 dark:border-signal/30',
        bg: 'bg-compute/10 dark:bg-signal/10',
        dot: 'bg-compute dark:bg-signal',
      }
    case 'wrapped':
      return {
        label: 'Wrapped',
        text: 'text-compute dark:text-signal',
        ring: 'border-compute/30 dark:border-signal/30',
        bg: 'bg-compute/10 dark:bg-signal/10',
        dot: 'bg-compute dark:bg-signal',
      }
    case 'purchased':
      return {
        label: 'Purchased',
        text: 'text-positive',
        ring: 'border-positive/30',
        bg: 'bg-positive/10',
        dot: 'bg-positive',
      }
    case 'settled':
      return {
        label: 'Settled',
        text: 'text-positive',
        ring: 'border-positive/40',
        bg: 'bg-positive/12',
        dot: 'bg-positive',
      }
    case 'expired':
      return {
        label: 'Expired',
        text: 'text-cool',
        ring: 'border-haze dark:border-white/10',
        bg: 'bg-mist/50 dark:bg-white/5',
        dot: 'bg-cool',
      }
    case 'failed':
      return {
        label: 'Failed',
        text: 'text-negative',
        ring: 'border-negative/30',
        bg: 'bg-negative/10',
        dot: 'bg-negative',
      }
    default:
      return {
        label: String(props.status),
        text: 'text-cool',
        ring: 'border-haze dark:border-white/10',
        bg: 'bg-mist/50 dark:bg-white/5',
        dot: 'bg-cool',
      }
  }
})
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center gap-1.5 rounded-full font-label tracking-[0.10em] uppercase font-medium border',
      size === 'sm' ? 'px-2.5 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
      accent.bg,
      accent.text,
      accent.ring,
    )"
  >
    <span :class="cn('inline-flex h-1.5 w-1.5 rounded-full', accent.dot)" />
    {{ accent.label }}
  </span>
</template>
