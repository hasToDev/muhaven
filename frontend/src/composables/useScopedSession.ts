/**
 * Wave 5 Option D · Commit 4 — shared reactive state for the user's
 * active Scoped (MCP-broker autonomy) session.
 *
 * The state is MODULE-LEVEL (singleton) on purpose: the dashboard banner
 * (mounted globally in App.vue) and the PolicyTransitionPage revoke zone
 * both read the SAME `session` ref, so a revoke on the page clears the
 * banner with no second fetch, and the post-revoke broker-purge reminder
 * survives in-SPA navigation until the operator dismisses it.
 *
 * Scoped sessions are always minted under `surface: 'mcp'` (hard-locked at
 * mint time), so the surface defaults to `'mcp'` everywhere here.
 */
import { ref } from 'vue'
import {
  agentPolicyApi,
  ApiError,
  type ScopedSessionResponseDto,
  type Surface,
} from '@/services/api'

const session = ref<ScopedSessionResponseDto | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/**
 * In-flight fetch promise. The banner (mounted in App.vue) and the policy
 * page BOTH call `refresh()` on mount; without coalescing, the second
 * caller's `await` would resolve immediately (a `loading` early-return)
 * and read stale `session` — which silently broke the page's tier-picker
 * collapse + the `?focus=revoke` deep-link (CR-R1 MEDIUM). Sharing the
 * promise makes both `await`s observe the SAME resolved fetch.
 */
let inFlight: Promise<void> | null = null

/**
 * Post-revoke reminder. The mirror flip to `status='revoked'` is only the
 * FIRST half of the kill-switch — the broker daemon still holds the
 * on-disk session key until the operator restarts it. This ref keeps the
 * "restart your broker" sticky panel alive across navigation until the
 * operator acknowledges (auto-clear on a broker IPC ack lands in a later
 * slice; today it's a manual dismiss).
 */
const pendingBrokerPurge = ref<{ sessionId: string; revokedAt: string } | null>(null)

export function useScopedSession() {
  /**
   * Fetch the latest active Scoped session. Swallows auth / network errors
   * into `session=null` (the banner just stays hidden) while recording
   * `error` for the page to optionally surface. Guards against concurrent
   * in-flight fetches.
   */
  async function refresh(opts?: { surface?: Surface }): Promise<void> {
    // Coalesce concurrent callers onto the same fetch so the second
    // `await` observes the resolved result, not a stale early-return.
    if (inFlight) return inFlight
    loading.value = true
    error.value = null
    inFlight = (async () => {
      try {
        const { session: s } = await agentPolicyApi.getActiveScopedSession({
          surface: opts?.surface ?? 'mcp',
        })
        session.value = s
      } catch (e) {
        // 401 (expired JWT) / network — treat as "no active session"; the
        // banner hides and the page can show a soft error if it wants.
        error.value =
          e instanceof ApiError
            ? `Could not load session (HTTP ${e.status})`
            : e instanceof Error
              ? e.message
              : 'Could not load session'
        session.value = null
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /**
   * Revoke the active session by id. On success, clears `session` (so the
   * banner disappears immediately) and arms the broker-purge reminder.
   * Re-throws on failure so the caller can surface the API error inline
   * (e.g. a 409 "already inactive").
   */
  async function revoke(sessionId: string): Promise<void> {
    const res = await agentPolicyApi.revokeScopedSession({ sessionId })
    session.value = null
    pendingBrokerPurge.value = {
      sessionId,
      revokedAt: res.session.revokedAt ?? new Date().toISOString(),
    }
  }

  function dismissBrokerPurge(): void {
    pendingBrokerPurge.value = null
  }

  /** Test-only / logout helper — drops all shared state. */
  function reset(): void {
    session.value = null
    loading.value = false
    error.value = null
    pendingBrokerPurge.value = null
    inFlight = null
  }

  return {
    session,
    loading,
    error,
    pendingBrokerPurge,
    refresh,
    revoke,
    dismissBrokerPurge,
    reset,
  }
}
