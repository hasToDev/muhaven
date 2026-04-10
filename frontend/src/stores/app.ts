import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const isDark = ref(false)
  const role = ref<'investor' | 'issuer'>('investor')
  const isLoading = ref(false)
  const agentPanelOpen = ref(false)

  function toggleDark() {
    isDark.value = !isDark.value
    document.documentElement.classList.toggle('dark', isDark.value)
    document.documentElement.classList.toggle('light', !isDark.value)
    localStorage.setItem('muhaven-dark', isDark.value ? '1' : '0')
  }

  function initDark() {
    const saved = localStorage.getItem('muhaven-dark')
    if (saved === '1') {
      isDark.value = true
      document.documentElement.classList.add('dark')
      document.documentElement.classList.remove('light')
    }
  }

  function setRole(r: 'investor' | 'issuer') {
    role.value = r
  }

  function openAgentPanel() {
    agentPanelOpen.value = true
  }

  function closeAgentPanel() {
    agentPanelOpen.value = false
  }

  let loadingTimer: ReturnType<typeof setTimeout> | null = null

  function startLoading() {
    if (loadingTimer) clearTimeout(loadingTimer)
    isLoading.value = true
  }

  function stopLoading() {
    loadingTimer = setTimeout(() => {
      isLoading.value = false
    }, 600)
  }

  return {
    isDark, role, isLoading, agentPanelOpen,
    toggleDark, initDark, setRole,
    openAgentPanel, closeAgentPanel,
    startLoading, stopLoading,
  }
})
