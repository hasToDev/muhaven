<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
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
    <main :class="showChrome ? 'md:pl-64' : ''">
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
        class="relative z-40 max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12"
      >
        <div :class="hasRightRail ? 'xl:mr-80' : ''">
          <ScopedSessionBanner />
        </div>
      </div>
      <router-view v-slot="{ Component, route: viewRoute }">
        <transition name="page" mode="out-in">
          <div
            :key="viewRoute.path"
            :class="[
              viewRoute.meta.layout === 'landing' || viewRoute.meta.layout === 'login'
                ? ''
                : viewRoute.meta.layout === 'agent'
                  ? 'max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12 pt-8 pb-3'
                  : 'max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12 pt-8 pb-28 md:pb-16',
            ]"
          >
            <component :is="Component" />
          </div>
        </transition>
      </router-view>
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
