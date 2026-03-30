<script setup lang="ts">
import { COLORS, PORTFOLIO } from '@/data/constants'
import Icon from '@/components/Icon.vue'

const allActivity = [...PORTFOLIO.activity, ...PORTFOLIO.activity]

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
    <div :style="{ fontSize: '28px', fontWeight: 400, fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
      Activity
    </div>
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '22px 24px',
      }"
    >
      <div
        v-for="(a, i) in allActivity"
        :key="i"
        :style="{
          display: 'flex',
          alignItems: 'center',
          padding: '14px 0',
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
  </div>
</template>
