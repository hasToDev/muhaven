import {
  SubscriptionClient,
  YieldSnapshotClient,
  RATE_SCALE,
  tokenRegistryAbi,
  muhavenSubscriptionAbi,
  muHavenStableAbi,
  // RedemptionQueueClient — not yet wired into agent claim path; see Wave 5 follow-up note.
} from '@muhaven/sdk'
import type { ProgressCallback } from '@muhaven/sdk'
import { encodeFunctionData, type Address, type Hash } from 'viem'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildWriteContext } from '@/services/v35/context'
import { useFhe } from '@/composables/useFhe'
import { useAgentDistributeProgress } from '@/composables/useAgentDistributeProgress'
import * as MuHavenStableService from '@/services/contracts/MuHavenStableService'
import * as SnapshotService from '@/services/v35/SnapshotService'
import type { TokenRegistryConfig } from '@/services/v35/SnapshotService'
import { resolveP7Tx, UnknownP7TxError } from '@/services/v35/p7-tx-abis'
import type { ActionDescriptor } from '@/services/api'
import { formatMhUsdcBigInt } from '@/lib/money'

const OPERATOR_EXPIRY_SECONDS = 365 * 24 * 60 * 60 // 1 year, mirrors TradePage

/**
 * P7 Phase 2 — defense-in-depth cap on `distribute_yield`'s `totalYieldUsd6`.
 *
 * 1e14 base-6 units = $100M. Five orders below the on-chain `euint64`
 * ceiling (~$18.4T) but a sane upper bound for hackathon demos and any
 * single-tx institutional distribution. The cap closes the malicious-LLM
 * threat shape of a `'18446744073709551615'` (uint64-max) proposal —
 * without it the SDK would burn gas on an encrypted startDistribution
 * before silent-failing deep in CoFHE land. Module-level so tests can
 * reference the same constant.
 *
 * Pre-mainnet review needed before raising for institutional issuers.
 */
const MAX_TOTAL_YIELD_USD6 = 100_000_000_000_000n // $100M in base-6 USDC

/**
 * P7 Phase 2 — client-side mirror of the backend's `label.slice(0, 200)`
 * in `propose-distribute-yield.use-case.ts`. Belt-and-suspenders: if a
 * future backend bug drops the slice we don't ship a 1MB label into the
 * audit POST body.
 */
const DISTRIBUTE_YIELD_LABEL_MAX_LEN = 200

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
        // Wave 5 Slice 3 — all legs settle in ONE silent atomic UserOp via
        // the in-tab Scoped session key (sells before buys). Returns the
        // UserOp tx hash for the audit-commit POST.
        return { ok: true, txHash: await runRebalance(action) }
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
        // Wave 4 P7 Phase 2 (rewired 2026-05-22 to YieldSnapshot — the
        // prior MuHavenClient.distributeYield wiring targeted the Wave-3
        // YieldDistributor singleton, which is incompatible with the
        // Wave-3.5 InvestorRegistry the SDK enumerates from; see
        // `development/DEV_WAVE_4/PHASE_2_YIELD_SNAPSHOT_REWIRE.md`).
        //
        // Drives the YieldSnapshot lifecycle (openEpoch → snapshotAll →
        // finalizeSnapshot → refreshSnapshotSupplyGrant + decrypt supply
        // → fundEpoch). The SDK owns the encryption + batching + tx loop;
        // the runner wires the kernel + mhUSDC operator grant + progress
        // bus + ratePerShare compute, then returns the fundEpoch tx hash.
        // `runDistribute` owns its own try/catch so the markFailed call
        // can be gated on "SDK actually started" (pre-flight throws
        // don't paint a fake red step-1).
        //
        // Deferred return: an in-flight epoch hand-off points the user
        // at /distribute (HavenBot does NOT resume in-flight epochs;
        // the wizard owns resume — see plan pin 3).
        const result = await runDistribute(action)
        if (result.kind === 'deferred') {
          return {
            ok: 'deferred',
            redirectTo: result.redirectTo,
            reason: result.reason,
          }
        }
        await invalidateIssuerCachesAfterP7Write()
        return { ok: true, txHash: result.txHash }
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
        // BigInt formatter preserves precision past Number.MAX_SAFE_INTEGER
        // (which `Number(units) / 1e6` would lose above ~$9B mhUSDC).
        const haveUsd = formatMhUsdcBigInt(have, { withSign: true })
        const needUsd = formatMhUsdcBigInt(needed, { withSign: true })
        throw new AgentActionRunnerError(
          `Insufficient mhUSDC balance: you have ${haveUsd} but this purchase needs ${needUsd}. Wrap more USDC into mhUSDC on the Cash page first.`,
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
 * Wave 5 Slice 3 — execute a multi-leg rebalance as ONE silent atomic UserOp.
 *
 * Mirrors `runBuy`'s encrypt-then-submit shape, but instead of one
 * `SubscriptionClient.purchase` (which sends its own UserOp), it encrypts
 * every leg and hand-builds a `calls[]` array submitted via ONE
 * `wallet.sendUserOperation(calls)`. Because every call targets the
 * Subscription (`purchase`/`redeem`) or mhUSDC (`setOperator`) — all in
 * `SESSION_PERMISSIONS` — the provider routes the whole batch to the in-tab
 * Scoped session kernel and signs it silently (first-ever session op fires
 * one enableSig passkey; silent after). Sells are ordered before buys so the
 * sell proceeds credit mhUSDC in-batch before the buy legs spend it.
 *
 * The legs come from `action.preview.legs`, which the backend hashes into the
 * confirm token — the commit POST 403s on any drift. Since the runner fires
 * BEFORE the commit, we ALSO re-validate the legs structurally here and
 * hardcode every on-chain target (never trust an address from the descriptor)
 * so a tampered descriptor can't retarget the kernel or smuggle a non-buy/sell
 * selector — the same H-1/H-2 posture as `dispatchActionTxs`.
 */

/** Matches the backend `ProposeRebalanceDtoSchema` `.max(8)` + kernel batch ceiling. */
export const MAX_REBALANCE_LEGS = 8

export interface RebalanceLegSpec {
  kind: 'sell' | 'buy'
  tokenAddress: Address
  shares: bigint
  maxSharesHint: bigint
}

/**
 * Re-validate the hash-bound `preview.legs` into typed leg specs (mirror of
 * `dispatchActionTxs`'s H-1/H-2 posture). Pure + exported so the
 * tampered-descriptor rejection is directly unit-tested. Throws
 * `AgentActionRunnerError` on any structural violation; the on-chain TARGET
 * (Subscription) is hardcoded by the caller and never read from a leg, so a
 * tampered descriptor can at worst alter token/shares within the
 * Subscription — and that would 403 the commit hash check.
 */
export function parseRebalanceLegs(rawLegs: unknown): RebalanceLegSpec[] {
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
    throw new AgentActionRunnerError('Rebalance descriptor carries no legs.')
  }
  if (rawLegs.length > MAX_REBALANCE_LEGS) {
    throw new AgentActionRunnerError(
      `Rebalance exceeds the ${MAX_REBALANCE_LEGS}-leg limit (${rawLegs.length}).`,
    )
  }
  return rawLegs.map((raw, i) => {
    const leg = (raw ?? {}) as Record<string, unknown>
    if (leg.kind !== 'sell' && leg.kind !== 'buy') {
      throw new AgentActionRunnerError(`Rebalance leg ${i}: kind must be 'sell' or 'buy'.`)
    }
    const tokenAddress = leg.tokenAddress
    if (typeof tokenAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
      throw new AgentActionRunnerError(`Rebalance leg ${i}: invalid tokenAddress.`)
    }
    const sharesStr = String(leg.shares)
    const hintStr = String(leg.maxSharesHint ?? leg.shares)
    if (!/^\d+$/.test(sharesStr) || !/^\d+$/.test(hintStr)) {
      throw new AgentActionRunnerError(
        `Rebalance leg ${i}: shares/maxSharesHint must be positive integers.`,
      )
    }
    const shares = BigInt(sharesStr)
    const maxSharesHint = BigInt(hintStr)
    if (shares <= 0n) throw new AgentActionRunnerError(`Rebalance leg ${i}: shares must be > 0.`)
    if (shares > maxSharesHint) {
      throw new AgentActionRunnerError(
        `Rebalance leg ${i}: shares (${shares}) > maxSharesHint (${maxSharesHint}).`,
      )
    }
    return { kind: leg.kind, tokenAddress: tokenAddress as Address, shares, maxSharesHint }
  })
}

async function runRebalance(action: ActionDescriptor): Promise<string> {
  if (action.kind !== 'rebalance') throw new AgentActionRunnerError('not a rebalance')
  if (isZeroAddress(v35Addresses.subscription)) {
    throw new AgentActionRunnerError('Subscription not deployed in this environment.')
  }

  // ── Re-validate the hash-bound legs (mirror dispatchActionTxs H-1/H-2) ──
  const legs = parseRebalanceLegs((action.preview as { legs?: unknown }).legs)

  // Sells before buys — proceeds credit mhUSDC in-batch before buys spend it.
  // The plan already emits sells-first, so this is a DEFENSIVE re-assert (a
  // reordered descriptor can't break the funding invariant). Execution order
  // doesn't affect the confirm-token hash, so this never causes a commit 403.
  legs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sell' ? -1 : 1))

  const fhe = useFhe()
  await fhe.initialize?.()
  const ephemeralEOA = fhe.getEphemeralEOA()
  if (!ephemeralEOA) {
    throw new AgentActionRunnerError('Ephemeral EOA missing — initialize FHE first.')
  }
  const { useWalletStore } = await import('@/stores/wallet')
  const wallet = useWalletStore()
  const kernelAddress = wallet.address as Address | null
  if (!kernelAddress) {
    throw new AgentActionRunnerError('No connected kernel address — sign in first.')
  }

  const subscription = v35Addresses.subscription
  const calls: { to: `0x${string}`; data: `0x${string}` }[] = []

  // mhUSDC operator grant on the Subscription — buy legs pull mhUSDC via
  // confidentialTransferFrom (mirrors runBuy's setOperator). Sells burn via
  // the Subscription's contract-level role and need no per-user grant. We add
  // it IN-BATCH as the first call (idempotent long-expiry) so the whole
  // rebalance is one atomic UserOp; `setOperator` is in SESSION_PERMISSIONS so
  // the batch stays in silent session scope.
  const hasBuyLeg = legs.some((l) => l.kind === 'buy')
  if (hasBuyLeg) {
    if (isZeroAddress(v35Addresses.muHavenStable)) {
      throw new AgentActionRunnerError('mhUSDC wrapper not configured — cannot fund buy legs.')
    }
    const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
    calls.push({
      to: v35Addresses.muHavenStable,
      data: encodeFunctionData({
        // `abi as any` mirrors zeroDevSender's pattern — viem's strict arg
        // inference (uint48 `until`, the InEuint128 tuple's `0x`-bytes
        // `signature`) fights the runtime-correct shapes the SDK already uses.
        abi: muHavenStableAbi as any,
        functionName: 'setOperator',
        args: [subscription, expiry],
      }),
    })
  }

  // Encrypt + encode each leg. Sequential — the cofhe client isn't built for
  // concurrent encryptInputs and ≤8 legs is a small loop. Encryption is bound
  // to the kernel (senderAccount) so the on-chain FHE.asEuint128 verifier
  // signer matches msg.sender (the kernel), per services/v35/context.ts.
  for (const leg of legs) {
    const enc = await fhe.encryptUint128(leg.shares, { senderAccount: kernelAddress })
    const data = encodeFunctionData({
      // `abi as any` — see the setOperator note above (InEuint128 tuple's
      // `signature` is a plain string at runtime, not viem's `0x${string}`).
      abi: muhavenSubscriptionAbi as any,
      functionName: leg.kind === 'buy' ? 'purchase' : 'redeem',
      args: [
        leg.tokenAddress,
        {
          ctHash: enc.ctHash,
          securityZone: enc.securityZone,
          utype: enc.utype,
          signature: enc.signature,
        },
        leg.maxSharesHint,
        ephemeralEOA,
      ],
    })
    calls.push({ to: subscription, data })
  }

  return wallet.sendUserOperation(calls)
}

/**
 * Result shape for `runDistribute`. Settled returns the fundEpoch tx
 * hash (audit-commit anchor); deferred is the in-flight-epoch hand-off
 * to /distribute. The dispatcher above unpacks both shapes.
 *
 * Errors throw via `AgentActionRunnerError` → caught in `runAgentAction`
 * → mapped to `{ ok: false, error }`. No third arm needed.
 */
type RunDistributeResult =
  | { kind: 'settled'; txHash: string }
  | { kind: 'deferred'; redirectTo: string; reason: string }

/**
 * Wave 4 P7 Phase 2 — drive the YieldSnapshot pipeline.
 *
 * History (rewire 2026-05-22): the original Phase 2 implementation
 * targeted the Wave-3 `MuHavenClient.distributeYield` (start →
 * createEscrows → fundEscrows on YieldDistributor + MuHavenEscrow). The
 * 2026-05-21 prod walkthrough surfaced a 4-layer skew with Wave-3.5
 * reality: the Wave-3 InvestorRegistry the YieldDistributor reads from
 * has zero overlap with the Wave-3.5 InvestorRegistry the SDK
 * enumerates from, so even with all 3 in-session ops scripts run
 * (authorize, rotate-pusdc) the pipeline failed at
 * `escrowIds length 4 != investorCount 10` (ConfigError from
 * `packages/sdk/src/yield.ts`). Wave-3.5's pull-based YieldSnapshot
 * (ADR-005) is the live distribution surface; this rewire targets it.
 * See `development/DEV_WAVE_4/PHASE_2_YIELD_SNAPSHOT_REWIRE.md` for the
 * full plan + the parallel multi-agent review trail.
 *
 * On-chain pipeline (per `YieldSnapshotClient` JSDoc + ADR-005):
 *   1. Pre-flight: `mhUSDC.setOperator(yieldSnapshot, expiry)` —
 *      idempotent-long-expiry; required because `fundEpoch` pulls
 *      mhUSDC via `confidentialTransferFrom`.
 *   2. `openEpoch(token)` — allocates a new epochId.
 *   3. `snapshotAll(epochId, holders, { batchSize })` — multi-batch
 *      enumeration of every holder's encrypted balance. SDK-internal
 *      pagination; aggregate progress emitted via onProgress.
 *   4. `finalizeSnapshot(epochId)` — locks the snapshot phase + grants
 *      issuer L2 ACL on `encTotalSupply` (ADR-049 issuer-trust-model).
 *   5. `refreshSnapshotSupplyGrant(epochId, eph)` — re-stamps the L2
 *      ACL onto the current ephemeral EOA so the cofhe permit-based
 *      decrypt resolves (kernels can't sign per ADR-009; permit signer
 *      is the eph). UserOp from the kernel; idempotent.
 *   6. `useFhe().decryptSnapshotSupplyForView(handle)` — read +
 *      decrypt the encrypted total-supply aggregate (issuer-only
 *      decrypt; per-investor handles stay encrypted).
 *   7. Compute `ratePerShare = floor(totalYield × RATE_SCALE / supply)`
 *      cleartext. Assert `> 0` and `≤ uint128` — mirrors the SDK's own
 *      check inside `fundEpoch` so we surface a clean error pre-tx
 *      rather than a `ConfigError` revert mid-flight.
 *   8. `fundEpoch(epochId, totalYield, ratePerShare)` — SDK encrypts
 *      totalYield, transfers mhUSDC, stores `ratePerShare` cleartext
 *      on-chain (Phase 9.B / Option A). Investor `claimYield` uses
 *      `share × ratePerShare / RATE_SCALE` for the payout.
 *   9. Mark settled + return the fundEpoch tx hash so the audit-commit
 *      POST anchors to the "completed-when" tx.
 *
 * Order of work (load-bearing for the failed-bar-only-for-SDK-failures
 * UX semantic — survives the rewire untouched from Phase 2's
 * second-pass hardening 2026-05-21):
 *   1. Snapshot proxy address presence (pre-flight zero-address).
 *   2. Concurrent-distribution guard (no overlap with a prior run).
 *   3. `progress.reset(toolCallId)` — bumps runId, tags the bus.
 *      From here on, every progress write is keyed to this runId.
 *   4. Validation + binding checks (totalYield shape, label length,
 *      kernel address, token registry membership).
 *   5. Build write context (gives us publicClient + cofhe-bound sender).
 *   6. NEW — On-chain TokenRegistry issuer match (catches issuer
 *      rotation between propose + confirm; cleaner error than the
 *      contract's `OnlyIssuer()` revert mid-pipeline).
 *   7. NEW — In-flight epoch hand-off: SnapshotService.detectInFlight.
 *      Non-null + non-done returns a deferred result pointing the user
 *      at /distribute (HavenBot does NOT resume in-flight epochs; the
 *      wizard owns resume — pinned per plan §"Architectural pins" 3).
 *   8. NEW — Holder enumeration: loadAllHolders. Empty list rejects
 *      (would otherwise drive ratePerShare → divide-by-zero on the
 *      decrypted supply). Result re-used for snapshotAll below.
 *   9. setOperator pre-flight tx (UserOp 1).
 *  10..15. SDK pipeline (openEpoch → snapshotAll → finalizeSnapshot →
 *          refreshSnapshotSupplyGrant + decrypt + computeRate → fundEpoch).
 *  16. markSettled + return fundEpoch tx hash.
 *
 * Any throw between step 3 and the first SDK onProgress event leaves
 * the bus at `phase = 'idle'`. The catch checks the bus phase and
 * only `markFailed`s if the SDK pipeline has actually started (i.e.
 * phase is `start | escrows | fund`). Pre-flight failures surface as
 * the standard error banner without a misleading red step-1 in the
 * 3-phase bar. Plan §"Pre-flight-no-bar invariant — VERIFIED SAFE"
 * has the SDK-internal verification of this property
 * (`writeAndWait` resolves before `onProgress` fires).
 *
 * Defense-in-depth binding (operator pick 2026-05-19 Q4 — mirrors
 * Phase 1 H-1):
 *   - `preview.issuerAddress` MUST equal the connected kernel address.
 *   - `preview.tokenAddress` MUST exist in `useIssuerTokensStore`.
 *   - `TokenRegistry.getConfig(preview.tokenAddress).issuer` MUST
 *     equal the connected kernel address (NEW — closes the rotated-
 *     issuer + DB-vs-chain-drift class).
 *
 * Cancellation semantics (operator pick 2026-05-19 Q2): no SDK abort
 * signal. The progress bus advances past 'idle' the moment the first
 * stage fires; ConfirmModal disables Cancel from that point on.
 */
async function runDistribute(action: ActionDescriptor): Promise<RunDistributeResult> {
  if (action.kind !== 'distribute_yield') {
    throw new AgentActionRunnerError('not a distribute_yield')
  }

  // Single read of preview.tokenAddress for both the snapshot-proxy
  // resolve AND every downstream binding check inside the try block.
  // Round-2 review CR2-H1: a prior version read this twice (once
  // outside the try, once inside) which today returns identical values
  // (the descriptor preview is never mutated between reads) but is
  // fragile under a future preview-normalizer refactor — a mid-flight
  // mutation would route the snapshot-proxy lookup to one token while
  // the issuer-binding gate validates a different one. One read, one
  // value, no drift.
  const previewToken = readLowerAddress(action.preview, 'tokenAddress')

  // Pre-load the issuer-tokens store BEFORE snapshot resolution
  // (Pick B SE HIGH, 2026-05-23). The Wave 5+ per-token YieldSnapshot
  // proxy binding registers each token's snapshot address via the
  // store's `load()` call (which loops `registerYieldSnapshot` over
  // the API response). If the issuer's first post-login action is the
  // chat path (never visited /tokens or /distribute), the runtime map
  // is empty when `SnapshotService.snapshotProxyFor` resolves below
  // → fallback to env-var singleton (wrong address for wizard-deployed
  // tokens) → UserOp signed against a snapshot that's NOT registered
  // for this token → on-chain revert (`OnlyIssuer` / `OnlyYieldSnapshot`).
  // The load is idempotent + tolerated-on-failure so the runner stays
  // usable when the store can't reach the backend (env config), with
  // the singleton fallback retained as a last-resort path for the
  // legacy-tokens-only case.
  const { useIssuerTokensStore } = await import('@/stores/issuer-tokens')
  const issuerTokens = useIssuerTokensStore()
  if (issuerTokens.tokens.length === 0 && typeof issuerTokens.load === 'function') {
    try {
      await issuerTokens.load()
    } catch (err) {
      console.warn(
        '[runDistribute] pre-flight issuer-tokens load failed (proceeding with env-var fallback):',
        err,
      )
    }
  }

  // Snapshot proxy address must resolve. `getYieldSnapshot` checks the
  // runtime map first (populated by `issuerTokens.load()` above), then
  // the per-token env-var map, then the singleton — covers
  // wizard-deployed tokens absent from the static JSON map.
  // Zero-address signals a misconfigured env.
  const snapshotAddr = SnapshotService.snapshotProxyFor(previewToken as Address)
  if (!snapshotAddr || isZeroAddress(snapshotAddr)) {
    // Env-config bug — not actionable for issuers. Surface enough
    // detail for support to triage AND a concrete next-step.
    throw new AgentActionRunnerError(
      `MuHaven YieldSnapshot proxy not configured for token ${previewToken} in this environment. Contact support — this token is not yet available for HavenBot distribution.`,
    )
  }

  // Concurrent-distribution guard. Two runs writing to the same
  // module-level bus would interleave progress events. Fail closed
  // before any other work. 'idle' / 'settled' / 'failed' are the
  // terminal states a new run is allowed to take over from.
  const progress = useAgentDistributeProgress()
  const priorPhase = progress.state.value.phase
  if (priorPhase !== 'idle' && priorPhase !== 'settled' && priorPhase !== 'failed') {
    throw new AgentActionRunnerError(
      'A previous yield distribution is still in progress — wait for it to settle before proposing another.',
    )
  }

  // Reset the bus + capture the runId for this run. From here on, every
  // bus mutation is gated on this runId — if a stale onProgress callback
  // from a previous run somehow fires after we've reset (theoretical
  // under current SDK semantics; defensive against future SDK changes),
  // it'll be dropped silently. The toolCallId tagging lets the modal
  // verify the bus belongs to the currently-displayed descriptor before
  // rendering the 3-phase bar — closes the descriptor-swap-mid-flight
  // confusion (Reality Checker F7, 2026-05-21).
  //
  // Crucially: reset() happens BEFORE pre-flight validation. Any throw
  // between here and the SDK call leaves the bus at 'idle' with no
  // failedAt — the modal renders the standard error banner instead of a
  // misleading "Step 1 failed" red bar (Code Reviewer M-1, my H-A).
  const runId = progress.reset(action.toolCallId)

  try {
    // Action-hash-bound preview field reads. The backend pins these into
    // the confirm token's action hash (see propose-distribute-yield.use-case.ts),
    // so trusting them for binding checks is safe — any drift breaks the
    // commit POST's hash equality check anyway.
    // (`previewToken` was hoisted above the bus.reset for the
    // snapshot-proxy pre-check; reused here.)
    const previewIssuer = readLowerAddress(action.preview, 'issuerAddress')
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
    if (totalYield > MAX_TOTAL_YIELD_USD6) {
      throw new AgentActionRunnerError(
        `distribute_yield totalYieldUsd6 exceeds the ${MAX_TOTAL_YIELD_USD6} cap (~$100M). Propose a smaller distribution.`,
      )
    }

    const labelRaw = action.preview.label
    if (typeof labelRaw !== 'string' || labelRaw.length > DISTRIBUTE_YIELD_LABEL_MAX_LEN) {
      throw new AgentActionRunnerError(
        `ActionDescriptor (distribute_yield) preview.label must be a string ≤ ${DISTRIBUTE_YIELD_LABEL_MAX_LEN} chars`,
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

    // CONSERVATION GATE (round-2 review CR-H1 + RC-LOW-2): hoisted
    // ABOVE the chain reads (TokenRegistry.getConfig, detectInFlight,
    // loadAllHolders) because balance is independent of tokenAddress
    // and ctx, so an insufficient-balance reject should surface in
    // ~200ms (one cofhe decrypt) instead of 5-10s (full pre-flight
    // chain walk). Surfaced 2026-05-22 walkthrough: an issuer with
    // $15 mhUSDC successfully "distributed" $99M because (a) the SDK's
    // fundEpoch pulls via MuHavenStable.confidentialTransferFrom
    // which silent-fails on insufficient balance (transfers 0
    // encrypted), BUT (b) YieldSnapshot.fundEpoch still records the
    // input `encTotalYield` regardless of whether the pull actually
    // succeeded, AND (c) claimYield → MuHavenStable.trustedPayout
    // (ADR-046) bypasses _silentFailBound because per-epoch
    // conservation is "off-chain-guaranteed". When the off-chain
    // guarantee silently fails, claimYield happily pays out from the
    // snapshot's float — which encrypted-underflows or pulls from
    // prior epochs' reserves. The /distribute wizard (DistributePage)
    // gates the Fund button on `mhUsdcBalance >= amountUnits` for
    // exactly this reason; the HavenBot runner needs the same gate.
    //
    // Pattern mirrors runBuy's mhUSDC balance check (lines 218-271):
    // decrypt-if-cached-null, throw with actionable copy on
    // insufficient balance, log + proceed on decrypt failure so a
    // cofhe outage doesn't block a genuine distribute attempt (the
    // on-chain silent-fail is still the backstop, just no longer the
    // only one). Security caveat (SE-B1, round-2): this is a UX
    // safety net, not a security boundary — the real conservation
    // fix lives at the contract layer (YieldSnapshot.fundEpoch must
    // gate `encTotalYield` write on actualPulled == intended OR
    // claimYield must drop the trustedPayout bypass). Tracked as a
    // contract-layer follow-up.
    {
      const { usePortfolioStore } = await import('@/stores/portfolio')
      const portfolio = usePortfolioStore()
      if (portfolio.pusdcConfidentialBalance === null) {
        try {
          await portfolio.decryptPusdc(kernelAddress as `0x${string}`)
        } catch (err) {
          console.warn(
            '[runDistribute] mhUSDC decrypt failed; proceeding without balance gate (on-chain silent-fail remains the backstop):',
            err,
          )
        }
      }
      const have = portfolio.pusdcConfidentialBalance
      if (have !== null && have < totalYield) {
        // BigInt formatter preserves precision past Number.MAX_SAFE_INTEGER
        // (which `Number(units) / 1e6` would lose above ~$9B mhUSDC — the
        // conservation-gate error copy could otherwise misreport balance vs.
        // need on institutional-scale distributions).
        const haveUsd = formatMhUsdcBigInt(have, { withSign: true })
        const needUsd = formatMhUsdcBigInt(totalYield, { withSign: true })
        throw new AgentActionRunnerError(
          `Insufficient mhUSDC balance: you have ${haveUsd} but this distribution needs ${needUsd}. Wrap more USDC into mhUSDC on the Cash page first.`,
        )
      }
    }

    // H-1 analog — token registry binding. The store was already
    // pre-loaded BEFORE snapshot resolution (Pick B SE HIGH fix above);
    // reuse the same `issuerTokens` proxy. If the token is still absent
    // after that load, surface a hard failure — the chat-first path
    // would otherwise resolve through the env-var singleton fallback
    // and route to a snapshot that doesn't own this token.
    let hasToken = issuerTokens.tokens.some(
      (t: { address: string }) => t.address.toLowerCase() === previewToken,
    )
    if (!hasToken) {
      throw new AgentActionRunnerError(
        `distribute_yield preview.tokenAddress (${previewToken}) is not registered to this issuer kernel`,
      )
    }

    // Build write context EARLY — the on-chain TokenRegistry issuer
    // check + every SDK call below needs it. `buildWriteContext` calls
    // `useFhe().getRawClient()` internally which initializes the cofhe
    // client (no separate fhe.initialize() needed).
    const ctx = await buildWriteContext()

    // NEW (rewire 2026-05-22) — on-chain TokenRegistry issuer match.
    // Catches issuer rotation between propose + confirm AND DB-vs-chain
    // drift. YieldSnapshot's writes all gate on
    // `msg.sender == _issuerOf(token)` and revert `OnlyIssuer()` on
    // mismatch — surfacing this pre-tx gives a clean error banner
    // instead of letting the kernel sign + the contract revert
    // mid-pipeline. Cheap chain read; errors here keep the bus at
    // 'idle' so no fake red step-1 paints (pre-flight-no-bar invariant).
    // CR-M-2 (round-1 review): cast to the SHARED TokenRegistryConfig
    // type from SnapshotService — narrow inline `{ issuer: string }`
    // would still type-check after an ABI shape drift (viem decodes
    // positionally) and silently read the wrong field.
    const tokenConfig = (await ctx.publicClient.readContract({
      address: v35Addresses.tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: 'getConfig',
      args: [previewToken as Address],
    })) as unknown as TokenRegistryConfig
    if (tokenConfig.issuer.toLowerCase() !== kernelAddress.toLowerCase()) {
      throw new AgentActionRunnerError(
        `On-chain issuer (${tokenConfig.issuer.toLowerCase()}) for this token does not match your connected kernel (${kernelAddress.toLowerCase()}). The issuer may have rotated since the proposal — re-prompt HavenBot to refresh.`,
      )
    }

    // NEW (rewire 2026-05-22) — in-flight epoch hand-off. If a prior
    // open/snapshot/finalize is half-done for this token, HavenBot
    // refuses to start a new openEpoch (would revert) AND refuses to
    // resume mid-state (the /distribute wizard owns the per-step
    // resume semantics). Surface a deferred result pointing the user
    // there. Phase 'done' is OK — currentEpoch returns the most-recent
    // funded epoch as well, so a fully-completed distribution doesn't
    // block a fresh one.
    const inFlight = await SnapshotService.detectInFlight(previewToken as Address)
    if (inFlight && inFlight.phase !== 'done') {
      // RC-HIGH-1 (round-2 review): clear the bus before bailing on the
      // deferred path. Without this, the bus would stay tagged with
      // this run's toolCallId+runId at `phase: 'idle'` until the next
      // descriptor's modal `watch(props.action.toolCallId)` fires its
      // own reset(null). That's correct under all current SPA flows,
      // but it leaves the bus in an oddly-half-tagged state where a
      // subsequent observer (e.g. a future hot-fix that reads bus
      // state on /distribute) sees a runId associated with a run that
      // never emitted any SDK events. Clearing inline makes the
      // deferred path semantically equivalent to "this run never
      // started" — same posture as a pre-flight throw.
      progress.reset(null)
      return {
        kind: 'deferred',
        redirectTo: '/distribute',
        reason: `This token has a distribution in progress (round #${inFlight.epochId} · ${inFlight.phase}). Finish it on the Distribute page — HavenBot only opens fresh distribution rounds.`,
      }
    }

    // NEW (rewire 2026-05-22) — holder enumeration. Empty-snapshot
    // would drive ratePerShare into floor(totalYield × RATE_SCALE / 0)
    // which is undefined; reject pre-tx so the user sees a clean error
    // instead of an indecipherable cofhe revert. We re-use the result
    // for snapshotAll below — single registry walk per distribution.
    const holders = await SnapshotService.loadAllHolders(previewToken as Address)
    if (holders.length === 0) {
      throw new AgentActionRunnerError(
        `This token has no holders — there is nobody to distribute yield to. Verify the token has at least one investor before proposing.`,
      )
    }

    // (Conservation gate hoisted above — see kernel-binding block.)

    // Pre-flight operator grant on mhUSDC → YieldSnapshot. Same
    // idempotent-long-expiry posture as runBuy's setOperator on the
    // Subscription contract. Required because `fundEpoch` pulls mhUSDC
    // from the issuer via `confidentialTransferFrom`; without an
    // operator approval the pull silent-fails and the FHE.select
    // short-circuits the payout. UserOp 1.
    const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS)
    await MuHavenStableService.setOperator(snapshotAddr as Address, expiry)

    // ── SDK pipeline begins ──────────────────────────────────────────
    // Throws past this line CAN mark the bus failed (the catch's
    // phase-guard validates that the SDK has actually started emitting
    // onProgress events).
    const client = new YieldSnapshotClient(ctx, snapshotAddr as Address)

    const onProgress: ProgressCallback = (evt) => {
      try {
        progress.applyEventForRun(runId, evt)
      } catch (err) {
        // Bus updates are best-effort — a thrown handler must never
        // abort the SDK pipeline mid-flight. Worst case the modal's
        // progress bar freezes; the on-chain pipeline still finishes
        // and the audit-commit fires on the runner's return value.
        console.warn('[runDistribute] progress bus failed:', err)
      }
    }

    // UserOp 2 — openEpoch. Bus phase 'idle' → 'start' on event emit.
    const { epochId } = await client.openEpoch(previewToken as Address, { onProgress })

    // UserOps 3..(3+ceil(N/50)) — snapshotAll. SDK paginates internally
    // and emits aggregate progress (`current=offset+i, total=N`). Bus
    // phase 'start' → 'escrows' on first batch event.
    await client.snapshotAll(epochId, holders, { onProgress })

    // UserOp K — finalizeSnapshot. Bus phase stays 'escrows' (pinned in
    // useAgentDistributeProgress.stageToPhase: finalizeSnapshot maps to
    // 'escrows', NOT back to 'start' — preserves monotonic bar).
    await client.finalizeSnapshot(epochId, { onProgress })

    // ── ratePerShare compute (multi-step L2-grant + decrypt dance) ──
    // The L2 grant at finalize time only reaches the kernel; cofhe's
    // permit-based decrypt checks ACL against the permit's signer
    // (the eph, since kernels can't sign per ADR-009). Mirror
    // DistributePage's pattern: try the refresh, log + proceed on
    // failure (the eph might already have ACL via some other path),
    // then decrypt. Empty / zero-handle rejects.
    //
    // UX-M-2 + FD-M-1 (round-1 review): bridge the otherwise-silent
    // ~1-2s window between `finalizeSnapshot` and `fundEpoch`'s
    // `'encrypt'` event with synthetic bus messages so the bar's
    // active-step hint reflects what's actually happening. Without
    // these, the bar sits on `'escrows'` showing the stale "Epoch K
    // finalised" message + no animation — biggest "is it stuck?"
    // trust dip in the surface.
    progress.setMessageForRun(runId, 'Reading encrypted supply…')
    const fhe = useFhe()
    // CR2-M-1 (round-2 review): `getEphemeralEOA()` materializes a key
    // on first call via `useFhe.ensureEphemeralKey()` — it can never
    // return null or the zero address under current contracts. The
    // prior zero-address branch was unreachable.
    const eph = fhe.getEphemeralEOA() as Address
    try {
      // UserOp K+1 (or silent on a warm session — operator should
      // confirm on the first walkthrough; documented as Open Q1 in
      // the rewire plan).
      await SnapshotService.refreshSnapshotSupplyGrant(snapshotAddr as Address, epochId, eph)
    } catch (refreshErr) {
      // Same posture as DistributePage.decryptSupplyFromChain —
      // proceed to decrypt anyway; if the eph happens to already
      // have ACL, it'll succeed; if not, the decrypt failure surfaces
      // as the runner's catch path with a clear cofhe error.
      console.warn('[runDistribute] refreshSnapshotSupplyGrant failed (proceeding to decrypt):', refreshErr)
    }

    const supplyHandle = await SnapshotService.getEpochTotalSupplyHandle(snapshotAddr as Address, epochId)
    if (!supplyHandle) {
      throw new AgentActionRunnerError(
        `Snapshot supply handle is uninitialised for distribution round ${epochId} — finalize may have silent-failed.`,
      )
    }
    const supply = await fhe.decryptSnapshotSupplyForView(supplyHandle)
    if (supply <= 0n) {
      throw new AgentActionRunnerError(
        `Decrypted snapshot supply is ${supply} for distribution round ${epochId}. Cannot distribute against zero supply — the snapshot may have captured no held shares.`,
      )
    }
    progress.setMessageForRun(runId, 'Computing per-share rate…')
    const ratePerShare = (totalYield * RATE_SCALE) / supply // floor division
    if (ratePerShare <= 0n) {
      // The SDK's own fundEpoch invariant is `ratePerShare > 0`. Surface
      // pre-tx with a more useful error than the SDK's `ConfigError`:
      // tell the issuer WHY (their totalYield is too small relative to
      // the snapshot supply for the per-share floor). RATE_SCALE is
      // 1_000_000 so the minimum viable totalYield is
      // `ceil(supply / RATE_SCALE)` base-6 mhUSDC units.
      const minTotalYield = (supply + RATE_SCALE - 1n) / RATE_SCALE // ceil
      // Render the human-readable mhUSDC amount with full 6-decimal
      // precision; minTotalYield can be as small as 1 base unit (= 0.000001
      // mhUSDC) when supply ≈ RATE_SCALE.
      const minTotalYieldUsd = formatMhUsdcBigInt(minTotalYield, {
        minFractionDigits: 6,
      })
      throw new AgentActionRunnerError(
        `totalYield (${totalYield}) is too small for snapshot supply (${supply}) — per-share rate would round down to zero. Increase totalYield to at least ${minTotalYield} mhUSDC base units (${minTotalYieldUsd} mhUSDC).`,
      )
    }
    // CR-M-1 (round-1 review): unreachable under the current
    // MAX_TOTAL_YIELD_USD6 = $100M cap (numerator ≤ 1e20 ≈ 2^67, well
    // below 2^128 regardless of supply ≥ 1). Kept as defense-in-depth
    // mirror of the SDK's own invariant — a future cap-raise reviewer
    // shouldn't drop it without re-verifying the bound.
    if (ratePerShare > (1n << 128n) - 1n) {
      throw new AgentActionRunnerError(
        `Computed ratePerShare (${ratePerShare}) overflows uint128.`,
      )
    }

    // UserOp K+2 — fundEpoch. SDK encrypts totalYield, transfers
    // mhUSDC, stores ratePerShare cleartext on-chain. Bus phase
    // 'escrows' → 'fund' on the SDK's 'fundEpoch' event (the 'encrypt'
    // event that fires first is mapped to null in stageToPhase to
    // avoid spurious phase regressions).
    const fundTxHash = await client.fundEpoch(epochId, totalYield, ratePerShare, { onProgress })

    progress.markSettledForRun(runId)
    return { kind: 'settled', txHash: fundTxHash }
  } catch (err) {
    // Only mark the bus failed if the SDK pipeline actually started
    // emitting progress events — otherwise pre-flight failures (kernel
    // binding mismatch, totalYield cap, setOperator revert before any
    // onProgress fires) would paint a misleading red step-1 in the
    // 3-phase bar. The standard error banner already surfaces the
    // error to the user; the 3-phase bar is for in-flight failures
    // where the issuer wants to know WHICH step blew up.
    const phase = progress.state.value.phase
    if (phase === 'start' || phase === 'escrows' || phase === 'fund') {
      try {
        progress.markFailedForRun(runId)
      } catch (busErr) {
        // Defensive: a markFailed throw (HMR / frozen state) must not
        // mask the real error from the user. The bus might end up
        // stuck at the active phase, which is a UX papercut but not
        // worse than the original failure. (Reality F4.)
        console.warn('[runDistribute] markFailed failed:', busErr)
      }
    }
    throw err
  }
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
  // Round-2 review CR-M3: extended to also invalidate the
  // distribution + epochs stores so a settled distribute_yield action
  // surfaces the new epoch immediately when the issuer navigates to
  // /distribute or /yields. The KYC path (unpause_token / kyc_add /
  // kyc_remove) doesn't strictly need these resets, but invalidating
  // them is harmless — next page visit re-fetches from chain.
  // Promise.allSettled posture so a single store-module load failure
  // (HMR / dynamic-import error) doesn't sink the others.
  await Promise.allSettled([
    import('@/stores/issuer-tokens').then((m) => m.useIssuerTokensStore().reset()),
    import('@/stores/issuer-investors').then((m) => m.useIssuerInvestorsStore().reset()),
    import('@/stores/issuer-distribution').then((m) => m.useIssuerDistributionStore().reset()),
    import('@/stores/epochs').then((m) => m.useEpochsStore().reset()),
  ])
}
