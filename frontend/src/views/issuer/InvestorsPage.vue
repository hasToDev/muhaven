<script setup lang="ts">
import { COLORS } from '@/data/constants'
</script>

<template>
  <div :style="{ fontSize: '28px', fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
    Investors
    <div :style="{ fontSize: '14px', color: COLORS.textSecondary, marginTop: '12px', fontFamily: `'Source Sans 3', sans-serif` }">
      Aggregate investor management. Individual balances encrypted.
    </div>
  </div>
</template>
