import {
  SubscriptionClient,
  // RedemptionQueueClient — not yet wired into agent claim path; see Wave 5 follow-up note.
} from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext } from '@/services/v35/context'
import { useFhe } from '@/composables/useFhe'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import type { ActionDescriptor } from '@/services/api'

const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60 // 1 year, mirrors TradePage

/**
 * Wave 4 P2 — runs an ActionDescriptor against the user's kernel.
 *
 * Mirrors the SDK + kernel + cofhe wiring already used by TradePage for
 * `buy` / `claim`. The agent ConfirmModal hands off the descriptor to
 * this runner; on success it returns the tx hash for the audit-commit
 * POST.
 *
 * Wave 5 follow-ups (informative):
 *  - `claim` currently routes through the existing redemption / yield-
 *    snapshot SDK clients via deep-link to /redemptions /yields; full
 *    in-modal SDK call lands when the agent surface gains its own
 *    progress UI.
 *  - `rebalance` is multi-leg; today the runner treats it as N sequential
 *    `buy`/`sell` SDK calls. Multicall wrapper is a Wave 5 SDK addition.
 *  - `set_policy` and `pause` are not on-chain yet; they invoke the
 *    existing /policy/transition + /policy/pause REST endpoints.
 */

export class AgentActionRunnerError extends Error {}

/**
 * Three-state result so ConfirmModal can decide whether to fire the
 * audit-commit POST:
 *   - `ok: true, txHash: string` → on-chain tx settled; commit fires.
 *   - `ok: 'deferred'` → action requires a follow-up step the agent
 *     surface doesn't own (e.g., /policy/transition page for tier
 *     transitions, or /yields for claim). Commit MUST NOT fire here —
 *     audit row would record a permit_granted for an action that hasn't
 *     happened. ConfirmModal shows a "Continue on /<path>" CTA instead.
 *   - `ok: false, error: string` → submission failed; surface error.
 *
 * `pause` is the special case — backend executed it at proposal time so
 * the runner returns `ok: true, txHash: null` and ConfirmModal commit
 * is the audit-narrative wrap-up (idempotent on backend).
 */
export type RunResult =
  | { ok: true; txHash: string | null }
  | { ok: 'deferred'; redirectTo: string; reason: string }
  | { ok: false; error: string }

export async function runAgentAction(action: ActionDescriptor): Promise<RunResult> {
  try {
    switch (action.kind) {
      case 'buy':
        return { ok: true, txHash: await runBuy(action) }
      case 'claim':
        // The redeem ceremony lives on /yields today — the agent
        // emits the descriptor; the user authorizes; then completes
        // the ceremony there. No commit fires from the modal because
        // the on-chain tx hasn't happened yet. Wave 5 brings the call
        // in-modal and flips this to ok: true.
        return {
          ok: 'deferred',
          redirectTo: '/yields',
          reason: 'Claim ceremony lives on /yields. Continue there to settle.',
        }
      case 'rebalance':
        // Wave 5 multi-leg.
        return {
          ok: false,
          error: 'Rebalance ceremony lands in Wave 5 — please use /trade for now.',
        }
      case 'set_policy':
        // /policy/transition owns the passkey-signed validator install.
        return {
          ok: 'deferred',
          redirectTo: '/portfolio',
          reason: 'Tier change requires a passkey signature on the policy page.',
        }
      case 'pause':
        // Backend already executed the pause at proposal time
        // (PauseToolUseCase → PauseAgentUseCase). Commit is the
        // audit-narrative wrap-up; idempotent on backend (pause_-prefixed
        // tokens fast-path through CommitToolActionUseCase).
        return { ok: true, txHash: null }
      default:
        return { ok: false, error: `Unknown action kind: ${(action as ActionDescriptor).kind}` }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Action failed.',
    }
  }
}

async function runBuy(action: ActionDescriptor): Promise<string> {
  if (action.kind !== 'buy') throw new AgentActionRunnerError('not a buy')
  if (isZeroAddress(v35Addresses.subscription)) {
    throw new AgentActionRunnerError('Subscription not deployed in this environment.')
  }

  const fhe = useFhe()
  await fhe.initialize?.()
  const tokenAddress = String(action.preview.tokenAddress) as `0x${string}`
  const shares = BigInt(String(action.preview.shares))
  const maxSharesHint = BigInt(String(action.preview.maxSharesHint))

  // Client-side mhUSDC balance gate. Backend's propose_buy checks
  // *presence* of cash-rail history (catches fresh wallets); the
  // *amount* check has to happen client-side because the mhUSDC
  // balance is FHE-encrypted on `MuHavenStable._balances[user]` and
  // only the user's permit can decrypt it. Without this gate, a
  // user with 5 mhUSDC asking for a 100 mhUSDC buy gets a
  // ConfirmModal, signs, pays gas, and the on-chain
  // Subscription.purchase reverts/silent-fails — wasted gas + ugly
  // UX. Surfaced 2026-05-09 from operator feedback.
  const estimatedTotalUsd6Raw = action.preview.estimatedTotalUsd6
  if (typeof estimatedTotalUsd6Raw === 'string' && /^\d+$/.test(estimatedTotalUsd6Raw)) {
    const needed = BigInt(estimatedTotalUsd6Raw)
    const { useWalletStore } = await import('@/stores/wallet')
    const { usePortfolioStore } = await import('@/stores/portfolio')
    const wallet = useWalletStore()
    const portfolio = usePortfolioStore()
    const walletAddress = wallet.address as `0x${string}` | null
    if (walletAddress) {
      // Decrypt the mhUSDC balance if we don't have a fresh value
      // already cached. The store's decryptPusdc() handles the cofhe
      // permit + handle-fetch in one call; no-ops if already decrypting.
      if (portfolio.pusdcConfidentialBalance === null) {
        try {
          await portfolio.decryptPusdc(walletAddress)
        } catch (err) {
          // Decrypt failure shouldn't block the buy — fall through
          // to the on-chain silent-fail path with a console warn so
          // operators can diagnose. Matches `decryptPusdc`'s own
          // failure semantics (cached null + error surfaced separately).
          console.warn('[runBuy] mhUSDC decrypt failed; proceeding without balance gate:', err)
        }
      }
      const have = portfolio.pusdcConfidentialBalance
      if (have !== null && have < needed) {
        const haveUsd = (Number(have) / 1_000_000).toFixed(2)
        const needUsd = (Number(needed) / 1_000_000).toFixed(2)
        throw new AgentActionRunnerError(
          `Insufficient mhUSDC balance: you have $${haveUsd} but this purchase needs $${needUsd}. Wrap more USDC into mhUSDC on the Cash page first.`,
        )
      }
    }
  }

  // Pre-flight operator grant — same posture as TradePage (idempotent
  // long-expiry). Wave 5 may cache the operator-set state across
  // surfaces; today we re-grant per session which is a single passkey
  // confirm at the cost of clarity.
  const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
  await MuHavenStableService.setOperator(v35Addresses.subscription, expiry)

  const ctx = await buildWriteContext()
  const sub = new SubscriptionClient(ctx, v35Addresses.subscription)
  const ephemeralEOA = fhe.getEphemeralEOA()
  if (!ephemeralEOA) {
    throw new AgentActionRunnerError('Ephemeral EOA missing — initialize FHE first.')
  }

  const hash = await sub.purchase(tokenAddress, shares, maxSharesHint, ephemeralEOA)
  return hash
}
