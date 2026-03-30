<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { COLORS } from '@/data/constants'
import TopNav from '@/components/TopNav.vue'
import ChatBar from '@/components/ChatBar.vue'

const route = useRoute()
const role = ref<'investor' | 'issuer'>('investor')

const investorPaths = ['/portfolio', '/deposit', '/yields', '/activity']
const issuerPaths = ['/tokens', '/distribute', '/investors', '/compliance']

watch(
  () => route.path,
  (path) => {
    if (investorPaths.includes(path)) role.value = 'investor'
    else if (issuerPaths.includes(path)) role.value = 'issuer'
  },
  { immediate: true },
)
</script>

<template>
  <div
    :style="{
      minHeight: '100vh',
      background: COLORS.bgPrimary,
      fontFamily: `'Source Sans 3', -apple-system, sans-serif`,
      color: COLORS.textPrimary,
    }"
  >
    <TopNav v-model:role="role" />
    <main :style="{ maxWidth: '1200px', margin: '0 auto', padding: '40px 48px 120px' }">
      <router-view />
    </main>
    <ChatBar />
  </div>
</template>
