<script setup lang="ts">
import { COLORS, PORTFOLIO } from '@/data/constants'
import Badge from '@/components/Badge.vue'
import Icon from '@/components/Icon.vue'
import PrivacyBanner from '@/components/PrivacyBanner.vue'

function formatUsd(v: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2 })
}

function activityIcon(type: string) {
  if (type === 'yield') return 'trendingUp'
  if (type === 'deposit') return 'arrowDown'
  return 'activity'
}

function activityColor(type: string) {
  return type === 'yield' || type === 'deposit' ? COLORS.teal : COLORS.textSecondary
}

function activityBg(type: string) {
  return type === 'yield' || type === 'deposit' ? COLORS.tealLight : COLORS.bgSecondary
}
</script>

<template>
  <div :style="{ display: 'flex', flexDirection: 'column', gap: '28px' }">
    <!-- Hero value -->
    <div>
      <div
        :style="{
          fontSize: '13px',
          color: COLORS.textTertiary,
          marginBottom: '4px',
          fontWeight: 500,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
        }"
      >
        Total Portfolio Value
      </div>
      <div :style="{ display: 'flex', alignItems: 'baseline', gap: '16px' }">
        <span
          :style="{
            fontSize: '44px',
            fontWeight: 400,
            color: COLORS.textPrimary,
            fontFamily: `'DM Serif Display', Georgia, serif`,
            letterSpacing: '-0.02em',
          }"
        >
          ${{ formatUsd(PORTFOLIO.totalValue) }}
        </span>
        <Badge variant="positive">&uarr; {{ PORTFOLIO.change }}% this month</Badge>
      </div>
    </div>

    <!-- Holdings cards -->
    <div :style="{ display: 'flex', gap: '16px' }">
      <div
        v-for="h in PORTFOLIO.holdings"
        :key="h.symbol"
        :style="{
          flex: 1,
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: '12px',
          padding: '20px 22px',
          transition: 'box-shadow 0.2s',
          cursor: 'pointer',
        }"
        @mouseenter="($event.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)'"
        @mouseleave="($event.currentTarget as HTMLElement).style.boxShadow = 'none'"
      >
        <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }">
          <span :style="{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary }">{{ h.name }}</span>
          <span :style="{ fontSize: '12px', color: COLORS.textTertiary, fontFamily: `'JetBrains Mono', monospace` }">{{ h.symbol }}</span>
        </div>
        <div
          :style="{
            fontSize: '24px',
            fontWeight: 700,
            color: COLORS.textPrimary,
            fontFamily: `'DM Serif Display', Georgia, serif`,
            marginBottom: '8px',
          }"
        >
          ${{ formatUsd(h.value) }}
        </div>
        <div :style="{ display: 'flex', gap: '12px', alignItems: 'center' }">
          <span :style="{ fontSize: '13px', color: COLORS.textSecondary }">{{ h.pct }}% allocation</span>
          <span :style="{ fontSize: '13px', color: COLORS.positive, fontWeight: 600 }">&uarr; {{ h.apy }}% APY</span>
        </div>
      </div>
    </div>

    <!-- Allocation bar -->
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '22px 24px',
      }"
    >
      <div :style="{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '16px' }">Allocation</div>
      <div :style="{ display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', gap: '3px' }">
        <div
          v-for="h in PORTFOLIO.holdings"
          :key="h.symbol"
          :style="{ width: `${h.pct}%`, background: h.color, borderRadius: '7px', transition: 'width 0.5s ease' }"
          :title="`${h.name}: ${h.pct}%`"
        />
      </div>
      <div :style="{ display: 'flex', gap: '24px', marginTop: '14px' }">
        <div v-for="h in PORTFOLIO.holdings" :key="h.symbol" :style="{ display: 'flex', alignItems: 'center', gap: '8px' }">
          <div :style="{ width: '10px', height: '10px', borderRadius: '3px', background: h.color }" />
          <span :style="{ fontSize: '13px', color: COLORS.textSecondary }">{{ h.name }} &middot; {{ h.pct }}%</span>
        </div>
      </div>
    </div>

    <!-- Recent activity -->
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '22px 24px',
      }"
    >
      <div :style="{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '16px' }">Recent Activity</div>
      <div
        v-for="(a, i) in PORTFOLIO.activity"
        :key="i"
        :style="{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 0',
          borderTop: i > 0 ? `1px solid ${COLORS.borderSubtle}` : 'none',
          gap: '14px',
        }"
      >
        <div
          :style="{
            width: '34px',
            height: '34px',
            borderRadius: '8px',
            background: activityBg(a.type),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }"
        >
          <Icon :name="activityIcon(a.type)" :size="16" :color="activityColor(a.type)" />
        </div>
        <div :style="{ flex: 1 }">
          <div :style="{ fontSize: '14px', color: COLORS.textPrimary, fontWeight: 500 }">
            {{ a.desc }} &middot;
            <span :style="{ fontFamily: `'JetBrains Mono', monospace`, fontSize: '13px' }">{{ a.amount }}</span>
          </div>
          <div :style="{ fontSize: '12px', color: COLORS.textTertiary, marginTop: '2px' }">{{ a.token }}</div>
        </div>
        <div :style="{ fontSize: '12px', color: COLORS.textTertiary }">{{ a.time }}</div>
      </div>
    </div>

    <PrivacyBanner text="All balances are encrypted on-chain. Only you can see this data." />
  </div>
</template>
