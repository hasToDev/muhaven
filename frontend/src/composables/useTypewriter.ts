import { ref, onUnmounted } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'

export function useTypewriter(text: string, speed = 45, delay = 0) {
  const displayed = ref('')
  const isDone = ref(false)
  const target = ref<HTMLElement | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let started = false

  const { stop } = useIntersectionObserver(
    target,
    ([{ isIntersecting }]) => {
      if (isIntersecting && !started) {
        started = true
        delayTimer = setTimeout(() => {
          let i = 0
          timer = setInterval(() => {
            if (i < text.length) {
              displayed.value = text.slice(0, i + 1)
              i++
            } else {
              if (timer) clearInterval(timer)
              isDone.value = true
            }
          }, speed)
        }, delay)
      }
    },
    { threshold: 0.3 },
  )

  onUnmounted(() => {
    stop()
    if (delayTimer) clearTimeout(delayTimer)
    if (timer) clearInterval(timer)
  })

  return { displayed, isDone, target }
}
