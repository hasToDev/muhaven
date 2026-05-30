<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { useElementSize } from '@vueuse/core'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAgentStore } from '@/stores/agent'
import TopNav from '@/components/TopNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import MMeshGradient from '@/components/ui/MMeshGradient.vue'
import MMobileTabBar from '@/components/ui/MMobileTabBar.vue'
import AgentFAB from '@/components/agent/AgentFAB.vue'
import AgentSidePanel from '@/components/agent/AgentSidePanel.vue'
import ScopedSessionBanner from '@/components/agent/ScopedSessionBanner.vue'
import LinkTelegramModal from '@/components/agent/LinkTelegramModal.vue'
import MToastProvider from '@/components/ui/MToastProvider.vue'
import type { TelegramLinkIssueResponse } from '@/services/api'

const route = useRoute()
const store = useAppStore()
const agentStore = useAgentStore()

// Q4 Part B (2026-05-15) — global LinkTelegramModal mount. When the
// HavenBot fires `muhaven_link_telegram` from either the /agent page
// or the AgentSidePanel, the chat composable populates
// `pendingTelegramLink`. App.vue owns the modal lifecycle so the user
// sees the QR + tap-link regardless of which surface they're on.
const activeTelegramLink = ref<TelegramLinkIssueResponse | null>(null)
watch(
  () => agentStore.pendingTelegramLink,
  (v) => {
    if (v && !activeTelegramLink.value) {
      activeTelegramLink.value = agentStore.consumePendingTelegramLink()
    }
  },
  { deep: true },
)
function onTelegramLinkClose() {
  activeTelegramLink.value = null
}

const isLandingPage = computed(() => route.path === '/' || route.meta.layout === 'landing')
const isLoginPage = computed(() => route.meta.layout === 'login')
const showChrome = computed(() => !isLandingPage.value && !isLoginPage.value)

// Wave 5 Option D · C4 re-smoke OPEN-B — routes that pin an `xl:fixed
// xl:right-0 xl:w-80 xl:z-30` wallet/actions aside and reserve `xl:mr-80`
// on their content column (CashPage / TradePage / AgentPage). On those
// pages the global ScopedSessionBanner must mirror the SAME `xl:mr-80`
// reservation, else its full content-width strip extends UNDER the fixed
// aside (covering "Your Wallet" / the QR). Exact-path match on purpose:
// `/agent/policy/transition` + `/agent/onboarding` are separate components
// with NO right aside, so a `startsWith('/agent')` would over-reserve there.
// Keep in lockstep with the `xl:fixed` asides — grep `xl:fixed xl:right-0`.
const RIGHT_RAIL_PATHS = new Set<string>(['/cash', '/trade', '/agent'])
const hasRightRail = computed(() => RIGHT_RAIL_PATHS.has(route.path))

// WS-1 (PERF_RPC_ROUTEGUARD_PLAN.md) — pages cached across navigation by
// <keep-alive>. D1 scope: Cash + Portfolio only (the rapid-nav RPC-429 hot
// path). Matched by component `name` (set via defineOptions in each page).
// Each page moves its mount-time fetch + polling-watcher arming to
// onActivated/onDeactivated, so a backgrounded page stops polling and a
// re-visit reactivates instantly (no re-mount, no re-fetch storm, no loader
// flash) instead of re-storming the rate-limited public RPC.
const KEEP_ALIVE_PAGES = ['PortfolioPage', 'CashPage']

// Layout padding for the STABLE content wrapper below. The wrapper used to be
// a per-route `:key`-ed div inside the transition; keeping it keyed would
// destroy+recreate it on every nav and evict the keep-alive cache with it. A
// single stable wrapper whose class tracks the current route's layout keeps
// the cache alive. Mirrors the previous inline class ladder exactly.
const contentWrapperClass = computed(() => {
  const layout = route.meta.layout
  if (layout === 'landing' || layout === 'login') return ''
  if (layout === 'agent') return 'max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12 pt-8 pb-3'
  return 'max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12 pt-8 pb-28 md:pb-16'
})

// Wave 5 Option D · C4 re-smoke — the global banner is a normal-flow strip
// ABOVE <router-view>. On the viewport-locked `/agent` page (its chat column
// is `height: calc(100vh - 2.75rem - …)`) the banner's added height would push
// the chat input below the fold. Measure the banner wrapper's rendered height
// and publish it as the `--scoped-banner-h` CSS var on <main>; AgentPage's
// column subtracts it so the input stays visible whether or not the banner
// shows. Collapses to 0 (→ `0px`) when no banner is rendered; tracks the
// collapse transition live so the column resizes smoothly.
const bannerWrapEl = ref<HTMLElement | null>(null)
const { height: bannerHeight } = useElementSize(bannerWrapEl)

// Phase 9.A · role guardrail. The role is the wallet's stored role
// (server-side source of truth, hydrated by `useAuth.initialize` from
// the JWT) — NOT a function of the current URL. The legacy
// path-watcher used to flip `appStore.role` whenever an issuer
// navigated to `/cash` (which is in the dual-role investor/issuer
// route set), causing the sidebar to re-render with the wrong nav
// items. Removed entirely; the route guard in `router/index.ts`
// already redirects cross-role pasted URLs.
//
// Skeleton-loading on navigation is preserved as a tiny side-effect
// of every path change.
watch(
  () => route.path,
  () => {
    store.startLoading()
    store.stopLoading()
  },
  { immediate: true },
)

onMounted(() => {
  store.initDark()
})
</script>

<template>
  <div
    :class="[
      'min-h-screen font-sans transition-colors duration-300',
      store.isDark ? 'bg-midnight text-white' : 'bg-frost text-midnight',
    ]"
  >
    <MMeshGradient />
    <!-- ADR-023 dev-mode pill renders inside Sidebar.vue (bottom of the
         desktop chrome) and TopNav.vue (mobile header). The previous
         viewport-fixed banner shifted page layout by ~40px and made
         the chrome feel under construction. -->
    <Sidebar v-if="showChrome" />
    <!-- Mobile top bar: only shows on <md; desktop nav lives in Sidebar -->
    <TopNav v-if="showChrome" class="md:hidden" />
    <main
      :class="showChrome ? 'md:pl-64' : ''"
      :style="{ '--scoped-banner-h': `${bannerHeight}px` }"
    >
      <!-- Wave 5 Option D · Commit 4 — dashboard banner for an active
           Scoped (agent-autonomy) session. The OUTER wrapper matches the
           router-view content wrapper EXACTLY (`max-w-7xl mx-auto px-…`) so
           the banner's left edge always aligns with the page content below
           it. No vertical padding: the banner self-hides (the common case —
           no active session) and a top margin would leave a white gap, so
           the visible strip sits flush at the top of the content area and
           owns its own bottom margin; when hidden the wrapper collapses to
           zero height → no layout shift.

           C4 re-smoke OPEN-B fix — the INNER wrapper carries `xl:mr-80` on
           the right-rail routes (CashPage / TradePage / AgentPage). Those
           pages reserve the same `xl:mr-80` on their content column and pin
           an `xl:fixed xl:right-0 xl:w-80 xl:z-30` aside; without the matching
           reservation the full-width banner ran UNDER that aside (covering
           "Your Wallet" / the QR), and the previous `z-40` only made it paint
           ON TOP. Mirroring the content reservation keeps the banner inside
           the content column so it never overlaps the aside — the right lever
           is layout, not z-index. `relative z-40` is retained only to keep
           the strip above the ambient mesh-gradient backdrop. -->
      <div
        v-if="showChrome"
        ref="bannerWrapEl"
        class="relative z-40 max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12"
      >
        <div :class="hasRightRail ? 'xl:mr-80' : ''">
          <ScopedSessionBanner />
        </div>
      </div>
      <!-- Stable layout wrapper: the max-width + padding live HERE (reactive to
           the current route's layout) rather than on a per-nav keyed div, so
           <keep-alive> can cache PortfolioPage / CashPage without the wrapper
           teardown evicting the cache. Per-page enter/leave still animates via
           the transition + the component's own `:key`. WS-1 in
           development/DEV_WAVE_5/PERF_RPC_ROUTEGUARD_PLAN.md. -->
      <div :class="contentWrapperClass">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <keep-alive :include="KEEP_ALIVE_PAGES">
              <!-- No `:key` — keep-alive then caches by component type (the
                   canonical pattern). Each route is a distinct component, so
                   the transition still fires on type change; a path key would
                   only add a needless cached-instance swap and risk a future
                   param route fragmenting the cache. -->
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </div>
    </main>
    <template v-if="showChrome">
      <AgentFAB />
      <MMobileTabBar />
    </template>
    <AgentSidePanel />
    <!-- Q4 Part B — global LinkTelegramModal mount triggered by the
         HavenBot `muhaven_link_telegram` tool result. Pre-seeded with
         the LLM-minted code so the modal doesn't re-issue. -->
    <LinkTelegramModal
      v-if="activeTelegramLink"
      :prefetched="activeTelegramLink"
      @close="onTelegramLinkClose"
    />
    <MToastProvider />
  </div>
</template>
