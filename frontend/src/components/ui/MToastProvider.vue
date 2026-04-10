<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import { useAppStore } from '@/stores/app'
import { computed } from 'vue'

const store = useAppStore()
const theme = computed(() => store.isDark ? 'dark' : 'light')
</script>

<template>
  <Toaster
    :theme="theme"
    position="bottom-right"
    :duration="4000"
    :style="{
      '--normal-bg': 'var(--color-midnight)',
      '--normal-text': '#FFFFFF',
      '--normal-border': 'var(--color-compute)',
      '--success-bg': 'var(--color-midnight)',
      '--success-text': 'var(--color-signal)',
      '--error-bg': 'var(--color-midnight)',
      '--error-text': 'var(--color-negative)',
    }"
  />
</template>
