<script setup lang="ts">
import { Sun, Moon } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
</script>

<template>
  <button
    @click="store.toggleDark()"
    data-testid="nav-dark-toggle"
    class="p-2 rounded-lg text-cool hover:text-midnight dark:hover:text-white hover:bg-mist dark:hover:bg-midnight transition-colors duration-200 cursor-pointer"
    :title="store.isDark ? 'Switch to light mode' : 'Switch to dark mode'"
  >
    <Transition name="icon-rotate" mode="out-in">
      <Moon v-if="store.isDark" :size="18" key="moon" />
      <Sun v-else :size="18" key="sun" />
    </Transition>
  </button>
</template>

<style scoped>
.icon-rotate-enter-active,
.icon-rotate-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.icon-rotate-enter-from {
  opacity: 0;
  transform: rotate(-90deg) scale(0.8);
}
.icon-rotate-leave-to {
  opacity: 0;
  transform: rotate(90deg) scale(0.8);
}
</style>
