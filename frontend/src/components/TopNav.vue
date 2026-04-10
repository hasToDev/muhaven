<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useGlassNav } from '@/composables/useGlassNav'
import { cn } from '@/lib/utils'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'
import {
  PieChart, ArrowDown, TrendingUp, Activity,
  Coins, Share2, Users, ClipboardCheck, Wallet,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const { isScrolled } = useGlassNav(20)

const investorNav = [
  { path: '/portfolio', label: 'Portfolio', icon: PieChart },
  { path: '/deposit', label: 'Deposit', icon: ArrowDown },
  { path: '/yields', label: 'Yields', icon: TrendingUp },
  { path: '/activity', label: 'Activity', icon: Activity },
]

const issuerNav = [
  { path: '/tokens', label: 'Tokens', icon: Coins },
  { path: '/distribute', label: 'Distribute', icon: Share2 },
  { path: '/investors', label: 'Investors', icon: Users },
  { path: '/compliance', label: 'Compliance', icon: ClipboardCheck },
]

const navItems = computed(() => store.role === 'investor' ? investorNav : issuerNav)

function switchRole(r: 'investor' | 'issuer') {
  store.setRole(r)
  router.push(r === 'investor' ? '/portfolio' : '/tokens')
}
</script>

<template>
  <header
    :class="cn(
      'sticky top-0 z-50 transition-all duration-500',
      isScrolled ? 'pt-1.5 px-3' : '',
    )"
  >
    <nav
      :class="cn(
        'flex items-center h-16 px-4 md:px-8 transition-all duration-500',
        isScrolled
          ? 'glass-panel mx-auto rounded-xl'
          : 'bg-white dark:bg-midnight border-b border-haze dark:border-white/8',
      )"
    >
      <!-- Logo -->
      <router-link to="/" class="flex items-center gap-2.5 mr-6">
        <img src="/logo.jpg" alt="MuHaven" class="w-8 h-8 rounded-lg" style="mix-blend-mode: multiply" />
        <span class="text-lg font-sans font-bold text-midnight dark:text-white hidden sm:inline tracking-tight">MuHaven</span>
      </router-link>

      <!-- Nav items (hidden on mobile — MMobileTabBar handles it) -->
      <div class="hidden md:flex items-center gap-1">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          :class="cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-sans font-medium transition-all duration-200',
            route.path === item.path
              ? 'bg-compute/12 text-compute border border-compute/25'
              : 'text-cool hover:bg-mist dark:hover:bg-midnight-mid hover:text-midnight dark:hover:text-white',
          )"
        >
          <component :is="item.icon" :size="16" :stroke-width="1.8" />
          <span>{{ item.label }}</span>
        </router-link>
      </div>

      <div class="flex-1" />

      <div class="flex items-center gap-2">
        <!-- Role toggle -->
        <div class="flex bg-mist dark:bg-midnight-mid rounded-lg p-0.5 border border-haze dark:border-white/8">
          <button
            v-for="r in (['investor', 'issuer'] as const)"
            :key="r"
            @click="switchRole(r)"
            :class="cn(
              'px-3 py-1.5 text-xs font-sans font-medium rounded-md transition-all duration-200 capitalize cursor-pointer',
              store.role === r
                ? 'bg-white dark:bg-midnight shadow-sm text-compute'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            )"
          >
            {{ r }}
          </button>
        </div>

        <MDarkToggle />

        <!-- Wallet -->
        <div class="hidden sm:flex items-center gap-2 bg-mist dark:bg-midnight-mid rounded-lg px-3 py-2 border border-haze dark:border-white/8">
          <Wallet :size="14" class="text-cool" />
          <span class="font-mono text-xs text-slate dark:text-cool">0x7a3f...b29e</span>
        </div>
      </div>
    </nav>
  </header>
</template>
