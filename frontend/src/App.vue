<script setup lang="ts">
import { watch, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import TopNav from '@/components/TopNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import MMeshGradient from '@/components/ui/MMeshGradient.vue'
import MMobileTabBar from '@/components/ui/MMobileTabBar.vue'
import AgentFAB from '@/components/agent/AgentFAB.vue'
import AgentSidePanel from '@/components/agent/AgentSidePanel.vue'
import MToastProvider from '@/components/ui/MToastProvider.vue'

const route = useRoute()
const store = useAppStore()

const investorPaths = [
  '/portfolio', '/marketplace', '/trade', '/buy', '/deposit', '/cash', '/wrap', '/transfer',
  '/yields', '/redemptions', '/activity',
]
const issuerPaths = ['/tokens', '/distribute', '/investors', '/compliance']

const isLandingPage = computed(() => route.path === '/' || route.meta.layout === 'landing')
const isLoginPage = computed(() => route.meta.layout === 'login')
const showChrome = computed(() => !isLandingPage.value && !isLoginPage.value)

watch(
  () => route.path,
  (path) => {
    if (investorPaths.includes(path)) store.setRole('investor')
    else if (issuerPaths.includes(path)) store.setRole('issuer')
    // Trigger skeleton loading on navigation
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
    <MToastProvider />
  </div>
</template>
