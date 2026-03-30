<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { COLORS } from '@/data/constants'
import Icon from './Icon.vue'

const router = useRouter()
const route = useRoute()

const role = defineModel<'investor' | 'issuer'>('role', { required: true })

const accent = computed(() => (role.value === 'investor' ? COLORS.teal : COLORS.coral))

const investorNav = [
  { id: 'portfolio', label: 'Portfolio', icon: 'pieChart', path: '/portfolio' },
  { id: 'deposit', label: 'Deposit', icon: 'arrowDown', path: '/deposit' },
  { id: 'yields', label: 'Yields', icon: 'trendingUp', path: '/yields' },
  { id: 'activity', label: 'Activity', icon: 'activity', path: '/activity' },
]

const issuerNav = [
  { id: 'tokens', label: 'Tokens', icon: 'coins', path: '/tokens' },
  { id: 'distribute', label: 'Distribute', icon: 'share', path: '/distribute' },
  { id: 'investors', label: 'Investors', icon: 'users', path: '/investors' },
  { id: 'compliance', label: 'Compliance', icon: 'clipboardCheck', path: '/compliance' },
]

const navItems = computed(() => (role.value === 'investor' ? investorNav : issuerNav))

function isActive(path: string) {
  return route.path === path
}

function navigate(path: string) {
  router.push(path)
}

function switchRole(r: 'investor' | 'issuer') {
  role.value = r
  if (r === 'investor') router.push('/portfolio')
  else router.push('/tokens')
}
</script>

<template>
  <nav
    :style="{
      height: '64px',
      background: COLORS.surface,
      borderBottom: `1px solid ${COLORS.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: '0 32px',
      position: 'sticky',
      top: 0,
      zIndex: 50,
    }"
  >
    <!-- Logo -->
    <div :style="{ display: 'flex', alignItems: 'center', gap: '10px', marginRight: '48px' }">
      <img
        src="/logo.jpg"
        alt="MuHaven logo"
        :style="{
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          mixBlendMode: 'multiply',
          objectFit: 'contain',
        }"
      />
      <span :style="{ fontSize: '18px', fontWeight: 700, color: COLORS.textPrimary, letterSpacing: '-0.02em' }">MuHaven</span>
    </div>

    <!-- Nav items -->
    <div :style="{ display: 'flex', gap: '4px', flex: 1 }">
      <button
        v-for="item in navItems"
        :key="item.id"
        @click="navigate(item.path)"
        :style="{
          padding: '8px 18px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          transition: 'all 0.15s',
          background: isActive(item.path)
            ? (role === 'investor' ? COLORS.tealLight : COLORS.coralLight)
            : 'transparent',
          color: isActive(item.path) ? accent : COLORS.textSecondary,
        }"
        @mouseenter="(e: MouseEvent) => { if (!isActive(item.path)) (e.currentTarget as HTMLElement).style.background = COLORS.bgSecondary }"
        @mouseleave="(e: MouseEvent) => { if (!isActive(item.path)) (e.currentTarget as HTMLElement).style.background = 'transparent' }"
      >
        <Icon :name="item.icon" :size="17" :color="isActive(item.path) ? accent : COLORS.textTertiary" />
        {{ item.label }}
      </button>
    </div>

    <!-- Right side -->
    <div :style="{ display: 'flex', alignItems: 'center', gap: '16px' }">
      <!-- Role toggle -->
      <div :style="{ display: 'flex', background: COLORS.bgSecondary, borderRadius: '8px', padding: '3px', border: `1px solid ${COLORS.border}` }">
        <button
          v-for="r in (['investor', 'issuer'] as const)"
          :key="r"
          @click="switchRole(r)"
          :style="{
            padding: '6px 16px',
            borderRadius: '6px',
            border: 'none',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            background: role === r ? COLORS.surface : 'transparent',
            color: role === r ? (r === 'investor' ? COLORS.teal : COLORS.coral) : COLORS.textTertiary,
            boxShadow: role === r ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
          }"
        >
          {{ r.charAt(0).toUpperCase() + r.slice(1) }}
        </button>
      </div>

      <!-- Wallet -->
      <div
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 14px',
          background: COLORS.bgSecondary,
          borderRadius: '8px',
          border: `1px solid ${COLORS.border}`,
          fontSize: '13px',
          fontFamily: `'JetBrains Mono', monospace`,
          color: COLORS.textSecondary,
        }"
      >
        <Icon name="wallet" :size="15" :color="COLORS.textTertiary" />
        0x7a3f...b29e
      </div>
    </div>
  </nav>
</template>
