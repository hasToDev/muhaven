<script setup lang="ts">
import { COLORS, YIELDS_DATA } from '@/data/constants'
import SummaryCard from '@/components/SummaryCard.vue'
import Badge from '@/components/Badge.vue'

function formatUsd(v: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2 })
}
</script>

<template>
  <div :style="{ display: 'flex', flexDirection: 'column', gap: '28px' }">
    <div :style="{ fontSize: '28px', fontWeight: 400, fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
      Yields
    </div>
    <div :style="{ display: 'flex', gap: '16px' }">
      <SummaryCard label="Total earned" :value="`$${formatUsd(YIELDS_DATA.totalEarned)}`" :accent="COLORS.teal" />
      <SummaryCard label="Pending" :value="`$${formatUsd(YIELDS_DATA.pending)}`" :accent="COLORS.amber" />
      <SummaryCard label="Next payout" :value="YIELDS_DATA.nextPayout" />
    </div>

    <!-- Pending Claims -->
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '22px 24px',
      }"
    >
      <div :style="{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '16px' }">Pending Claims</div>
      <div
        v-for="(c, i) in YIELDS_DATA.pendingClaims"
        :key="i"
        :style="{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 0',
          borderTop: i > 0 ? `1px solid ${COLORS.borderSubtle}` : 'none',
        }"
      >
        <div>
          <div :style="{ fontSize: '14px', fontWeight: 500, color: COLORS.textPrimary }">{{ c.token }}</div>
          <div
            :style="{
              fontSize: '22px',
              fontWeight: 700,
              fontFamily: `'DM Serif Display', Georgia, serif`,
              color: COLORS.textPrimary,
              marginTop: '4px',
            }"
          >
            ${{ c.amount.toFixed(2) }}
          </div>
        </div>
        <button
          :style="{
            padding: '10px 28px',
            background: COLORS.teal,
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }"
          @mouseenter="($event.currentTarget as HTMLElement).style.background = COLORS.tealDark"
          @mouseleave="($event.currentTarget as HTMLElement).style.background = COLORS.teal"
        >
          Claim
        </button>
      </div>
    </div>

    <!-- History -->
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '22px 24px',
      }"
    >
      <div :style="{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '16px' }">History</div>
      <div
        v-for="(h, i) in YIELDS_DATA.history"
        :key="i"
        :style="{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 0',
          borderTop: i > 0 ? `1px solid ${COLORS.borderSubtle}` : 'none',
          gap: '14px',
        }"
      >
        <span :style="{ fontSize: '13px', color: COLORS.textTertiary, width: '56px' }">{{ h.date }}</span>
        <span :style="{ flex: 1, fontSize: '14px', color: COLORS.textPrimary }">{{ h.token }}</span>
        <span :style="{ fontSize: '14px', fontFamily: `'JetBrains Mono', monospace`, color: COLORS.textPrimary, fontWeight: 500 }">{{ h.amount }}</span>
        <Badge variant="positive">Claimed &#10003;</Badge>
      </div>
    </div>
  </div>
</template>
