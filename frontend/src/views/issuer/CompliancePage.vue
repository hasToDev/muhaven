<script setup lang="ts">
import { COLORS } from '@/data/constants'
</script>

<template>
  <div :style="{ fontSize: '28px', fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
    Compliance
    <div :style="{ fontSize: '14px', color: COLORS.textSecondary, marginTop: '12px', fontFamily: `'Source Sans 3', sans-serif` }">
      KYC gate configuration, trusted issuers, jurisdiction overview.
    </div>
  </div>
</template>
