import {
  SubscriptionClient,
  MuHavenClient,
  // RedemptionQueueClient — not yet wired into agent claim path; see Wave 5 follow-up note.
} from '@muhaven/sdk'
import type { Address, Hash } from 'viem'
import { addresses, v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext } from '@/services/v35/context'
import { useFhe } from '@/composables/useFhe'
import { useAgentDistributeProgress } from '@/composables/useAgentDistributeProgress'
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
      case 'distribute_yield': {
        // Wave 4 P7 Phase 2 — drives the MuHavenClient.distributeYield
        // 3-stage pipeline (startDistribution → createYieldEscrows →
        // fundEscrows). Unlike the unpause/kyc tools this is NOT a
        // dispatchActionTxs path — the SDK owns the encryption + batching
        // + tx loop. The runner just wires the kernel + mhUSDC operator
        // grant + progress bus, then returns the LAST fund tx hash.
        try {
          const txHash = await runDistribute(action)
          await invalidateIssuerCachesAfterP7Write()
          return { ok: true, txHash }
        } catch (err) {
          // Self-review fix 2026-05-20: pin the progress bus to
          // 'failed' so the modal paints the failing phase red AND
          // `isDistributeRunning` flips false → Cancel button is
          // re-enabled. Without this, the bus stays mid-phase + the
          // modal becomes undismissable. Re-throw so the outer catch
          // surfaces the error to the user as ok:false.
          useAgentDistributeProgress().markFailed()
          throw err
        }
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
 * Wave 4 P7 Phase 2 — drive the SDK's distributeYield pipeline.
 *
 * Pipeline (per SDK JSDoc `MuHavenClient.distributeYield` at
 * `packages/sdk/src/client.ts:230-283`):
 *   1. Pre-flight: `mhUSDC.setOperator(yieldDistributor, expiry)` —
 *      same idempotent-long-expiry posture as `runBuy`'s
 *      `MuHavenStableService.setOperator(subscription, expiry)`. Without
 *      this, YieldDistributor's confidentialTransferFrom pull reverts.
 *   2. Build write context (ZeroDev kernel sender + cofhe-ephemeral-EOA).
 *   3. Construct `MuHavenClient` against the Wave-3 contract addresses
 *      (`yieldDistributor`, `muhavenEscrow`, `investorRegistry`,
 *      `yieldGate` — these live on `addresses`, not `v35Addresses`).
 *   4. Call `distributeYield(totalYield, { onProgress })`. SDK runs
 *      startDistribution → createYieldEscrows → fundEscrows internally,
 *      emitting ProgressEvents the modal renders via the shared bus.
 *   5. Return the LAST fund tx hash so the audit-commit POST anchors to
 *      the "completed-when" tx (mirrors dispatchActionTxs' return policy).
 *
 * Defense-in-depth checks BEFORE any FHE work (operator pick 2026-05-19
 * Q4 — mirrors Phase 1 H-1 binding):
 *   - `preview.issuerAddress` MUST equal the connected kernel address.
 *     Both fields are action-hash-bound on the backend's confirm token,
 *     so this is a redundant client-side check that catches drift /
 *     malicious-server cases before we pay gas on a kernel signature
 *     against the wrong issuer of record.
 *   - `preview.tokenAddress` MUST exist in `useIssuerTokensStore`.
 *
 *     CAVEAT (Security review HIGH-1, 2026-05-20): the SDK's
 *     `distributeYield(totalYield)` does NOT take a tokenAddress. The
 *     on-chain YieldDistributor singleton is wired to ONE MuHavenToken
 *     at deploy time; the descriptor's `tokenAddress` is audit-metadata
 *     only. Today on Arb Sepolia only one YieldDistributor exists, so
 *     the registry-membership check is the strongest binding available
 *     without resolving per-token distributors from the registry. If
 *     Wave 5+ rolls out per-token YieldDistributors, this check needs
 *     to upgrade to "preview.tokenAddress resolves to a per-token
 *     YieldDistributor and that distributor's bound MuHavenToken
 *     matches" — see follow-up in development/STATUS.md.
 *
 * Cancellation semantics (operator pick 2026-05-19 Q2): no SDK abort
 * signal. The progress bus advances past 'idle' the moment the first
 * stage fires; ConfirmModal disables Cancel from that point on.
 *
 * Concurrent-distribution guard (Code Reviewer M-3 / Security M-1,
 * 2026-05-20): the bus is module-level so two distribute_yield runners
 * in flight at the same time would interleave their progress events and
 * mislead the modal. Fail closed if a prior distribution is still
 * mid-pipeline.
 */
async function runDistribute(action: ActionDescriptor): Promise<string> {
  if (action.kind !== 'distribute_yield') {
    throw new AgentActionRunnerError('not a distribute_yield')
  }

  // Required addresses must be deployed. Zero-address signals a
  // misconfigured env — fail closed BEFORE any FHE work or operator grant.
  for (const slot of [
    ['yieldDistributor', addresses.yieldDistributor],
    ['muhavenEscrow', addresses.muhavenEscrow],
    ['investorRegistry', addresses.investorRegistry],
    ['yieldGate', addresses.yieldGate],
  ] as const) {
    if (isZeroAddress(slot[1])) {
      throw new AgentActionRunnerError(
        `MuHaven Wave-3 contract ${slot[0]} not deployed in this environment.`,
      )
    }
  }

  // Concurrent-distribution guard (Code Reviewer M-3 / Security M-1).
  // Two runs writing to the same module-level bus would interleave
  // progress events + corrupt the modal's "phase 2/3" display. Fail
  // closed before any FHE / setOperator work. 'failed' and 'settled'
  // are both terminal sentinel states the next distribution is allowed
  // to reset over.
  const progress = useAgentDistributeProgress()
  const currentPhase = progress.state.value.phase
  if (currentPhase !== 'idle' && currentPhase !== 'settled' && currentPhase !== 'failed') {
    throw new AgentActionRunnerError(
      'A previous yield distribution is still in progress — wait for it to settle before proposing another.',
    )
  }

  // Action-hash-bound preview field reads. The backend pins these into
  // the confirm token's action hash (see propose-distribute-yield.use-case.ts),
  // so trusting them for binding checks is safe — any drift breaks the
  // commit POST's hash equality check anyway.
  const previewIssuer = readLowerAddress(action.preview, 'issuerAddress')
  const previewToken = readLowerAddress(action.preview, 'tokenAddress')
  const totalYieldRaw = action.preview.totalYieldUsd6
  if (typeof totalYieldRaw !== 'string' || !/^\d+$/.test(totalYieldRaw)) {
    throw new AgentActionRunnerError(
      'ActionDescriptor (distribute_yield) preview missing valid totalYieldUsd6',
    )
  }
  const totalYield = BigInt(totalYieldRaw)
  if (totalYield <= 0n) {
    throw new AgentActionRunnerError('distribute_yield totalYieldUsd6 must be > 0')
  }
  // Sanity cap (Security M-2): the on-chain encrypted-amount type is
  // `euint64` so anything above 2^64-1 would either silently truncate
  // or revert deep in CoFHE land. Cap at $100M (1e8 USD, 1e14 units
  // base-6) — a per-distribution number well above any realistic
  // hackathon-demo amount. A malicious LLM proposing `'18446744073709551615'`
  // (uint64 max ≈ $18.4T) is the threat shape this closes.
  const MAX_TOTAL_YIELD_USD6 = 100_000_000_000_000n // $100M in base-6 USDC
  if (totalYield > MAX_TOTAL_YIELD_USD6) {
    throw new AgentActionRunnerError(
      `distribute_yield totalYieldUsd6 exceeds the ${MAX_TOTAL_YIELD_USD6} cap (~$100M). Propose a smaller distribution.`,
    )
  }

  // Label length (Security M-3): backend caps at 200 chars before
  // hashing the actionPayload (propose-distribute-yield.use-case.ts:102).
  // Mirror the cap client-side so a future backend bug doesn't ship a
  // 1MB label that floods the audit POST.
  const labelRaw = action.preview.label
  if (typeof labelRaw !== 'string' || labelRaw.length > 200) {
    throw new AgentActionRunnerError(
      'ActionDescriptor (distribute_yield) preview.label must be a string ≤ 200 chars',
    )
  }

  // H-1 analog — kernel binding. Lazy import keeps the runner usable
  // from non-Vue contexts (mirrors runBuy's lazy useWalletStore import).
  const { useWalletStore } = await import('@/stores/wallet')
  const wallet = useWalletStore()
  const kernelAddress = wallet.address as string | null
  if (!kernelAddress) {
    throw new AgentActionRunnerError(
      'No connected kernel address — sign in before distributing yield.',
    )
  }
  if (kernelAddress.toLowerCase() !== previewIssuer) {
    throw new AgentActionRunnerError(
      `distribute_yield preview.issuerAddress (${previewIssuer}) does not match connected kernel (${kernelAddress.toLowerCase()})`,
    )
  }

  // H-1 analog — token registry binding. Auto-refresh once if the
  // store is empty (typical pre-load state); after refresh, an absent
  // token is a hard failure.
  const { useIssuerTokensStore } = await import('@/stores/issuer-tokens')
  const issuerTokens = useIssuerTokensStore()
  let hasToken = issuerTokens.tokens.some(
    (t: { address: string }) => t.address.toLowerCase() === previewToken,
  )
  if (!hasToken && typeof issuerTokens.load === 'function' && issuerTokens.tokens.length === 0) {
    try {
      await issuerTokens.load()
      hasToken = issuerTokens.tokens.some(
        (t: { address: string }) => t.address.toLowerCase() === previewToken,
      )
    } catch (err) {
      console.warn('[runDistribute] issuer tokens load failed:', err)
    }
  }
  if (!hasToken) {
    throw new AgentActionRunnerError(
      `distribute_yield preview.tokenAddress (${previewToken}) is not registered to this issuer kernel`,
    )
  }

  const fhe = useFhe()
  await fhe.initialize?.()

  // Pre-flight operator grant on mhUSDC → yieldDistributor. Same
  // idempotent-long-expiry posture as runBuy's setOperator on the
  // Subscription contract. Required because YieldDistributor pulls
  // mhUSDC from the issuer via `confidentialTransferFrom` during
  // fundEscrows; without an operator approval the pull reverts and
  // the FHE.select silent-fail short-circuits the payout. The
  // wrapper rotation (see memory `reference_phase7_5_pusdc_rotation`)
  // means YieldDistributor's on-chain `pusdc` field now points at
  // MuHavenStable, so MuHavenStableService is the right target.
  const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
  await MuHavenStableService.setOperator(addresses.yieldDistributor, expiry)

  // Reset the progress bus so a prior settled / failed distribution
  // doesn't bleed into this one. ConfirmModal also resets on
  // `props.action.toolCallId` change, but resetting here keeps the
  // runner self-contained for tests.
  progress.reset()

  const ctx = await buildWriteContext()
  const sdk = new MuHavenClient({
    publicClient: ctx.publicClient,
    sender: ctx.sender,
    cofheClient: ctx.cofheClient,
    addresses: {
      muhavenEscrow: addresses.muhavenEscrow,
      yieldDistributor: addresses.yieldDistributor,
      investorRegistry: addresses.investorRegistry,
      yieldGate: addresses.yieldGate,
    },
  })

  const result = await sdk.distributeYield(totalYield, {
    onProgress: (evt) => {
      try {
        progress.applyEvent(evt)
      } catch (err) {
        // Bus updates are best-effort — a thrown handler must never
        // abort the SDK pipeline mid-flight. Worst case the modal's
        // progress bar freezes; the on-chain pipeline still finishes
        // and the audit-commit fires on the runner's return value.
        console.warn('[runDistribute] progress bus failed:', err)
      }
    },
  })

  progress.markSettled()

  // Return the LAST fund tx hash. `fundTxHashes` is guaranteed non-empty
  // by the SDK's contract — startDistribution reverts on empty registry,
  // so by here we always have escrows to fund. If this invariant ever
  // changes upstream we'd rather throw than silently lose the audit anchor.
  const lastFundHash = result.fundTxHashes[result.fundTxHashes.length - 1]
  if (!lastFundHash) {
    throw new AgentActionRunnerError(
      'distribute_yield completed without a fund tx hash — unexpected SDK state',
    )
  }
  return lastFundHash
}

/** Address reader that lowercases + validates the shape. Throws on miss. */
function readLowerAddress(preview: Record<string, unknown>, field: string): string {
  const raw = preview[field]
  if (typeof raw !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new AgentActionRunnerError(
      `distribute_yield preview missing valid ${field}`,
    )
  }
  return raw.toLowerCase()
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
