<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { cn } from '@/lib/utils'
import {
  PieChart, ShoppingCart, TrendingUp, Undo2,
  Coins, Share2, Users, ClipboardCheck,
  Sparkles,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const investorTabs = [
  { path: '/portfolio', icon: PieChart, label: 'Portfolio' },
  { path: '/buy', icon: ShoppingCart, label: 'Buy' },
  { path: '/yields', icon: TrendingUp, label: 'Yields' },
  { path: '/redemptions', icon: Undo2, label: 'Redeem' },
]

const issuerTabs = [
  { path: '/tokens', icon: Coins, label: 'Tokens' },
  { path: '/distribute', icon: Share2, label: 'Distribute' },
  { path: '/investors', icon: Users, label: 'Investors' },
  { path: '/compliance', icon: ClipboardCheck, label: 'Compliance' },
]

const tabs = computed(() => {
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
