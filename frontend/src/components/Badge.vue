<script setup lang="ts">
import { computed } from 'vue'
import { COLORS } from '@/data/constants'

const props = defineProps<{
  variant?: 'default' | 'teal' | 'coral' | 'amber' | 'positive'
}>()

const styles: Record<string, { bg: string; color: string }> = {
  default: { bg: COLORS.bgSecondary, color: COLORS.textSecondary },
  teal: { bg: COLORS.tealLight, color: COLORS.teal },
  coral: { bg: COLORS.coralLight, color: COLORS.coral },
  amber: { bg: COLORS.amberLight, color: COLORS.amber },
  positive: { bg: COLORS.tealLight, color: COLORS.positive },
}

const s = computed(() => styles[props.variant ?? 'default'] ?? styles.default)
</script>

<template>
  <span
    :style="{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '3px 10px',
      borderRadius: '20px',
      fontSize: '12px',
      fontWeight: 600,
      background: s.bg,
      color: s.color,
      letterSpacing: '0.01em',
    }"
  >
    <slot />
  </span>
</template>
