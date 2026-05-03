<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { cn } from '@/lib/utils'
import {
  PieChart, ShoppingCart, Undo2,
  Coins, Share2, Users, ClipboardCheck,
  Sparkles, Banknote, FileSignature,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()

// Phase 9.A: Cash takes mobile slot #1 — matches Sidebar/TopNav. The bottom
// bar is capped at four role-tabs + Agent, so promoting Cash bumps Yields
// off the bar (still reachable via TopNav). Action-oriented tabs win the
// scarce mobile real estate over informational ones.
const investorTabs = [
  { path: '/cash', icon: Banknote, label: 'Cash' },
  { path: '/portfolio', icon: PieChart, label: 'Portfolio' },
  { path: '/trade', icon: ShoppingCart, label: 'Trade' },
  { path: '/redemptions', icon: Undo2, label: 'Redeem' },
]

// Phase 9.A · /cash is dual-role on the mobile bar too. Bumps
// Compliance off the bottom bar (still reachable via TopNav menu) so
// the Distribute → Cash funnel is one tap away from anywhere.
const issuerTabs = [
  { path: '/cash', icon: Banknote, label: 'Cash' },
  { path: '/tokens', icon: Coins, label: 'Tokens' },
  { path: '/distribute', icon: Share2, label: 'Distribute' },
  { path: '/investors', icon: Users, label: 'Investors' },
]

// Phase 9.A · Expansion (F2). An issuer who hasn't finished KYB is
// gated from /tokens, /distribute, /investors, /compliance — the
// router redirects them all back to /apply-issuer. Showing those
// disabled tabs in the mobile bar would create a confusing
// tap-and-bounce loop. Instead, surface a focused 3-tab set: Apply
// (the wizard) → Cash (universal) → Agent.
const onboardingTabs = [
  { path: '/apply-issuer', icon: FileSignature, label: 'Apply' },
  { path: '/cash', icon: Banknote, label: 'Cash' },
]

const tabs = computed(() => {
  const isUnapprovedIssuer =
    store.role === 'issuer'
    && authStore.issuerStatus !== 'approved'
    && authStore.issuerStatus !== 'suspended'
  if (isUnapprovedIssuer) {
    return [...onboardingTabs, { path: '/agent', icon: Sparkles, label: 'Agent' }]
  }
  const roleTabs = store.role === 'issuer' ? issuerTabs : investorTabs
  return [...roleTabs, { path: '/agent', icon: Sparkles, label: 'Agent' }]
})
</script>

<template>
  <nav
    class="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-midnight border-t border-haze dark:border-white/8 pb-[env(safe-area-inset-bottom)]"
  >
    <div class="flex items-center justify-around px-2 py-2">
      <button
        v-for="tab in tabs"
        :key="tab.path"
        :class="cn(
          'flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-all duration-200 cursor-pointer',
          route.path === tab.path
            ? 'text-compute bg-compute/10'
            : 'text-cool hover:text-midnight dark:hover:text-white',
        )"
        @click="router.push(tab.path)"
      >
        <component :is="tab.icon" :size="20" />
        <span class="text-[10px] font-medium">{{ tab.label }}</span>
      </button>
    </div>
  </nav>
</template>
