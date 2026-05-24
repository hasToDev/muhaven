<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { cn } from '@/lib/utils'
import {
  PieChart, ShoppingCart, Undo2,
  Coins, Share2, Users, ClipboardCheck,
  Sparkles, Banknote, FileSignature, KeyRound,
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

// Wave 5 Option D · Commit 4 — Policy (agent-autonomy + Scoped-session
// management) is dual-role. Slotted penultimate, just before Agent, to
// mirror Sidebar/TopNav. The bottom bar now carries 6 items at most
// (4 role tabs + Policy + Agent); the template uses `flex-1 min-w-0` +
// truncated labels so it never overflows the 360px viewport. The
// onboarding set stays minimal (Apply / Cash / Agent) — an unapproved
// issuer can't yet hold a Scoped session, so Policy is omitted there.
const POLICY_TAB = { path: '/agent/policy/transition', icon: KeyRound, label: 'Autonomy' }
const AGENT_TAB = { path: '/agent', icon: Sparkles, label: 'Agent' }

const tabs = computed(() => {
  const isUnapprovedIssuer =
    store.role === 'issuer'
    && authStore.issuerStatus !== 'approved'
    && authStore.issuerStatus !== 'suspended'
  if (isUnapprovedIssuer) {
    return [...onboardingTabs, AGENT_TAB]
  }
  const roleTabs = store.role === 'issuer' ? issuerTabs : investorTabs
  return [...roleTabs, POLICY_TAB, AGENT_TAB]
})
</script>

<template>
  <nav
    class="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-midnight border-t border-haze dark:border-white/8 pb-[env(safe-area-inset-bottom)]"
  >
    <!-- Wave 5 Option D · Commit 4 — `flex-1 min-w-0` + truncated labels
         so 6 tabs (4 role + Policy + Agent) fit without overflowing a
         360px viewport. `px-1` keeps a little breathing room; the label
         truncates (rather than wrapping or pushing the bar wide) on the
         longest tokens ("Distribute"/"Portfolio") at the narrowest
         widths. `justify-around` is dropped — `flex-1` children already
         share the row equally. -->
    <div class="flex items-stretch px-2 py-2">
      <button
        v-for="tab in tabs"
        :key="tab.path"
        :data-testid="`tabbar-nav-${tab.label.toLowerCase()}`"
        :title="tab.label"
        :aria-label="tab.label"
        :aria-current="route.path === tab.path ? 'page' : undefined"
        :class="cn(
          'flex flex-1 min-w-0 flex-col items-center gap-1 px-1 py-2 rounded-xl transition-colors duration-200 cursor-pointer',
          route.path === tab.path
            ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal'
            : 'text-cool hover:text-midnight dark:hover:text-white',
        )"
        @click="router.push(tab.path)"
      >
        <component :is="tab.icon" :size="20" class="flex-shrink-0" aria-hidden="true" />
        <span class="text-[10px] font-medium max-w-full truncate">{{ tab.label }}</span>
      </button>
    </div>
  </nav>
</template>
