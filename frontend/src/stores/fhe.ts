import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useFheStore = defineStore('fhe', () => {
  const isReady = ref(false)
  const isInitializing = ref(false)
  const error = ref<string | null>(null)
  /** Current encryption step: initTfhe → fetchKeys → pack → prove → verify */
  const currentStep = ref<string | null>(null)

  function setReady() {
    isReady.value = true
    isInitializing.value = false
    error.value = null
  }

  function setInitializing() {
    isInitializing.value = true
    error.value = null
  }

  function setError(msg: string) {
    error.value = msg
    isInitializing.value = false
  }

  function reset() {
    isReady.value = false
    isInitializing.value = false
    error.value = null
    currentStep.value = null
  }

  return {
    isReady,
    isInitializing,
    error,
    currentStep,
    setReady,
    setInitializing,
    setError,
    reset,
  }
})
