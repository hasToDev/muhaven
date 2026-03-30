<script setup lang="ts">
import { COLORS, ISSUER_TOKENS } from '@/data/constants'
import Badge from '@/components/Badge.vue'
import PrivacyBanner from '@/components/PrivacyBanner.vue'
</script>

<template>
  <div :style="{ display: 'flex', flexDirection: 'column', gap: '28px' }">
    <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }">
      <div :style="{ fontSize: '28px', fontWeight: 400, fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
        Your Tokens
      </div>
      <button
        :style="{
          padding: '10px 22px',
          background: COLORS.coral,
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          fontSize: '14px',
          fontWeight: 600,
          cursor: 'pointer',
        }"
      >
        + New Token
      </button>
    </div>
    <div
      v-for="(t, i) in ISSUER_TOKENS"
      :key="i"
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '24px 28px',
        cursor: 'pointer',
        transition: 'box-shadow 0.2s',
      }"
      @mouseenter="($event.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)'"
      @mouseleave="($event.currentTarget as HTMLElement).style.boxShadow = 'none'"
    >
      <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }">
        <div>
          <div :style="{ fontSize: '17px', fontWeight: 600, color: COLORS.textPrimary }">{{ t.name }}</div>
          <div :style="{ fontSize: '13px', color: COLORS.textTertiary, fontFamily: `'JetBrains Mono', monospace`, marginTop: '4px' }">{{ t.symbol }}</div>
        </div>
        <Badge variant="coral">Issuer</Badge>
      </div>
      <div :style="{ display: 'flex', gap: '32px', fontSize: '13px', color: COLORS.textSecondary }">
        <span>Supply: <strong :style="{ color: COLORS.textPrimary }">{{ t.supply }}</strong></span>
        <span>Investors: <strong :style="{ color: COLORS.textPrimary }">{{ t.investors }}</strong></span>
        <span>Yield: <strong :style="{ color: COLORS.positive }">{{ t.apy }}% APY</strong></span>
        <span>Schedule: <strong :style="{ color: COLORS.textPrimary }">{{ t.schedule }}</strong></span>
      </div>
    </div>
    <PrivacyBanner text="Aggregate data only. Individual investor balances are encrypted and not visible to issuers." />
  </div>
</template>
