import { useAppStore } from '@/stores/app'
import { computed } from 'vue'

export function useDarkMode() {
  const store = useAppStore()

  return {
    isDark: computed(() => store.isDark),
    toggleDark: () => store.toggleDark(),
  }
}
