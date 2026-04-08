<script setup lang="ts">
import { ref } from 'vue'
import { COLORS } from '@/data/constants'
import PrivacyBanner from '@/components/PrivacyBanner.vue'

const amount = ref('')
</script>

<template>
  <div :style="{ maxWidth: '520px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '28px' }">
    <div :style="{ fontSize: '28px', fontWeight: 400, fontFamily: `'DM Serif Display', Georgia, serif`, color: COLORS.textPrimary }">
      Deposit USDC
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
        From
      </div>
      <div :style="{ background: COLORS.bgSecondary, borderRadius: '10px', padding: '14px 18px', marginBottom: '28px' }">
        <div :style="{ fontSize: '14px', fontWeight: 500, color: COLORS.textPrimary }">Arbitrum Sepolia</div>
        <div :style="{ fontSize: '13px', color: COLORS.textSecondary, fontFamily: `'JetBrains Mono', monospace`, marginTop: '4px' }">
          0x7a3f...b29e &middot; Balance: 12,500.00 USDC
        </div>
      </div>
      <div :style="{ fontSize: '13px', fontWeight: 500, color: COLORS.textTertiary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }">
        Amount
      </div>
      <div :style="{ display: 'flex', gap: '10px', marginBottom: '28px' }">
        <div :style="{ flex: 1, position: 'relative' }">
          <span :style="{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', fontSize: '18px', color: COLORS.textTertiary }">$</span>
          <input
            v-model="amount"
            placeholder="0.00"
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
              transition: 'border-color 0.15s',
            }"
            @focus="($event.target as HTMLElement).style.borderColor = COLORS.teal"
            @blur="($event.target as HTMLElement).style.borderColor = COLORS.border"
          />
        </div>
        <button
          @click="amount = '12,500.00'"
          :style="{
            padding: '14px 20px',
            background: COLORS.bgSecondary,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '10px',
            fontSize: '13px',
            fontWeight: 600,
            color: COLORS.textSecondary,
            cursor: 'pointer',
          }"
        >
          MAX
        </button>
      </div>
      <button
        :style="{
          width: '100%',
          padding: '16px',
          background: COLORS.teal,
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          fontSize: '15px',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'background 0.15s',
        }"
        @mouseenter="($event.currentTarget as HTMLElement).style.background = COLORS.tealDark"
        @mouseleave="($event.currentTarget as HTMLElement).style.background = COLORS.teal"
      >
        Deposit via ReineiraOS
      </button>
      <PrivacyBanner text="Amount will be encrypted on-chain. Nobody can see how much you deposited." />
    </div>
  </div>
</template>
