import { ref, type Ref } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'

export function useCountUp(
  endValue: number,
  duration = 1500,
  decimals = 0,
) {
  const target = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const displayValue = ref('0')
  let hasAnimated = false

  function animate() {
    if (hasAnimated) return
    hasAnimated = true

    const start = performance.now()

    function step(now: number) {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // Cubic ease-out
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = eased * endValue

      displayValue.value = current.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })

      if (progress < 1) {
        requestAnimationFrame(step)
      }
    }

    requestAnimationFrame(step)
  }

  useIntersectionObserver(
    target,
    ([{ isIntersecting }]) => {
      if (isIntersecting) animate()
    },
    { threshold: 0.3 },
  )

  return { target, displayValue }
}
