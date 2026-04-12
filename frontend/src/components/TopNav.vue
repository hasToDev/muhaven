<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAuth } from '@/composables/useAuth'
import { useGlassNav } from '@/composables/useGlassNav'
import { cn, formatAddress } from '@/lib/utils'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'
import {
  PieChart, ArrowDown, TrendingUp, Activity,
  Coins, Share2, Users, ClipboardCheck, Wallet, LogOut, LogIn, Loader2,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()
const walletStore = useWalletStore()
const auth = useAuth()
const { isScrolled } = useGlassNav(20)

const switchingRole = ref(false)

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

const displayAddress = computed(() => formatAddress(authStore.walletAddress))

/**
 * Connection status:
 * - 'connected': wallet + auth both valid (green dot)
 * - 'degraded': wallet connected but auth expired (yellow dot)
 * - 'connecting': wallet reconnecting (spinner)
 * - 'disconnected': no wallet connection
 */
const connectionStatus = computed(() => {
  if (walletStore.connecting) return 'connecting' as const
  if (walletStore.connected && authStore.isAuthenticated) return 'connected' as const
  if (walletStore.connected || authStore.walletAddress) return 'degraded' as const
  return 'disconnected' as const
})

async function switchRole(r: 'investor' | 'issuer') {
  if (r === store.role) return
  if (switchingRole.value) return

  switchingRole.value = true
  try {
    await auth.switchRole(r)
    router.push(r === 'investor' ? '/portfolio' : '/tokens')
  } catch {
    // switchRole failed — stay on current role
    // Error is in authStore.error, but we don't show it in nav
    // Just do a client-side switch as fallback
    store.setRole(r)
    router.push(r === 'investor' ? '/portfolio' : '/tokens')
  } finally {
    switchingRole.value = false
  }
}

function handleSignIn() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

async function handleLogout() {
  await auth.logout()
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
            :disabled="switchingRole"
            :class="cn(
              'px-3 py-1.5 text-xs font-sans font-medium rounded-md transition-all duration-200 capitalize cursor-pointer',
              'disabled:opacity-70 disabled:cursor-wait',
              store.role === r
                ? 'bg-white dark:bg-midnight shadow-sm text-compute'
                : 'text-cool hover:text-midnight dark:hover:text-white',
            )"
          >
            <Loader2 v-if="switchingRole && store.role !== r" :size="12" class="animate-spin inline mr-1" />
            {{ r }}
          </button>
        </div>

        <MDarkToggle />

        <!-- Wallet pill with status dot (desktop) — shown whenever wallet address is known -->
        <div
          v-if="authStore.walletAddress"
          class="hidden sm:flex items-center gap-1.5 bg-mist dark:bg-midnight-mid rounded-lg border border-haze dark:border-white/8"
        >
          <div class="flex items-center gap-2 px-3 py-2">
            <!-- Connection status dot -->
            <span
              v-if="connectionStatus === 'connecting'"
              class="flex items-center"
              title="Reconnecting wallet..."
            >
              <Loader2 :size="12" class="animate-spin text-compute" />
            </span>
            <span
              v-else
              class="relative flex h-2 w-2"
              :title="connectionStatus === 'connected' ? 'Connected' : 'Session expired'"
            >
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
            <Wallet :size="14" class="text-cool" />
            <span class="font-mono text-xs text-slate dark:text-cool">{{ displayAddress }}</span>
          </div>
          <!-- Degraded: Sign In to re-authenticate -->
          <button
            v-if="connectionStatus === 'degraded'"
            @click="handleSignIn"
            class="flex items-center justify-center gap-1.5 px-2.5 py-2 border-l border-haze dark:border-white/8 text-compute hover:text-compute/80 transition-colors duration-200 cursor-pointer"
            title="Session expired — sign in again"
          >
            <LogIn :size="14" />
          </button>
          <!-- Connected: Logout -->
          <button
            v-else
            @click="handleLogout"
            class="flex items-center justify-center px-2.5 py-2 border-l border-haze dark:border-white/8 text-cool hover:text-negative transition-colors duration-200 cursor-pointer"
            title="Sign out"
          >
            <LogOut :size="14" />
          </button>
        </div>

        <!-- No wallet at all: Sign In button (desktop) -->
        <button
          v-else
          @click="handleSignIn"
          class="hidden sm:flex items-center gap-2 px-4 py-2 text-sm font-sans font-medium text-white bg-compute hover:bg-compute/90 rounded-lg transition-colors duration-200 cursor-pointer"
        >
          <LogIn :size="14" />
          Sign In
        </button>

        <!-- Mobile: compact wallet / sign-in -->
        <div class="flex sm:hidden items-center gap-1.5">
          <!-- Wallet known on mobile -->
          <template v-if="authStore.walletAddress">
            <div class="flex items-center gap-1.5 px-2.5 py-2 bg-mist dark:bg-midnight-mid rounded-lg border border-haze dark:border-white/8">
              <!-- Status dot -->
              <span
                v-if="connectionStatus === 'connecting'"
                class="flex items-center"
                title="Reconnecting..."
              >
                <Loader2 :size="10" class="animate-spin text-compute" />
              </span>
              <span
                v-else
                class="relative flex h-1.5 w-1.5"
                :title="connectionStatus === 'connected' ? 'Connected' : 'Session expired'"
              >
                <span
                  :class="[
                    'relative inline-flex rounded-full h-1.5 w-1.5',
                    connectionStatus === 'connected' ? 'bg-positive' : 'bg-gold',
                  ]"
                />
              </span>
              <span class="font-mono text-[10px] text-slate dark:text-cool">{{ displayAddress }}</span>
            </div>
            <!-- Degraded: re-auth -->
            <button
              v-if="connectionStatus === 'degraded'"
              @click="handleSignIn"
              class="flex items-center justify-center p-2 text-compute hover:text-compute/80 transition-colors duration-200 cursor-pointer"
              title="Session expired — sign in again"
            >
              <LogIn :size="14" />
            </button>
            <!-- Connected: logout -->
            <button
              v-else
              @click="handleLogout"
              class="flex items-center justify-center p-2 text-cool hover:text-negative transition-colors duration-200 cursor-pointer"
              title="Sign out"
            >
              <LogOut :size="14" />
            </button>
          </template>

          <!-- No wallet on mobile -->
          <button
            v-else
            @click="handleSignIn"
            class="flex items-center gap-1.5 px-3 py-2 text-xs font-sans font-medium text-white bg-compute hover:bg-compute/90 rounded-lg transition-colors duration-200 cursor-pointer"
          >
            <LogIn :size="12" />
            Sign In
          </button>
        </div>
      </div>
    </nav>
  </header>
</template>
