import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  checkoutApi,
  type CheckoutSessionListItemDto,
  type CheckoutSessionStatus,
  type CheckoutStatsRange,
  type CheckoutStatsResponseDto,
  type WebhookEndpointListItemDto,
} from '@/services/api'

/**
 * Wave 4 §5 Path D — issuer-side checkout dashboard store.
 *
 * Holds sessions list (cursor-paginated, status-filtered), webhooks
 * registry, and stats. Mirrors the `useIssuerTokensStore` shape so the
 * pages can reuse the same loaded/loading/error pattern.
 *
 * Privacy invariants enforced upstream (backend NEVER surfaces
 * encPayload / full signingSecret); the store just plumbs the DTOs
 * to the components.
 */
export const useCheckoutStore = defineStore('checkout', () => {
  // ── Sessions ─────────────────────────────────────────────────────
  const sessions = ref<CheckoutSessionListItemDto[]>([])
  const nextCursor = ref<string | null>(null)
  const sessionsLoading = ref(false)
  const sessionsError = ref<string | null>(null)
  const sessionsFilter = ref<CheckoutSessionStatus | null>(null)

  const sessionDetail = ref<CheckoutSessionListItemDto | null>(null)
  const sessionDetailLoading = ref(false)
  const sessionDetailError = ref<string | null>(null)

  // ── Webhooks ─────────────────────────────────────────────────────
  const webhooks = ref<WebhookEndpointListItemDto[]>([])
  const webhooksLoading = ref(false)
  const webhooksError = ref<string | null>(null)

  // ── Stats ────────────────────────────────────────────────────────
  const stats = ref<CheckoutStatsResponseDto | null>(null)
  const statsLoading = ref(false)
  const statsError = ref<string | null>(null)
  const statsRange = ref<CheckoutStatsRange>('7d')

  const hasMore = computed(() => nextCursor.value !== null)

  async function loadSessions(opts: { reset?: boolean } = {}) {
    sessionsLoading.value = true
    sessionsError.value = null
    try {
      const cursor = opts.reset ? undefined : nextCursor.value ?? undefined
      const res = await checkoutApi.listSessions({
        cursor,
        status: sessionsFilter.value ?? undefined,
        limit: 20,
      })
      sessions.value = opts.reset
        ? res.sessions
        : [...sessions.value, ...res.sessions]
      nextCursor.value = res.nextCursor
    } catch (err) {
      sessionsError.value = err instanceof Error ? err.message : 'Failed to load sessions'
    } finally {
      sessionsLoading.value = false
    }
  }

  function setStatusFilter(status: CheckoutSessionStatus | null) {
    sessionsFilter.value = status
    sessions.value = []
    nextCursor.value = null
  }

  async function loadSessionDetail(sessionId: string) {
    sessionDetailLoading.value = true
    sessionDetailError.value = null
    sessionDetail.value = null
    try {
      const res = await checkoutApi.getSession(sessionId)
      sessionDetail.value = res.session
    } catch (err) {
      sessionDetailError.value = err instanceof Error ? err.message : 'Failed to load session'
    } finally {
      sessionDetailLoading.value = false
    }
  }

  async function loadWebhooks() {
    webhooksLoading.value = true
    webhooksError.value = null
    try {
      const res = await checkoutApi.listWebhooks()
      webhooks.value = res.endpoints
    } catch (err) {
      webhooksError.value = err instanceof Error ? err.message : 'Failed to load webhooks'
    } finally {
      webhooksLoading.value = false
    }
  }

  async function loadStats(range?: CheckoutStatsRange) {
    if (range) statsRange.value = range
    statsLoading.value = true
    statsError.value = null
    try {
      stats.value = await checkoutApi.getStats(statsRange.value)
    } catch (err) {
      statsError.value = err instanceof Error ? err.message : 'Failed to load stats'
    } finally {
      statsLoading.value = false
    }
  }

  /** Add a freshly-minted session to the top of the list — used by
   *  CheckoutLinkModal's success path so the new row appears without a
   *  full refetch. The list is newest-first so prepend is correct. */
  function prependSession(session: CheckoutSessionListItemDto) {
    sessions.value = [session, ...sessions.value]
  }

  /** Replace a webhook in-place after a successful disable / register so
   *  the list reflects the new state without a full refetch. */
  function updateWebhook(endpoint: WebhookEndpointListItemDto) {
    const idx = webhooks.value.findIndex((e) => e.endpointId === endpoint.endpointId)
    if (idx >= 0) {
      webhooks.value = [
        ...webhooks.value.slice(0, idx),
        endpoint,
        ...webhooks.value.slice(idx + 1),
      ]
    } else {
      webhooks.value = [endpoint, ...webhooks.value]
    }
  }

  /** Mark an endpoint disabled in the store after a successful disable
   *  call. Avoids a refetch round-trip on the common UI path. */
  function markWebhookDisabled(endpointId: string, disabledAt: string) {
    const idx = webhooks.value.findIndex((e) => e.endpointId === endpointId)
    if (idx < 0) return
    webhooks.value = [
      ...webhooks.value.slice(0, idx),
      { ...webhooks.value[idx], disabledAt },
      ...webhooks.value.slice(idx + 1),
    ]
  }

  function reset() {
    sessions.value = []
    nextCursor.value = null
    sessionsLoading.value = false
    sessionsError.value = null
    sessionsFilter.value = null
    sessionDetail.value = null
    sessionDetailLoading.value = false
    sessionDetailError.value = null
    webhooks.value = []
    webhooksLoading.value = false
    webhooksError.value = null
    stats.value = null
    statsLoading.value = false
    statsError.value = null
    statsRange.value = '7d'
  }

  return {
    sessions,
    nextCursor,
    sessionsLoading,
    sessionsError,
    sessionsFilter,
    hasMore,
    sessionDetail,
    sessionDetailLoading,
    sessionDetailError,
    webhooks,
    webhooksLoading,
    webhooksError,
    stats,
    statsLoading,
    statsError,
    statsRange,
    loadSessions,
    loadSessionDetail,
    loadWebhooks,
    loadStats,
    setStatusFilter,
    prependSession,
    updateWebhook,
    markWebhookDisabled,
    reset,
  }
})
