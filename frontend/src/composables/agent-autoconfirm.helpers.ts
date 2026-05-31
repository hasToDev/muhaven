/**
 * Scoped zero-prompt trading — the auto-confirm gate, extracted as a pure
 * function so the "when do we skip the manual ConfirmModal click" decision is
 * unit-tested in isolation (it auto-executes on-chain trades, so the gate is
 * safety-relevant and must not loosen by accident).
 *
 * AgentPage mounts the ConfirmModal then calls its `authorize()` when this
 * returns true — reusing the exact manual path (isExpired guard + runner +
 * audit-commit), so only the click is skipped, never a control.
 */
import { isSessionLive } from './scoped-session.helpers'
import type { ActionDescriptor, ScopedSessionResponseDto } from '@/services/api'

/**
 * True only when ALL hold:
 *   - the action is a TRADE — `buy`, or a sell/rebalance (HavenBot has no
 *     standalone `sell` kind; sells are proposed as a single-leg `rebalance`).
 *     Every other kind (claim, set_policy, pause/resume, issuer ops, checkout,
 *     cash deep-links) keeps the manual confirmation card.
 *   - it is NOT a Telegram-linked buy — those are driven by the SSE
 *     `intent_confirmed` flow + its fire-locks; auto-confirming here would
 *     double-fire the on-chain leg.
 *   - a LIVE Scoped session exists (status active + not expired) — the standing
 *     consent (cap + TTL) that authorizes prompt-free execution.
 */
export function shouldAutoConfirmScopedTrade(
  action: Pick<ActionDescriptor, 'kind' | 'preview'>,
  session: ScopedSessionResponseDto | null,
  nowMs: number,
): boolean {
  if (action.kind !== 'buy' && action.kind !== 'rebalance') return false
  const intentId = action.preview?.openClawIntentId
  if (typeof intentId === 'string' && intentId.length > 0) return false
  return isSessionLive(session, nowMs)
}
