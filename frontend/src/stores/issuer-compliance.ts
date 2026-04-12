import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as KYCService from '@/services/contracts/KYCService'
import { useIssuerInvestorsStore } from './issuer-investors'

export interface JurisdictionInfo {
  code: string
  name: string
  flag: string
  status: 'active' | 'review' | 'blocked'
  investors: number
}

export interface TrustedIssuerInfo {
  name: string
  address: string
  claims: number
  status: 'active' | 'inactive'
}

// Enriched display data — not on-chain, shown with "Preview Data" badge
const JURISDICTION_DISPLAY: JurisdictionInfo[] = [
  { code: 'US', name: 'United States', flag: '\u{1F1FA}\u{1F1F8}', status: 'active', investors: 23 },
  { code: 'EU', name: 'European Union', flag: '\u{1F1EA}\u{1F1FA}', status: 'active', investors: 15 },
  { code: 'UK', name: 'United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', status: 'active', investors: 6 },
  { code: 'SG', name: 'Singapore', flag: '\u{1F1F8}\u{1F1EC}', status: 'review', investors: 3 },
  { code: 'CN', name: 'China', flag: '\u{1F1E8}\u{1F1F3}', status: 'blocked', investors: 0 },
]

const TRUSTED_ISSUERS_DISPLAY: TrustedIssuerInfo[] = [
  { name: 'MuHaven Identity Service', address: '0xab12...cd34', claims: 78, status: 'active' },
  { name: 'Reineira KYC Oracle', address: '0xef56...gh78', claims: 45, status: 'active' },
]

export const useIssuerComplianceStore = defineStore('issuer-compliance', () => {
  const providerName = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  // Enriched display data (non-on-chain, shown with preview badge)
  const jurisdictions = ref<JurisdictionInfo[]>(JURISDICTION_DISPLAY)
  const trustedIssuers = ref<TrustedIssuerInfo[]>(TRUSTED_ISSUERS_DISPLAY)

  const kycGateConfig = computed(() => ({
    provider: providerName.value ?? 'ERC-3643 ONCHAINID',
    requiredLevel: 'Full KYC',
    autoReject: true,
    gracePeriodDays: 30,
  }))

  /**
   * Stats derived from loaded investor data.
   * Note: eligible/ineligible counts are based on currently loaded investors,
   * which may be a subset if pagination hasn't loaded all. The `total` field
   * uses on-chain investorCount() for accuracy.
   */
  const stats = computed(() => {
    const investorStore = useIssuerInvestorsStore()
    const allLoaded = !investorStore.hasMore
    return {
      totalVerified: investorStore.stats.eligible,
      pendingReview: investorStore.stats.ineligible,
      expiringSoon: 0, // Not available on-chain without expiry tracking
      blocked: 0, // Not available on-chain without block tracking
      isPartial: !allLoaded,
    }
  })

  async function load() {
    loading.value = true
    error.value = null

    try {
      // Read on-chain KYC provider name
      providerName.value = await KYCService.providerName()
      loaded.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load compliance data'
    } finally {
      loading.value = false
    }
  }

  function reset() {
    providerName.value = null
    loading.value = false
    error.value = null
    loaded.value = false
  }

  return {
    providerName,
    loading,
    error,
    loaded,
    jurisdictions,
    trustedIssuers,
    kycGateConfig,
    stats,
    load,
    reset,
  }
})
