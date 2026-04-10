import { ref, type Ref } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'

export function useScrollAnimation(threshold = 0.15) {
  const target = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const isVisible = ref(false)

  useIntersectionObserver(
    target,
    ([{ isIntersecting }]) => {
      if (isIntersecting) {
        isVisible.value = true
      }
    },
    { threshold },
  )

  return { target, isVisible }
}
