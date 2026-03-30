<script setup lang="ts">
import { COLORS } from '@/data/constants'
import Icon from './Icon.vue'

defineProps<{ text: string }>()
</script>

<template>
  <div
    :style="{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '14px 18px',
      background: COLORS.bgSecondary,
      borderRadius: '10px',
      marginTop: '8px',
    }"
  >
    <Icon name="shield" :size="18" :color="COLORS.teal" />
    <span :style="{ fontSize: '13px', color: COLORS.textSecondary, lineHeight: 1.5 }">{{ text }}</span>
  </div>
</template>
