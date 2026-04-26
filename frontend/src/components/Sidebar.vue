<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAuth } from '@/composables/useAuth'
import { useHomeTarget } from '@/composables/useHomeTarget'
import { cn, formatAddress } from '@/lib/utils'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'
import MSessionStatus from '@/components/ui/MSessionStatus.vue'
import MDevModeBanner from '@/components/ui/MDevModeBanner.vue'
import { toast } from 'vue-sonner'
import {
  PieChart, ShoppingCart, TrendingUp, Activity, Store, Sparkles, Send, Undo2,
  Coins, Share2, Users, ClipboardCheck, Wallet, LogOut, LogIn, Loader2,
  Copy, Check, ArrowLeftRight,
} from 'lucide-vue-next'

// Role is chosen at login (see LoginPage.vue). The sidebar no longer offers a
// post-login switcher — users must re-sign-in via a different role if they
// need to change. Keeping `useAuth()` imported only for logout.

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()
const walletStore = useWalletStore()
const auth = useAuth()
const homeTarget = useHomeTarget()

const investorNav = [
  { path: '/portfolio', label: 'Portfolio', icon: PieChart },
  { path: '/marketplace', label: 'Marketplace', icon: Store },
  { path: '/trade', label: 'Trade', icon: ShoppingCart },
  { path: '/wrap', label: 'Wrap', icon: ArrowLeftRight },
  { path: '/transfer', label: 'Transfer', icon: Send },
  { path: '/yields', label: 'Yields', icon: TrendingUp },
  { path: '/redemptions', label: 'Redemptions', icon: Undo2 },
  { path: '/activity', label: 'Activity', icon: Activity },
  { path: '/agent', label: 'Agent', icon: Sparkles },
]

const issuerNav = [
  { path: '/tokens', label: 'Tokens', icon: Coins },
  { path: '/distribute', label: 'Distribute', icon: Share2 },
  { path: '/investors', label: 'Investors', icon: Users },
  { path: '/compliance', label: 'Compliance', icon: ClipboardCheck },
]

const navItems = computed(() => store.role === 'investor' ? investorNav : issuerNav)

const displayAddress = computed(() => formatAddress(authStore.walletAddress))

const connectionStatus = computed(() => {
  if (walletStore.connecting) return 'connecting' as const
  if (walletStore.connected && authStore.isAuthenticated) return 'connected' as const
  if (walletStore.connected || authStore.walletAddress) return 'degraded' as const
  return 'disconnected' as const
})

function handleSignIn() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

async function handleLogout() {
  await auth.logout()
}

const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

async function copyAddress() {
  const full = authStore.walletAddress
  if (!full) return
  try {
    await navigator.clipboard.writeText(full)
    copied.value = true
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copied.value = false }, 1500)
    toast.success('Address copied', { description: full })
  } catch (e) {
    toast.error('Copy failed', {
      description: e instanceof Error ? e.message : 'Clipboard access denied',
    })
  }
}

onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<template>
  <aside
    class="hidden md:flex flex-col h-screen fixed left-0 top-0 w-64 z-40
           bg-white/95 dark:bg-[#0d0e10]/90 backdrop-blur-xl
           border-r border-haze dark:border-white/5
           shadow-[8px_0_40px_-20px_rgba(63,46,12,0.08)]
           dark:shadow-[8px_0_40px_-20px_rgba(0,0,0,0.6)]"
  >
    <!-- Brand -->
    <RouterLink
      :to="homeTarget"
      data-testid="nav-logo-home"
      class="px-7 pt-8 pb-10 flex flex-col gap-1.5 cursor-pointer group"
    >
      <div class="flex items-center gap-2.5">
        <img
          src="/logo.png"
          alt="MuHaven"
          class="w-9 h-9 rounded-lg transition-transform duration-300 group-hover:scale-110
                 mix-blend-multiply dark:mix-blend-normal
                 dark:drop-shadow-[0_0_12px_rgba(255,186,32,0.45)]"
        />
        <h1 class="font-sans font-bold text-2xl tracking-tight text-midnight dark:text-white">
          MuHaven
        </h1>
      </div>
      <p class="font-accent italic text-[13px] text-cool tracking-wide pl-[2.875rem] -mt-0.5">
        Institutional Vault
      </p>
    </RouterLink>

    <!-- Nav items -->
    <nav class="flex-1 px-3 space-y-1 overflow-y-auto no-scrollbar">
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :data-testid="`sidebar-nav-${item.label.toLowerCase()}`"
        :class="cn(
          'flex items-center gap-3 py-2.5 px-4 text-sm font-sans transition-all duration-200 group',
          route.path === item.path
            ? 'border-l-2 border-gold bg-compute/8 dark:bg-signal/5 text-compute dark:text-signal font-semibold rounded-r-lg pl-[14px]'
            : 'text-cool hover:text-midnight dark:hover:text-white hover:bg-mist/70 dark:hover:bg-white/5 rounded-lg font-medium',
        )"
      >
        <component
          :is="item.icon"
          :size="18"
          :stroke-width="route.path === item.path ? 2.2 : 1.7"
          :class="route.path === item.path
            ? 'text-gold'
            : 'text-cool/80 group-hover:text-compute dark:group-hover:text-signal transition-colors'"
        />
        <span class="tracking-wide">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!-- Bottom: dark + wallet + logout (role toggle removed — role is
         chosen at login and can't be switched post-login). -->
    <div class="px-5 pt-5 pb-6 border-t border-haze/70 dark:border-white/5 space-y-3">
      <!-- Dark toggle row -->
      <div class="flex items-center justify-between px-1">
        <span class="text-[10px] uppercase tracking-[0.18em] text-cool font-sans font-medium">
          Appearance
        </span>
        <MDarkToggle data-testid="nav-dark-toggle" />
      </div>

      <!-- Wallet pill / sign in -->
      <div
        v-if="authStore.walletAddress"
        class="flex items-center gap-1 bg-mist dark:bg-midnight-mid/70 rounded-lg border border-haze dark:border-white/8"
      >
        <button
          type="button"
          @click="copyAddress"
          data-testid="nav-wallet-pill"
          :data-full-address="authStore.walletAddress"
          :title="copied ? 'Copied!' : `Copy ${authStore.walletAddress}`"
          :aria-label="copied ? 'Address copied to clipboard' : `Copy smart account address ${authStore.walletAddress}`"
          class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-haze/60 dark:hover:bg-white/5 transition-colors rounded-l-lg"
        >
          <span v-if="connectionStatus === 'connecting'" class="flex items-center flex-shrink-0">
            <Loader2 :size="12" class="animate-spin text-compute dark:text-signal" />
          </span>
          <span v-else class="relative flex h-2 w-2 flex-shrink-0">
            <span
              v-if="connectionStatus === 'connected'"
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75"
            />
            <span
              :class="[
                'relative inline-flex rounded-full h-2 w-2',
                connectionStatus === 'connected' ? 'bg-positive' : 'bg-gold',
              ]"
            />
          </span>
          <Wallet :size="13" class="text-cool flex-shrink-0" />
          <span class="font-mono text-[11px] text-slate dark:text-body-dark truncate">
            {{ displayAddress }}
          </span>
          <Check v-if="copied" :size="11" class="text-positive flex-shrink-0" />
          <Copy v-else :size="11" class="text-cool/60 flex-shrink-0" />
        </button>
        <!-- Degraded: Sign In -->
        <button
          v-if="connectionStatus === 'degraded'"
          @click="handleSignIn"
          class="flex items-center justify-center gap-1.5 px-2.5 py-2.5 border-l border-haze dark:border-white/8 text-compute dark:text-signal hover:text-compute/70 dark:hover:text-signal-hover transition-colors duration-200 cursor-pointer rounded-r-lg"
          title="Session expired — sign in again"
        >
          <LogIn :size="13" />
        </button>
        <!-- Connected: Logout -->
        <button
          v-else
          @click="handleLogout"
          data-testid="nav-wallet-logout"
          class="flex items-center justify-center px-2.5 py-2.5 border-l border-haze dark:border-white/8 text-cool hover:text-negative transition-colors duration-200 cursor-pointer rounded-r-lg"
          title="Sign out"
        >
          <LogOut :size="13" />
        </button>
      </div>

      <!-- No wallet: Sign In -->
      <button
        v-else
        @click="handleSignIn"
        data-testid="nav-wallet-signin"
        class="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-sans font-semibold text-white dark:text-[#412d00] bg-compute dark:bg-signal hover:bg-compute-hover dark:hover:bg-signal-hover rounded-lg transition-colors duration-200 cursor-pointer shadow-[0_4px_14px_rgba(184,134,11,0.22)] dark:shadow-[0_4px_14px_rgba(255,220,161,0.2)]"
      >
        <LogIn :size="14" />
        Sign In
      </button>

      <!-- Session status (below wallet) -->
      <div v-if="authStore.walletAddress" class="flex items-center justify-center pt-1">
        <MSessionStatus data-testid="session-status" />
      </div>

      <!-- ADR-023 dev-mode pill — bottom of the sidebar so it's always
           visible without dominating the chrome. Tighter top spacing
           (`!mt-1.5` overrides the parent's `space-y-3` gap) keeps the
           pill visually attached to the wallet section above. Renders
           nothing when devMode is off or unconfigured. -->
      <MDevModeBanner class="!mt-1.5" />
    </div>
  </aside>
</template>
