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
} from '@/services/api'

/**
 * Scoped sessions are hard-locked to the MCP-broker surface at mint time
 * (see PolicyTransitionPage `mintScopedSession`), so this composable only
 * ever reads `surface='mcp'`. Kept as a named constant rather than a
 * per-call parameter so the in-flight coalescing below can't be handed a
 * different surface than the fetch already in progress.
 */
const SCOPED_SURFACE = 'mcp' as const

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
 * Monotonic guard bumped on every revoke. A `refresh()` that was already
 * in-flight when a revoke lands snapshots the epoch at entry and DROPS its
 * result if the epoch advanced mid-fetch — otherwise a stale pre-revoke
 * `getActiveScopedSession` response could resurrect the just-revoked session
 * AND wipe the freshly-armed broker-purge reminder (the kill-switch must
 * win the race). Narrow window, but this is the security-critical path.
 */
let revokeEpoch = 0

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
  async function refresh(): Promise<void> {
    // Coalesce concurrent callers onto the same fetch so the second
    // `await` observes the resolved result, not a stale early-return.
    // (Surface is fixed to `mcp` — see SCOPED_SURFACE — so there's no
    // risk of a second caller awaiting a different-surface fetch.)
    if (inFlight) return inFlight
    loading.value = true
    error.value = null
    const epoch = revokeEpoch
    inFlight = (async () => {
      try {
        const { session: s } = await agentPolicyApi.getActiveScopedSession({
          surface: SCOPED_SURFACE,
        })
        // A revoke landed while this fetch was in flight — its result is a
        // stale pre-revoke snapshot; drop it so we don't clobber the
        // kill-switch's `session=null` + armed purge.
        if (epoch !== revokeEpoch) return
        session.value = s
        // A freshly-minted (re-armed) session supersedes any pending
        // broker-purge reminder from a PRIOR revoke: showing "you revoked,
        // stop your broker" alongside a live session is contradictory, and
        // the active-session banner is suppressed while a purge is pending
        // (`showPurgeReminder` wins). Clearing here flips the banner to the
        // active-session variant the moment the new session lands (C4
        // re-smoke — minting after a non-dismissed revoke left the stale
        // purge strip showing).
        if (s !== null) {
          pendingBrokerPurge.value = null
        }
      } catch (e) {
        // Same staleness guard on the error path — a revoke's state must
        // not be overwritten by a late-failing pre-revoke fetch.
        if (epoch !== revokeEpoch) return
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
    // Invalidate any refresh that started before this revoke so its stale
    // pre-revoke result can't resurrect the session / wipe the purge below.
    revokeEpoch++
    session.value = null
    // Clear any stale load error from a prior failed refresh() so a
    // consumer reading `{ error }` doesn't show a failure next to a
    // successful revoke (FE-R2 L-1).
    error.value = null
    pendingBrokerPurge.value = {
      sessionId,
      revokedAt: res.session.revokedAt ?? new Date().toISOString(),
    }
  }

  /**
   * Wave 5 Slice 2c — flip the auto-reinvest opt-in on the active session.
   * Updates the SHARED `session` ref from the backend's returned row so the
   * Autonomy toggle (and any other reader) reflects the committed state
   * without a re-fetch. Re-throws on failure so the page can surface the
   * API error + roll back its optimistic switch.
   */
  async function setReinvest(enabled: boolean): Promise<void> {
    const { session: s } = await agentPolicyApi.setReinvestEnabled({ enabled })
    // Only adopt the returned row if it's still the active session we're
    // showing (defends against a revoke landing mid-toggle — the kill-switch
    // must win, same posture as `refresh`'s revokeEpoch guard). If the active
    // session changed / vanished under us, THROW so the caller rolls back its
    // optimistic switch + surfaces an error rather than a misleading success
    // for a toggle that didn't durably apply to the visible session.
    if (!session.value || session.value.sessionId !== s.sessionId) {
      throw new Error('active session changed during the toggle — not applied')
    }
    session.value = s
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
    setReinvest,
    dismissBrokerPurge,
    reset,
  }
}
