import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function useHomeTarget() {
  const auth = useAuthStore()
  return computed(() => {
    if (!auth.isAuthenticated) return '/'
    return auth.role === 'issuer' ? '/tokens' : '/portfolio'
  })
}
