import {
  SubscriptionClient,
  // RedemptionQueueClient — not yet wired into agent claim path; see Wave 5 follow-up note.
} from '@muhaven/sdk'
import type { Address, Hash } from 'viem'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext } from '@/services/v35/context'
import { useFhe } from '@/composables/useFhe'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import { resolveP7Tx, UnknownP7TxError } from '@/services/v35/p7-tx-abis'
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
      case 'set_policy': {
        // Wave 4 Q1 — /agent/policy/transition owns the passkey-bound tier
        // transition + session-key reveal flow (closes §3e⁶
        // F-dashboard-policy-route-missing). The descriptor's `preview`
        // carries the surface + targetTier the LLM proposed; the page
        // reads them off the query string + pre-fills the picker so the
        // HavenBot → ConfirmModal → page handoff is one click, not three.
        const surface = readPreviewString(action.preview, 'surface')
        const targetTier = readPreviewString(action.preview, 'targetTier')
        const params = new URLSearchParams()
        if (surface) params.set('surface', surface)
        if (targetTier) params.set('target', targetTier)
        const query = params.toString()
        return {
          ok: 'deferred',
          redirectTo: query
            ? `/agent/policy/transition?${query}`
            : '/agent/policy/transition',
          reason: 'Tier change continues on the agent policy page.',
        }
      }
      case 'pause':
        // Backend already executed the pause at proposal time
        // (PauseToolUseCase → PauseAgentUseCase). Commit is the
        // audit-narrative wrap-up; idempotent on backend (pause_-prefixed
        // tokens fast-path through CommitToolActionUseCase).
        return { ok: true, txHash: null }
      case 'create_checkout':
        // Wave 4 §5 Path C — server-side mint. The runner has no on-chain
        // work to do; the ConfirmModal calls
        // `checkoutAgentApi.commitCreateCheckout` directly inside its
        // committing branch and renders the returned URL on success.
        return { ok: true, txHash: null }
      case 'unpause_token':
      case 'kyc_add':
      case 'kyc_remove': {
        // Wave 4 P7 issuer-side propose tools. All three share the same
        // backend descriptor shape: `sdkCall.args.txs[]` carrying one or
        // two `(contract, address, fn, args)` tuples. dispatchActionTxs
        // returns the LAST tx hash so the audit-commit POST anchors to
        // the "completed-when" tx (operator pick 2026-05-19; kyc_add
        // tier-2 partial-revert surfaces a clear error so the issuer can
        // manually re-propose kyc_remove for rollback).
        const txHash = await dispatchActionTxs(action)
        // Invalidate the issuer-side caches so /tokens + /investors
        // re-fetch on the next visit. Without this, ConfirmModal closes
        // showing "Settled" but the issuer's /tokens page still renders
        // the pre-action snapshot (e.g. status=paused for a token we
        // just unpaused) until a manual reload. Mirrors the
        // invalidateIssuerCaches() pattern in ApplyPage.vue 2026-05-09.
        await invalidateIssuerCachesAfterP7Write()
        return { ok: true, txHash }
      }
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

/**
 * Tolerant `preview[key]` reader for redirect-target URL building. The
 * descriptor's `preview` is typed `Record<string, unknown>` (the LLM
 * proposes the shape; the type is intentionally permissive). Returns
 * undefined for anything not a non-empty string so a malformed payload
 * lands the user on the plain `/agent/policy/transition` page without
 * a broken querystring.
 */
function readPreviewString(
  preview: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = preview[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
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

/**
 * Wave 4 P7 — runtime-guarded shape for backend's `sdkCall.args.txs[]`.
 * The backend pins this shape via `propose-{unpause-token,kyc-add,
 * kyc-remove}.use-case.ts` + the p7-issuer-tools.test.ts C1+C2 asserts,
 * but the frontend's `ActionDescriptor.sdkCall.args` is typed
 * `Record<string, unknown>` (the descriptor union is intentionally
 * permissive so a future tool addition doesn't gate on a frontend
 * compile). The guard below is the runtime version of those backend
 * test asserts: if a future tool change drops the shape, the runner
 * errors clearly instead of silently calling viem with `undefined`.
 */
interface P7TxSpec {
  contract: string
  address: Address
  fn: string
  args: Record<string, unknown>
}

function isP7TxSpec(v: unknown): v is P7TxSpec {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    typeof t.contract === 'string' &&
    typeof t.address === 'string' &&
    /^0x[a-fA-F0-9]{40}$/.test(t.address) &&
    typeof t.fn === 'string' &&
    !!t.args &&
    typeof t.args === 'object'
  )
}

/**
 * Per-kind allowlist of legal `(contract, fn)` pairs.
 *
 * Closes Security review finding H-2 (2026-05-19): without this gate, a
 * malicious or drift-broken backend could mint a descriptor with
 * `kind: 'kyc_remove'` (which the user sees as "remove from whitelist"
 * in the ConfirmModal) but ship `txs: [{ fn: 'addToWhitelist', ... }]`.
 * `resolveP7Tx` would happily resolve the binding (it's in the ABI
 * map) so the kernel would sign an ADD while the user authorised a
 * REMOVE. This map binds each `action.kind` to the exact set of
 * `(contract, fn)` pairs the backend propose use-case is allowed to
 * mint — drift surfaces as a clear error before the kernel signs.
 *
 * Ordering within `txs[]` is NOT enforced here (the contract enforces
 * its own preconditions; e.g. `addToAccreditedList` standalone is a
 * no-harm op without a prior whitelist). Set membership is enough.
 */
const P7_ALLOWED_BY_KIND: Record<string, ReadonlySet<string>> = {
  unpause_token: new Set(['TokenRegistry:setPaused']),
  kyc_add: new Set([
    'ERC3643KYCAdapter:addToWhitelist',
    'ERC3643KYCAdapter:addToAccreditedList',
  ]),
  kyc_remove: new Set(['ERC3643KYCAdapter:removeFromWhitelist']),
}

/**
 * Resolve the expected `tx.address` for a given `(action.kind,
 * contract)` from the descriptor's action-hash-bound `preview` fields.
 *
 * Closes Security review finding H-1 (2026-05-19): `isP7TxSpec`
 * validates address SHAPE but not WHICH address. A malicious server
 * could ship `tx.address = 0xATTACKER` and the kernel would sign
 * a UserOp against the attacker's contract (most legs would revert
 * on `onlyAdmin` but the kernel still pays gas, and a sufficiently-
 * crafted look-alike contract could log the call). The preview's
 * `tokenRegistryAddress` / `kycAdapterAddress` ARE bound into the
 * propose-time action-hash (`ConfirmTokenService.consume` rejects
 * any commit whose hash drifts), so trusting them is safe — they're
 * cryptographically pinned to the user's confirm token.
 */
function expectedAddressFromPreview(
  action: ActionDescriptor,
  contract: string,
): Address {
  const preview = action.preview as Record<string, unknown>
  let raw: unknown
  if (contract === 'TokenRegistry') raw = preview.tokenRegistryAddress
  else if (contract === 'ERC3643KYCAdapter') raw = preview.kycAdapterAddress
  else {
    throw new AgentActionRunnerError(
      `No preview address binding for contract ${contract}`,
    )
  }
  if (typeof raw !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new AgentActionRunnerError(
      `ActionDescriptor (${action.kind}) preview missing valid ${contract} address`,
    )
  }
  return raw.toLowerCase() as Address
}

/**
 * Dispatch every tx in an issuer-side ActionDescriptor's
 * `sdkCall.args.txs` through the ZeroDev kernel sender, in order.
 *
 * Returns the LAST tx hash so the audit-commit POST records the
 * "completed-when" tx (operator pick 2026-05-19 over the first-tx
 * "audit-anchor" alternative). For kyc_add tier-2 specifically, this
 * means the audit log captures `addToAccreditedList`'s hash; if
 * `addToWhitelist` succeeds but `addToAccreditedList` reverts, the
 * runner throws mid-loop and the modal surfaces a clear error — the
 * issuer can then manually re-propose `kyc_remove` to roll back the
 * half-state (on-chain rollback isn't possible per-UserOp).
 *
 * Security gates (H-1 + H-2, 2026-05-19):
 *   - Per-tx `(contract, fn)` MUST be in P7_ALLOWED_BY_KIND[kind].
 *   - Per-tx `address` MUST equal the preview's pinned address
 *     for that contract (preview fields are action-hash-bound).
 */
async function dispatchActionTxs(action: ActionDescriptor): Promise<Hash> {
  const allowed = P7_ALLOWED_BY_KIND[action.kind]
  if (!allowed) {
    throw new AgentActionRunnerError(
      `No P7 dispatch allowlist for action kind ${action.kind}`,
    )
  }
  const rawArgs = action.sdkCall?.args as { txs?: unknown } | undefined
  const txs = rawArgs?.txs
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new AgentActionRunnerError(
      `ActionDescriptor (${action.kind}) is missing sdkCall.args.txs[]`,
    )
  }
  const ctx = await buildWriteContext()
  let lastTxHash: Hash | null = null
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]
    if (!isP7TxSpec(tx)) {
      throw new AgentActionRunnerError(
        `ActionDescriptor (${action.kind}) txs[${i}] has malformed shape`,
      )
    }
    // H-2: gate (contract, fn) by action.kind allowlist BEFORE looking
    // up the ABI binding. resolveP7Tx is permissive across kinds (the
    // ABI map only knows the function exists, not which kind may use
    // it); the allowlist is the kind→fn binding.
    const pairKey = `${tx.contract}:${tx.fn}`
    if (!allowed.has(pairKey)) {
      throw new AgentActionRunnerError(
        `ActionDescriptor (${action.kind}) txs[${i}] uses (${tx.contract}.${tx.fn}) which is not in the allowlist for this action kind`,
      )
    }
    // H-1: address must equal the action-hash-bound preview value.
    // Lowercased both sides — backend always emits lowercase but a
    // future bridge layer might mixed-case the field; equality stays.
    const expectedAddr = expectedAddressFromPreview(action, tx.contract)
    if ((tx.address as string).toLowerCase() !== expectedAddr) {
      throw new AgentActionRunnerError(
        `ActionDescriptor (${action.kind}) txs[${i}] address ${tx.address} does not match preview-pinned ${tx.contract} address ${expectedAddr}`,
      )
    }
    let binding
    try {
      binding = resolveP7Tx(tx.contract, tx.fn)
    } catch (err) {
      if (err instanceof UnknownP7TxError) {
        throw new AgentActionRunnerError(err.message)
      }
      throw err
    }
    try {
      lastTxHash = await ctx.sender.write({
        address: tx.address,
        abi: binding.abi,
        functionName: tx.fn,
        args: binding.orderArgs(tx.args),
      })
    } catch (err) {
      // Mid-loop revert (e.g. kyc_add tier-2 second tx reverts) — surface
      // step index so the issuer + operator can tell exactly which leg
      // failed. The successful prior leg(s) are NOT rolled back; the
      // issuer must manually re-propose kyc_remove if a clean-up is
      // needed (operator pick 2026-05-19; partial-revert UX deferred to
      // a Wave 5 issuer-side multicall wrapper).
      const msg = err instanceof Error ? err.message : String(err)
      throw new AgentActionRunnerError(
        `${action.kind} step ${i + 1}/${txs.length} (${tx.contract}.${tx.fn}) reverted: ${msg}`,
      )
    }
  }
  // Loop guarantees txs.length >= 1 and the assignment runs unless
  // sender.write throws (which would already have bubbled out). The
  // null check below is L-1 from the 2026-05-19 self-review: an
  // explicit throw is more defensible than `as Hash` if a future
  // refactor adds a `continue` branch that could skip the assignment.
  if (lastTxHash === null) {
    throw new AgentActionRunnerError(
      `dispatchActionTxs (${action.kind}) completed loop without dispatching a tx — unreachable under current logic`,
    )
  }
  return lastTxHash
}

/**
 * Invalidate the issuer-side stores so /tokens + /investors re-fetch on
 * the next visit. Called after a successful P7 issuer-side write
 * (unpause_token, kyc_add, kyc_remove). Reuses the same pattern as
 * ApplyPage.vue's invalidateIssuerCaches() post-deploy hook (commit
 * 869eee1, 2026-05-09).
 *
 * Stores are imported lazily so this composable stays usable from
 * non-Vue contexts (e.g. future Node-side dispatchers); mirrors the
 * runBuy mhUSDC-balance gate's lazy `useWalletStore` import.
 */
async function invalidateIssuerCachesAfterP7Write(): Promise<void> {
  try {
    const { useIssuerTokensStore } = await import('@/stores/issuer-tokens')
    const { useIssuerInvestorsStore } = await import('@/stores/issuer-investors')
    useIssuerTokensStore().reset()
    useIssuerInvestorsStore().reset()
  } catch (err) {
    // Non-fatal — the action already settled on-chain. Worst case the
    // issuer reloads /tokens manually (the pre-fix behaviour).
    console.warn('[runner] post-P7-write cache invalidate failed:', err)
  }
}
