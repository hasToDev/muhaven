<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { cn } from '@/lib/utils'
import {
  PieChart, ShoppingCart, Undo2,
  Coins, Share2, Users, ClipboardCheck,
  Sparkles, Banknote, FileSignature, KeyRound,
  Store, Send, TrendingUp, Activity, CreditCard,
  LayoutGrid, X,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()

// Wave 6 Polish mobile round 3 — the mobile bar previously showed 6 role tabs
// and silently DROPPED the other 4 investor routes (Marketplace, Transfer,
// Yields, Activity) — unreachable on mobile (the mobile TopNav has no nav
// links). Now the bar carries a curated set of PRIMARY tabs plus a "More"
// button that opens a bottom sheet listing every remaining route, so the full
// nav is reachable. Lists mirror TopNav.vue / Sidebar.vue.
const investorNav = [
  { path: '/cash', icon: Banknote, label: 'Cash' },
  { path: '/portfolio', icon: PieChart, label: 'Portfolio' },
  { path: '/marketplace', icon: Store, label: 'Marketplace' },
  { path: '/trade', icon: ShoppingCart, label: 'Trade' },
  { path: '/transfer', icon: Send, label: 'Transfer' },
  { path: '/yields', icon: TrendingUp, label: 'Yields' },
  { path: '/redemptions', icon: Undo2, label: 'Redeem' },
  { path: '/activity', icon: Activity, label: 'Activity' },
  { path: '/agent/policy/transition', icon: KeyRound, label: 'Autonomy' },
  { path: '/agent', icon: Sparkles, label: 'Agent' },
]
const issuerNav = [
  { path: '/cash', icon: Banknote, label: 'Cash' },
  { path: '/tokens', icon: Coins, label: 'Tokens' },
  { path: '/distribute', icon: Share2, label: 'Distribute' },
  { path: '/checkout', icon: CreditCard, label: 'Checkout' },
  { path: '/investors', icon: Users, label: 'Investors' },
  { path: '/compliance', icon: ClipboardCheck, label: 'Compliance' },
  { path: '/agent', icon: Sparkles, label: 'Agent' },
]

// Primary bottom-bar routes (4) — the rest spill into the "More" sheet. Order
// preserved from the nav list. Four primary tabs + More = five comfortable
// slots at 411px (the previous six were cramped).
const INVESTOR_PRIMARY = ['/cash', '/portfolio', '/trade', '/agent']
const ISSUER_PRIMARY = ['/cash', '/tokens', '/distribute', '/agent']

// Unapproved issuers get the minimal onboarding set (gated from the dashboard
// routes by the router). Few enough items that no "More" sheet is needed.
const onboardingTabs = [
  { path: '/apply-issuer', icon: FileSignature, label: 'Apply' },
  { path: '/cash', icon: Banknote, label: 'Cash' },
  { path: '/agent', icon: Sparkles, label: 'Agent' },
]

const isUnapprovedIssuer = computed(
  () =>
    store.role === 'issuer'
    && authStore.issuerStatus !== 'approved'
    && authStore.issuerStatus !== 'suspended',
)

const fullNav = computed(() => (store.role === 'issuer' ? issuerNav : investorNav))
const primaryPaths = computed(() =>
  store.role === 'issuer' ? ISSUER_PRIMARY : INVESTOR_PRIMARY,
)

// Bottom-bar buttons (excludes the "More" button, added in the template).
const primaryTabs = computed(() => {
  if (isUnapprovedIssuer.value) return onboardingTabs
  const order = primaryPaths.value
  return fullNav.value
    .filter((i) => order.includes(i.path))
    .sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
})

// Show the "More" affordance (and sheet) only outside the onboarding set.
const showMore = computed(() => !isUnapprovedIssuer.value)

// Everything not pinned to the primary bar — surfaced in the sheet.
const moreItems = computed(() =>
  fullNav.value.filter((i) => !primaryPaths.value.includes(i.path)),
)

const sheetOpen = ref(false)
function openSheet() {
  sheetOpen.value = true
}
function closeSheet() {
  sheetOpen.value = false
}
function navigate(path: string) {
  sheetOpen.value = false
  router.push(path)
}

// "More" lights up when the active route lives in the sheet (not on the bar).
const moreActive = computed(() => moreItems.value.some((i) => i.path === route.path))
</script>

<template>
  <nav
    class="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-midnight border-t border-haze dark:border-white/8 pb-[env(safe-area-inset-bottom)]"
  >
    <div class="flex items-stretch px-2 py-2">
      <button
        v-for="tab in primaryTabs"
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

      <!-- "More" — opens the overflow sheet (Wave 6 Polish mobile round 3). -->
      <button
        v-if="showMore"
        data-testid="tabbar-nav-more"
        title="More"
        aria-label="More navigation"
        :aria-expanded="sheetOpen"
        :class="cn(
          'flex flex-1 min-w-0 flex-col items-center gap-1 px-1 py-2 rounded-xl transition-colors duration-200 cursor-pointer',
          moreActive
            ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal'
            : 'text-cool hover:text-midnight dark:hover:text-white',
        )"
        @click="openSheet"
      >
        <LayoutGrid :size="20" class="flex-shrink-0" aria-hidden="true" />
        <span class="text-[10px] font-medium max-w-full truncate">More</span>
      </button>
    </div>
  </nav>

  <!-- Overflow sheet — teleported to body so it layers above the bar (z-60 >
       z-50) and the page. MMobileTabBar is never inside <keep-alive>, so the
       Teleport has no relocation gotcha. -->
  <Teleport to="body">
    <Transition name="more-sheet">
      <div
        v-if="sheetOpen"
        class="fixed inset-0 z-[60] md:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="More navigation"
      >
        <div
          class="absolute inset-0 bg-midnight/50 backdrop-blur-sm"
          aria-hidden="true"
          @click="closeSheet"
        />
        <div
          class="more-sheet-panel absolute bottom-0 left-0 right-0
                 bg-white dark:bg-midnight border-t border-haze dark:border-white/10
                 rounded-t-2xl shadow-2xl
                 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <div class="flex items-center justify-between mb-4">
            <span class="font-sans text-sm font-semibold text-midnight dark:text-white tracking-tight">
              More
            </span>
            <button
              type="button"
              aria-label="Close"
              data-testid="tabbar-more-close"
              class="w-8 h-8 -mr-1 rounded-lg flex items-center justify-center text-cool hover:bg-mist dark:hover:bg-white/5 transition-colors cursor-pointer"
              @click="closeSheet"
            >
              <X :size="18" :stroke-width="2" />
            </button>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-for="item in moreItems"
              :key="item.path"
              :data-testid="`tabbar-more-${item.label.toLowerCase()}`"
              :aria-current="route.path === item.path ? 'page' : undefined"
              :class="cn(
                'flex flex-col items-center justify-center gap-1.5 py-3 px-1 rounded-xl transition-colors duration-200 cursor-pointer min-h-[72px]',
                route.path === item.path
                  ? 'bg-gold/12 dark:bg-signal/8 ring-1 ring-gold/35 dark:ring-signal/30 text-compute dark:text-signal'
                  : 'text-cool hover:bg-mist dark:hover:bg-white/5 hover:text-midnight dark:hover:text-white',
              )"
              @click="navigate(item.path)"
            >
              <component :is="item.icon" :size="22" :stroke-width="1.8" class="flex-shrink-0" aria-hidden="true" />
              <span class="text-[11px] font-medium text-center leading-tight max-w-full truncate">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Backdrop fades; panel slides up. Compositor-only (opacity/transform). */
.more-sheet-enter-active,
.more-sheet-leave-active {
  transition: opacity 0.2s ease;
}
.more-sheet-enter-active .more-sheet-panel,
.more-sheet-leave-active .more-sheet-panel {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.more-sheet-enter-from,
.more-sheet-leave-to {
  opacity: 0;
}
.more-sheet-enter-from .more-sheet-panel,
.more-sheet-leave-to .more-sheet-panel {
  transform: translateY(100%);
}

@media (prefers-reduced-motion: reduce) {
  .more-sheet-enter-active,
  .more-sheet-leave-active,
  .more-sheet-enter-active .more-sheet-panel,
  .more-sheet-leave-active .more-sheet-panel {
    transition: none;
  }
}
</style>
