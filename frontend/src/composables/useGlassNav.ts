import { ref, onMounted, onUnmounted } from 'vue'

export function useGlassNav(threshold = 60) {
  const isScrolled = ref(false)

  function onScroll() {
    isScrolled.value = window.scrollY > threshold
  }

  onMounted(() => {
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  })

  onUnmounted(() => {
    window.removeEventListener('scroll', onScroll)
  })

  return { isScrolled }
}
