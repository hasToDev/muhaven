<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'
import { useAuth } from '@/composables/useAuth'
import { useGlassNav } from '@/composables/useGlassNav'
import { useHomeTarget } from '@/composables/useHomeTarget'
import { cn, formatAddress } from '@/lib/utils'
import MDarkToggle from '@/components/ui/MDarkToggle.vue'
import MSessionStatus from '@/components/ui/MSessionStatus.vue'
import MDevModeBanner from '@/components/ui/MDevModeBanner.vue'
import { toast } from 'vue-sonner'
import {
  PieChart, ShoppingCart, TrendingUp, Activity, Store, Sparkles, Send, Undo2,
  Coins, Share2, Users, ClipboardCheck, Wallet, LogOut, LogIn, Loader2,
  Copy, Check, Banknote, FileSignature,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()
const walletStore = useWalletStore()
const auth = useAuth()
const { isScrolled } = useGlassNav(20)
const homeTarget = useHomeTarget()

// Phase 9.A · Expansion (F2). Mirror Sidebar.vue's onboarding nav
// item — same logic, no amber ring (horizontal nav crops borders
// awkwardly on mobile per UI Designer). Status dot + bold label
// weight carry the attention signal instead.
const showOnboardingNav = computed(
  () =>
    store.role === 'issuer'
    && (authStore.issuerStatus === 'unregistered' || authStore.issuerStatus === 'pending'),
)
const onboardingNavLabel = computed(() =>
  authStore.issuerStatus === 'pending' ? 'Application' : 'Apply',
)
const onboardingNavIsActionable = computed(
  () => authStore.issuerStatus === 'unregistered',
)

// Phase 9.A: Cash promoted to first nav item — matches Sidebar.vue.
const investorNav = [
  { path: '/cash', label: 'Cash', icon: Banknote },
  { path: '/portfolio', label: 'Portfolio', icon: PieChart },
  { path: '/marketplace', label: 'Marketplace', icon: Store },
  { path: '/trade', label: 'Trade', icon: ShoppingCart },
  { path: '/transfer', label: 'Transfer', icon: Send },
  { path: '/yields', label: 'Yields', icon: TrendingUp },
  { path: '/redemptions', label: 'Redemptions', icon: Undo2 },
  { path: '/activity', label: 'Activity', icon: Activity },
  { path: '/agent', label: 'Agent', icon: Sparkles },
]

// Phase 9.A · /cash is dual-role; issuer side needs mhUSDC float for
// distribute. Mirror the Sidebar.vue ordering exactly.
const issuerNav = [
  { path: '/cash', label: 'Cash', icon: Banknote },
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

function handleSignIn() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

async function handleLogout() {
  await auth.logout()
}

// Click-to-copy for the truncated address pill. Copies the full smart account
// address (not the `0x12b5...f09A` display form). Briefly swaps the Copy icon
// for a Check via `copied`, then resets. A toast confirms to the user.
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
      <router-link :to="homeTarget" data-testid="nav-logo-home" class="flex items-center gap-2.5 mr-6">
        <img src="/logo.png" alt="MuHaven" class="w-8 h-8 rounded-lg" style="mix-blend-mode: multiply" />
        <span class="text-lg font-sans font-bold text-midnight dark:text-white hidden sm:inline tracking-tight">MuHaven</span>
      </router-link>

      <!-- Nav items (hidden on mobile — MMobileTabBar handles it).
           Active state mirrors Sidebar.vue's gold-pill spec — same
           visual language across desktop and mobile chrome. The
           Apply item's off-route attention signal is just the gold
           icon + pulsed dot (no bold weight, no border) so it
           doesn't compete with whichever route is actually
           selected. -->
      <div class="hidden md:flex items-center gap-1">
        <router-link
          v-if="showOnboardingNav"
          to="/apply-issuer"
          data-testid="topnav-nav-apply"
          :class="cn(
            'relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-sans transition-colors duration-200',
            route.path === '/apply-issuer'
              ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal font-semibold'
              : 'text-cool font-medium hover:bg-mist dark:hover:bg-midnight-mid hover:text-midnight dark:hover:text-white',
          )"
        >
          <span class="relative inline-flex">
            <FileSignature
              :size="16"
              :stroke-width="1.8"
              :class="route.path === '/apply-issuer' ? 'text-compute dark:text-signal' : 'text-gold dark:text-signal'"
            />
            <span
              v-if="route.path !== '/apply-issuer'"
              aria-hidden="true"
              :class="cn(
                'absolute -top-0.5 -right-0.5 inline-flex h-1.5 w-1.5 rounded-full',
                onboardingNavIsActionable
                  ? 'bg-gold animate-pulse'
                  : 'bg-gold/70',
              )"
            />
          </span>
          <span>{{ onboardingNavLabel }}</span>
        </router-link>

        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          :class="cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-sans transition-colors duration-200',
            route.path === item.path
              ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal font-semibold'
              : 'text-cool font-medium hover:bg-mist dark:hover:bg-midnight-mid hover:text-midnight dark:hover:text-white',
          )"
        >
          <component
            :is="item.icon"
            :size="16"
            :stroke-width="1.8"
            :class="route.path === item.path ? 'text-compute dark:text-signal' : ''"
          />
          <span>{{ item.label }}</span>
        </router-link>
      </div>

      <div class="flex-1" />

      <div class="flex items-center gap-2">
        <!-- ADR-023 dev-mode pill — TopNav is mobile-only (`class="md:hidden"`
             on the App.vue mount), so this pill is the mobile counterpart
             of the desktop Sidebar bottom pill. -->
        <MDevModeBanner />

        <!-- Role toggle removed: role is chosen at login and can't be
             switched post-login. -->
        <MDarkToggle data-testid="nav-dark-toggle" />

        <!-- Wallet pill with status dot (desktop) — shown whenever wallet address is known -->
        <div
          v-if="authStore.walletAddress"
          class="hidden sm:flex items-center gap-1.5 bg-mist dark:bg-midnight-mid rounded-lg border border-haze dark:border-white/8"
        >
          <button
            type="button"
            @click="copyAddress"
            data-testid="nav-wallet-pill"
            :data-full-address="authStore.walletAddress"
            :title="copied ? 'Copied!' : `Copy ${authStore.walletAddress}`"
            :aria-label="copied ? 'Address copied to clipboard' : `Copy smart account address ${authStore.walletAddress}`"
            class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-haze/60 dark:hover:bg-white/5 transition-colors rounded-l-lg"
          >
            <!-- Connection status dot -->
            <span
              v-if="connectionStatus === 'connecting'"
              class="flex items-center"
            >
              <Loader2 :size="12" class="animate-spin text-compute" />
            </span>
            <span
              v-else
              class="relative flex h-2 w-2"
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
            <Check v-if="copied" :size="12" class="text-positive" />
            <Copy v-else :size="12" class="text-cool/60" />
            <MSessionStatus data-testid="session-status" />
          </button>
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
            data-testid="nav-wallet-logout"
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
          data-testid="nav-wallet-signin"
          class="hidden sm:flex items-center gap-2 px-4 py-2 text-sm font-sans font-medium text-white bg-compute hover:bg-compute/90 rounded-lg transition-colors duration-200 cursor-pointer"
        >
          <LogIn :size="14" />
          Sign In
        </button>

        <!-- Mobile: compact wallet / sign-in -->
        <div class="flex sm:hidden items-center gap-1.5">
          <!-- Wallet known on mobile -->
          <template v-if="authStore.walletAddress">
            <button
              type="button"
              @click="copyAddress"
              :data-full-address="authStore.walletAddress"
              :title="copied ? 'Copied!' : `Copy ${authStore.walletAddress}`"
              :aria-label="copied ? 'Address copied to clipboard' : `Copy smart account address ${authStore.walletAddress}`"
              class="flex items-center gap-1.5 px-2.5 py-2 bg-mist dark:bg-midnight-mid rounded-lg border border-haze dark:border-white/8 cursor-pointer active:bg-haze/60 dark:active:bg-white/5 transition-colors"
            >
              <!-- Status dot -->
              <span
                v-if="connectionStatus === 'connecting'"
                class="flex items-center"
              >
                <Loader2 :size="10" class="animate-spin text-compute" />
              </span>
              <span
                v-else
                class="relative flex h-1.5 w-1.5"
              >
                <span
                  :class="[
                    'relative inline-flex rounded-full h-1.5 w-1.5',
                    connectionStatus === 'connected' ? 'bg-positive' : 'bg-gold',
                  ]"
                />
              </span>
              <span class="font-mono text-[10px] text-slate dark:text-cool">{{ displayAddress }}</span>
              <Check v-if="copied" :size="10" class="text-positive" />
              <Copy v-else :size="10" class="text-cool/60" />
              <MSessionStatus size="sm" />
            </button>
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
