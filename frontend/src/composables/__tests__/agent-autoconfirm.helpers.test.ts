import { describe, it, expect } from 'vitest'
import { shouldAutoConfirmScopedTrade } from '../agent-autoconfirm.helpers'
import type { ActionDescriptor, ScopedSessionResponseDto } from '@/services/api'

const NOW = 1_900_000_000_000 // fixed clock (ms)

function session(overrides: Partial<ScopedSessionResponseDto> = {}): ScopedSessionResponseDto {
  return {
    // Only the fields isSessionLive reads matter; cast the rest.
    status: 'active',
    validUntilSec: Math.floor(NOW / 1000) + 3600, // 1h out → live
    ...overrides,
  } as ScopedSessionResponseDto
}

function action(
  kind: ActionDescriptor['kind'],
  preview: Record<string, unknown> = {},
): Pick<ActionDescriptor, 'kind' | 'preview'> {
  return { kind, preview }
}

describe('shouldAutoConfirmScopedTrade', () => {
  it('auto-confirms a buy with a live Scoped session', () => {
    expect(shouldAutoConfirmScopedTrade(action('buy'), session(), NOW)).toBe(true)
  })

  it('auto-confirms a rebalance (sell path) with a live session', () => {
    expect(shouldAutoConfirmScopedTrade(action('rebalance'), session(), NOW)).toBe(true)
  })

  it('does NOT auto-confirm non-trade kinds even with a live session', () => {
    for (const k of ['claim', 'set_policy', 'pause', 'resume', 'unpause_token', 'distribute_yield'] as const) {
      expect(shouldAutoConfirmScopedTrade(action(k), session(), NOW)).toBe(false)
    }
  })

  it('does NOT auto-confirm without a session', () => {
    expect(shouldAutoConfirmScopedTrade(action('buy'), null, NOW)).toBe(false)
  })

  it('does NOT auto-confirm an expired session', () => {
    const expired = session({ validUntilSec: Math.floor(NOW / 1000) - 1 })
    expect(shouldAutoConfirmScopedTrade(action('buy'), expired, NOW)).toBe(false)
  })

  it('does NOT auto-confirm a non-active session', () => {
    const revoked = session({ status: 'revoked' as ScopedSessionResponseDto['status'] })
    expect(shouldAutoConfirmScopedTrade(action('buy'), revoked, NOW)).toBe(false)
  })

  it('does NOT auto-confirm a Telegram-linked buy (SSE flow owns it)', () => {
    const tg = action('buy', { openClawIntentId: 'intent_abc123' })
    expect(shouldAutoConfirmScopedTrade(tg, session(), NOW)).toBe(false)
  })

  it('auto-confirms a buy whose openClawIntentId is empty/absent', () => {
    expect(shouldAutoConfirmScopedTrade(action('buy', { openClawIntentId: '' }), session(), NOW)).toBe(true)
  })
})
