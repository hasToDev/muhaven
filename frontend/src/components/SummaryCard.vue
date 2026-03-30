<script setup lang="ts">
import { COLORS } from '@/data/constants'

defineProps<{
  label: string
  value: string
  sub?: string
  accent?: string
}>()
</script>

<template>
  <div
    :style="{
      flex: 1,
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: '12px',
      padding: '20px 24px',
      minWidth: 0,
    }"
  >
    <div :style="{ fontSize: '13px', color: COLORS.textTertiary, marginBottom: '6px', fontWeight: 500 }">
      {{ label }}
    </div>
    <div
      :style="{
        fontSize: '26px',
        fontWeight: 700,
        color: accent || COLORS.textPrimary,
        fontFamily: `'DM Serif Display', Georgia, serif`,
      }"
    >
      {{ value }}
    </div>
    <div v-if="sub" :style="{ fontSize: '13px', color: COLORS.textSecondary, marginTop: '4px' }">
      {{ sub }}
    </div>
  </div>
</template>
