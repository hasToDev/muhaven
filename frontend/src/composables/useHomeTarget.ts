import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function useHomeTarget() {
  const auth = useAuthStore()
  return computed(() => {
    if (!auth.isAuthenticated) return '/'
    if (auth.role === 'issuer') {
      // Phase 9.A · Expansion (F2). Unapproved issuers' home is the
      // wizard, not /tokens — clicking the logo would otherwise hit
      // the router guard and bounce. Skip the round-trip.
      return auth.issuerStatus === 'approved' ? '/tokens' : '/apply-issuer'
    }
    return '/portfolio'
  })
}
