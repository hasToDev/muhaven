<script setup lang="ts">
import { ref } from 'vue'
import { COLORS } from '@/data/constants'
import PrivacyBanner from '@/components/PrivacyBanner.vue'

const amount = ref('')
</script>

<template>
  <div :style="{ maxWidth: '560px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '28px' }">
    <div :style="{ fontSize: '28px', fontWeight: 400, fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
      Distribute Yield
    </div>
    <div
      :style="{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: '12px',
        padding: '28px',
      }"
    >
      <div :style="{ fontSize: '13px', fontWeight: 500, color: COLORS.textTertiary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }">
        Select token
      </div>
      <div :style="{ background: COLORS.bgSecondary, borderRadius: '10px', padding: '14px 18px', marginBottom: '24px', fontSize: '14px', fontWeight: 500, color: COLORS.textPrimary }">
        MuHaven Treasury Bond Fund (MHTB) &#9662;
      </div>
      <div :style="{ fontSize: '13px', fontWeight: 500, color: COLORS.textTertiary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }">
        Total yield to distribute
      </div>
      <div :style="{ position: 'relative', marginBottom: '24px' }">
        <span :style="{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', fontSize: '18px', color: COLORS.textTertiary }">$</span>
        <input
          v-model="amount"
          placeholder="50,000.00"
          :style="{
            width: '100%',
            padding: '14px 16px 14px 32px',
            fontSize: '18px',
            border: `1.5px solid ${COLORS.border}`,
            borderRadius: '10px',
            outline: 'none',
            fontFamily: `'JetBrains Mono', monospace`,
            background: COLORS.surface,
            color: COLORS.textPrimary,
            boxSizing: 'border-box',
          }"
          @focus="($event.target as HTMLElement).style.borderColor = COLORS.coral"
          @blur="($event.target as HTMLElement).style.borderColor = COLORS.border"
        />
      </div>
      <div :style="{ background: COLORS.bgSecondary, borderRadius: '10px', padding: '18px 20px', marginBottom: '24px' }">
        <div :style="{ fontSize: '13px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '12px' }">Distribution preview</div>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }">
          <div :style="{ display: 'flex', justifyContent: 'space-between' }">
            <span :style="{ color: COLORS.textSecondary }">Eligible investors</span>
            <span :style="{ fontWeight: 600, color: COLORS.textPrimary }">47</span>
          </div>
          <div :style="{ display: 'flex', justifyContent: 'space-between' }">
            <span :style="{ color: COLORS.textSecondary }">Method</span>
            <span :style="{ fontWeight: 600, color: COLORS.textPrimary }">Equal (demo)</span>
          </div>
          <div :style="{ display: 'flex', justifyContent: 'space-between' }">
            <span :style="{ color: COLORS.textSecondary }">Per investor</span>
            <span :style="{ fontWeight: 600, color: COLORS.textPrimary }">~$1,063.83</span>
          </div>
          <div :style="{ display: 'flex', justifyContent: 'space-between' }">
            <span :style="{ color: COLORS.textSecondary }">Platform fee (0.1%)</span>
            <span :style="{ fontWeight: 600, color: COLORS.textPrimary }">$50.00</span>
          </div>
        </div>
      </div>
      <button
        :style="{
          width: '100%',
          padding: '16px',
          background: COLORS.coral,
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          fontSize: '15px',
          fontWeight: 600,
          cursor: 'pointer',
        }"
      >
        Deposit &amp; Distribute
      </button>
      <PrivacyBanner text="Individual distribution amounts are encrypted. You see totals only." />
    </div>
  </div>
</template>
