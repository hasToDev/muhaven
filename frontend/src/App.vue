<script setup lang="ts">
import { watch, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import TopNav from '@/components/TopNav.vue'
import MMeshGradient from '@/components/ui/MMeshGradient.vue'
import MMobileTabBar from '@/components/ui/MMobileTabBar.vue'
import AgentFAB from '@/components/agent/AgentFAB.vue'
import AgentSidePanel from '@/components/agent/AgentSidePanel.vue'
import MToastProvider from '@/components/ui/MToastProvider.vue'

const route = useRoute()
const store = useAppStore()

const investorPaths = ['/portfolio', '/deposit', '/yields', '/activity']
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
    <TopNav v-if="showChrome" />
    <main>
      <router-view v-slot="{ Component, route: viewRoute }">
        <transition name="page" mode="out-in">
          <div
            :key="viewRoute.path"
            :class="viewRoute.meta.layout === 'landing' || viewRoute.meta.layout === 'login'
              ? ''
              : 'max-w-screen-2xl mx-auto w-full px-6 sm:px-10 lg:px-16 xl:px-24 pt-10 pb-28 md:pb-32'"
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
