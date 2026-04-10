import { ref, onMounted, onUnmounted, type Ref } from 'vue'

export interface ScrollRevealOptions {
  threshold?: number
  rootMargin?: string
  once?: boolean
}

export function useScrollReveal(options: ScrollRevealOptions = {}) {
  const { threshold = 0.15, rootMargin = '0px', once = true } = options
  const target = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const isVisible = ref(false)
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    if (!target.value) return
    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          isVisible.value = true
          if (once && observer && target.value) {
            observer.unobserve(target.value)
          }
        }
      },
      { threshold, rootMargin },
    )
    observer.observe(target.value)
  })

  onUnmounted(() => {
    observer?.disconnect()
  })

  return { target, isVisible }
}

/**
 * Create multiple scroll reveal refs for staggered children.
 * Returns an array of { target, isVisible } for each child.
 */
export function useStaggerReveal(count: number, options: ScrollRevealOptions = {}) {
  return Array.from({ length: count }, () => useScrollReveal(options))
}
