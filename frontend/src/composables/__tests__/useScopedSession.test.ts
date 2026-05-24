/**
 * Wave 5 Option D · Commit 4 — `useScopedSession` shared state.
 *
 * Covers the load / revoke / dismiss transitions on the module-level
 * singleton. The API is mocked; we reset() the singleton between tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiStubs = vi.hoisted(() => ({
  getActiveScopedSession: vi.fn(),
  revokeScopedSession: vi.fn(),
}))

vi.mock('@/services/api', () => {
  class ApiError extends Error {
    status: number
    body: unknown
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`)
      this.status = status
      this.body = body
    }
  }
  return {
    ApiError,
    agentPolicyApi: {
      getActiveScopedSession: apiStubs.getActiveScopedSession,
      revokeScopedSession: apiStubs.revokeScopedSession,
    },
  }
})

import { useScopedSession } from '../useScopedSession'
import { ApiError } from '@/services/api'

function fakeSession(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    mode: 'scoped',
    surface: 'mcp',
    status: 'active',
    signerAddress: '0xabc',
    permissionId: '0xa2500760',
    maxPerOpUsd6: '100000000',
    totalSpentUsd6: '0',
    validUntilSec: Math.floor(Date.now() / 1000) + 3600,
    mintedAtSec: Math.floor(Date.now() / 1000) - 60,
    mintedAt: new Date().toISOString(),
    revokedAt: null,
    expiredAt: null,
    ...over,
  }
}

describe('useScopedSession', () => {
  beforeEach(() => {
    apiStubs.getActiveScopedSession.mockReset()
    apiStubs.revokeScopedSession.mockReset()
    useScopedSession().reset()
  })

  it('refresh() stores a fetched active session', async () => {
    const s = fakeSession()
    apiStubs.getActiveScopedSession.mockResolvedValue({ session: s })
    const { session, refresh } = useScopedSession()
    await refresh()
    expect(apiStubs.getActiveScopedSession).toHaveBeenCalledWith({ surface: 'mcp' })
    expect(session.value?.sessionId).toBe('s1')
  })

  it('refresh() stores null when none active', async () => {
    apiStubs.getActiveScopedSession.mockResolvedValue({ session: null })
    const { session, refresh } = useScopedSession()
    await refresh()
    expect(session.value).toBeNull()
  })

  it('refresh() swallows an API error into session=null + records error', async () => {
    apiStubs.getActiveScopedSession.mockRejectedValue(new ApiError(401, null))
    const { session, error, refresh } = useScopedSession()
    await refresh()
    expect(session.value).toBeNull()
    expect(error.value).toContain('401')
  })

  it('revoke() clears the session and arms the broker-purge reminder', async () => {
    const s = fakeSession()
    apiStubs.getActiveScopedSession.mockResolvedValue({ session: s })
    apiStubs.revokeScopedSession.mockResolvedValue({
      session: { ...s, status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    const { session, refresh, revoke, pendingBrokerPurge } = useScopedSession()
    await refresh()
    expect(session.value).not.toBeNull()
    await revoke('s1')
    expect(apiStubs.revokeScopedSession).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(session.value).toBeNull()
    expect(pendingBrokerPurge.value).toEqual({
      sessionId: 's1',
      revokedAt: '2026-05-24T01:00:00.000Z',
    })
  })

  it('revoke() re-throws so the caller can surface the error; no purge armed', async () => {
    apiStubs.revokeScopedSession.mockRejectedValue(new ApiError(409, { message: 'already inactive' }))
    const { revoke, pendingBrokerPurge } = useScopedSession()
    await expect(revoke('s1')).rejects.toBeInstanceOf(ApiError)
    expect(pendingBrokerPurge.value).toBeNull()
  })

  it('refresh() that loads a NEW active session clears a pending broker-purge (re-mint after revoke)', async () => {
    // C4 re-smoke issue 3 — revoke (purge armed) → mint a new key → the
    // refresh that picks up the new session must drop the stale purge
    // reminder so the active-session banner shows instead of the revoked
    // strip (showPurgeReminder wins over showActiveBanner otherwise).
    const s = fakeSession()
    apiStubs.revokeScopedSession.mockResolvedValue({
      session: { ...s, status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    const { session, refresh, revoke, pendingBrokerPurge } = useScopedSession()
    await revoke('s1')
    expect(pendingBrokerPurge.value).not.toBeNull()

    // A fresh session is minted + the banner/page re-reads the mirror.
    apiStubs.getActiveScopedSession.mockResolvedValue({
      session: fakeSession({ sessionId: 's2' }),
    })
    await refresh()
    expect(session.value?.sessionId).toBe('s2')
    expect(pendingBrokerPurge.value).toBeNull()
  })

  it('refresh() with NO active session leaves a pending broker-purge intact', async () => {
    // The normal post-revoke state: still no session, so the purge reminder
    // must persist across navigation re-fetches until dismissed/re-minted.
    const s = fakeSession()
    apiStubs.revokeScopedSession.mockResolvedValue({
      session: { ...s, status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    const { refresh, revoke, pendingBrokerPurge } = useScopedSession()
    await revoke('s1')
    expect(pendingBrokerPurge.value).not.toBeNull()

    apiStubs.getActiveScopedSession.mockResolvedValue({ session: null })
    await refresh()
    expect(pendingBrokerPurge.value).not.toBeNull()
  })

  it('drops an in-flight refresh result if a revoke lands first (epoch guard)', async () => {
    // Frontend-review LOW: a refresh() already in flight when revoke()
    // completes must NOT apply its stale pre-revoke snapshot — otherwise it
    // would resurrect the revoked session + wipe the just-armed purge. The
    // kill-switch must win the race.
    let resolveGet!: (v: unknown) => void
    apiStubs.getActiveScopedSession.mockReturnValue(
      new Promise((res) => {
        resolveGet = res
      }),
    )
    apiStubs.revokeScopedSession.mockResolvedValue({
      session: { ...fakeSession(), status: 'revoked', revokedAt: '2026-05-24T01:00:00.000Z' },
    })
    const { session, refresh, revoke, pendingBrokerPurge } = useScopedSession()

    const refreshPromise = refresh() // in-flight, awaiting resolveGet
    await revoke('s1') // bumps the epoch, sets session=null + arms purge
    expect(session.value).toBeNull()
    expect(pendingBrokerPurge.value).not.toBeNull()

    // The stale pre-revoke fetch resolves LATE with an active session.
    resolveGet({ session: fakeSession({ sessionId: 's1' }) })
    await refreshPromise
    // Result dropped — revoked state preserved.
    expect(session.value).toBeNull()
    expect(pendingBrokerPurge.value).not.toBeNull()
  })

  it('dismissBrokerPurge() clears the reminder', async () => {
    const s = fakeSession()
    apiStubs.revokeScopedSession.mockResolvedValue({ session: { ...s, status: 'revoked', revokedAt: null } })
    const { revoke, pendingBrokerPurge, dismissBrokerPurge } = useScopedSession()
    await revoke('s1')
    expect(pendingBrokerPurge.value).not.toBeNull()
    dismissBrokerPurge()
    expect(pendingBrokerPurge.value).toBeNull()
  })
})
