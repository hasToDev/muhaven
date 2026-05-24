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
           Scoped (agent-autonomy) session. The wrapper carries ONLY
           horizontal padding (aligns with page content) + `relative z-40`.
           No vertical padding: the banner self-hides (the common case —
           no active session), and a top margin would leave a white gap
           above the strip, so the visible banner sits flush at the top of
           the content area (a clean top strip) and owns its own bottom
           margin. When hidden the wrapper collapses to zero height → no
           layout shift. `z-40` lifts the strip above per-page fixed asides
           (e.g. `/cash`'s `xl:fixed … z-30` wallet aside) so its CTA is
           always clickable. -->
      <div
        v-if="showChrome"
        class="relative z-40 max-w-7xl mx-auto w-full px-6 sm:px-10 lg:px-12"
      >
        <ScopedSessionBanner />
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
