import { OracleClient, SubscriptionClient, tokenRegistryAbi } from '@muhaven/sdk'
import type { Address } from 'viem'
import type { ActionDescriptor } from '@/services/api'
import { agentToolsApi } from '@/services/api'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { buildReadContext, getPublicClient } from '@/services/v35/context'
import { BPS_TOTAL } from '@/stores/rebalanceTargets'

/**
 * Wave 5 Slice 3 — in-app rebalance drift compute (CLIENT-SIDE, permit-gated).
 *
 * The browser is the ONLY place the rebalance legs can be computed: drift =
 * (encrypted balance × public NAV) vs. the user's saved target allocations,
 * and only the user's decrypt permit can read the balance. The LLM cannot
 * (privacy invariant R-8); the backend cannot. So the flow is:
 *   compute legs here → POST the explicit legs to `/agent/tools/propose_rebalance`
 *   (mints the hash-bound confirm token) → ConfirmModal → `runRebalance`
 *   executes all legs in ONE silent atomic UserOp.
 *
 * NAV is read from the on-chain `IssuerControlledOracle` (the same source the
 * Portfolio page uses — base-6 PUSDC units → USD/whole-share), so the drift
 * weights match what the user sees on /portfolio. Backend `latest_nav.nav`
 * (often par=1.0 on testnet) is the last-resort fallback only.
 *
 * Balances are decrypted in-place here (NOT via `portfolio.decryptHolding`,
 * which mutates the shared `portfolio.error` ref and would flip the Portfolio
 * page into its full-page error state). A per-token decrypt failure (e.g. the
 * cofhe-TN deep-handle chain-length cap, `project_cofhe_tn_chain_length_cap`)
 * EXCLUDES that token from the rebalance and surfaces a notice — it never
 * fails the whole preview.
 */

/** Skip legs worth less than this (USD) — churn guard beyond the integer-share
 *  floor. The 5% tolerance band is the primary "don't rebalance" gate; this
 *  stops a single sub-dollar leg from sneaking through once we DO rebalance. */
export const MIN_LEG_USD = 1
/** Hard ceiling — matches the backend `ProposeRebalanceDtoSchema` `.max(8)` and
 *  the kernel batch ceiling. */
export const MAX_LEGS = 8

export interface RebalanceDriftRow {
  tokenAddress: `0x${string}`
  symbol: string
  navUsd: number
  /** Decrypted share balance, or null when the balance could not be read. */
  balanceShares: bigint | null
  valueUsd: number
  /** Current weight in bps of the (included) RWA portfolio value. */
  currentBps: number
  targetBps: number
  /** currentBps − targetBps (positive = overweight → candidate sell). */
  driftBps: number
  /** True when the balance decrypt failed → excluded from totals + legs. */
  excluded: boolean
}

export interface RebalanceLeg {
  kind: 'sell' | 'buy'
  tokenAddress: `0x${string}`
  symbol: string
  /** Integer share count (fhERC-20 shares have no decimals). */
  shares: string
  maxSharesHint: string
  estValueUsd: number
}

export type RebalancePlan =
  | { status: 'no_targets' }
  | { status: 'no_value'; reason: string }
  | {
      status: 'balanced'
      rows: RebalanceDriftRow[]
      maxDriftBps: number
      toleranceBps: number
    }
  | {
      // The portfolio HAS drifted past tolerance, but every computed leg fell
      // below its token's on-chain minInvestment → nothing executable this
      // round. Distinct from 'balanced' so the copy doesn't claim "no drift".
      status: 'all_below_min'
      belowMin: string[]
      maxDriftBps: number
      toleranceBps: number
    }
  | {
      status: 'legs'
      legs: RebalanceLeg[]
      rows: RebalanceDriftRow[]
      maxDriftBps: number
      toleranceBps: number
      excluded: RebalanceDriftRow[]
      /** Count of candidate legs dropped by the MAX_LEGS cap (0 normally). */
      truncated: number
      /** Symbols of legs dropped because they fell below the token's on-chain
       *  `minInvestment` (would revert the atomic batch). */
      belowMin: string[]
      /** Symbols of BUY legs skipped because the available mhUSDC (cash + sell
       *  proceeds) can't fund them — they'd silent-fail on-chain otherwise. */
      unaffordable: string[]
    }
  | {
      // Every BUY leg was unaffordable and there were no sells to fund them
      // (e.g. you'd need to deploy cash you don't have). Nothing executable.
      status: 'insufficient_funds'
      tokens: string[]
    }
  | {
      // A sell leg would exceed the token's remaining instant-redeem cap →
      // it escalates to the redemption queue, whose proceeds DON'T credit
      // mhUSDC synchronously. The dependent buy legs in the same atomic UserOp
      // would then under-fund and silent-fail (a successful-looking tx that
      // did half the trade). Refuse the mixed batch; the user runs the large
      // sell on its own first (it settles via the queue), then re-rebalances.
      status: 'sell_exceeds_instant'
      tokens: string[]
    }
  | { status: 'error'; reason: string }

/**
 * Per-token on-chain execution constraint gathered by `computeRebalancePlan`.
 */
export interface LegExecutionConstraint {
  /** `TokenConfig.minInvestment` (share units). A leg below this reverts. */
  minInvestmentShares: bigint
  /** Remaining instant-redeem capacity (base-6); null for buy tokens / on a
   *  failed read (escalation guard skipped for that token, logged). */
  instantCapRemainingBase6: bigint | null
}

/**
 * PURE post-drift execution feasibility pass (unit-testable). Given the legs
 * plan + per-token on-chain constraints:
 *   - drop legs below `minInvestment` (they'd revert the whole atomic UserOp),
 *     surfaced via `belowMin`;
 *   - if any remaining SELL would escalate to the redemption queue while BUYS
 *     are present, refuse the mixed batch (`sell_exceeds_instant`) — the queued
 *     sell's proceeds can't fund the buys in the same UserOp.
 */
export function applyExecutionConstraints(
  plan: Extract<RebalancePlan, { status: 'legs' }>,
  constraints: Map<string, LegExecutionConstraint>,
): RebalancePlan {
  const belowMin: string[] = []
  const kept: RebalanceLeg[] = []
  for (const leg of plan.legs) {
    const c = constraints.get(leg.tokenAddress.toLowerCase())
    if (c && BigInt(leg.shares) < c.minInvestmentShares) {
      belowMin.push(leg.symbol)
      continue
    }
    kept.push(leg)
  }

  const hasBuy = kept.some((l) => l.kind === 'buy')
  if (hasBuy) {
    const escalating: string[] = []
    for (const leg of kept) {
      if (leg.kind !== 'sell') continue
      const c = constraints.get(leg.tokenAddress.toLowerCase())
      // CR M-2: a sell with an UNKNOWN cap (read failed) coexisting with buys
      // is treated CONSERVATIVELY as would-escalate. Skipping it here would
      // re-open the exact silent-half-trade blocker this status exists to
      // close — a benign "try again / sell it separately" beats a
      // successful-looking tx that funded no buys. (With no buys present this
      // whole block is skipped, so a sell-only batch still queues safely.)
      if (!c || c.instantCapRemainingBase6 === null) {
        escalating.push(leg.symbol)
        continue
      }
      // hintCost (base-6) = maxSharesHint × nav = estValueUsd × 1e6 (shares ===
      // maxSharesHint in buildRebalancePlan). Strict `>` MATCHES the contract's
      // `used + hintCost > cap` (`MuHavenSubscription.sol:446`). Accepted as an
      // ESTIMATE, not a guarantee: (L-1) the `(x/1e6)*1e6` Number round-trip can
      // deviate ~±2.4e-4 base-6 at an exact boundary, and (L-2) estValueUsd may
      // use a backend-NAV fallback if the oracle read failed — both bounded by
      // the on-chain silent-fail backstop, and a near-boundary miss is far rarer
      // than the read-failure case M-2 already handles conservatively.
      const costBase6 = leg.estValueUsd * 1e6
      if (costBase6 > Number(c.instantCapRemainingBase6)) escalating.push(leg.symbol)
    }
    if (escalating.length > 0) {
      return { status: 'sell_exceeds_instant', tokens: escalating }
    }
  }

  if (kept.length === 0) {
    // Everything was dropped by min-investment — the portfolio is drifted but
    // nothing is executable. NOT 'balanced' (that would claim no drift); a
    // dedicated status keeps the copy truthful + carries the `belowMin` reason.
    return {
      status: 'all_below_min',
      belowMin,
      maxDriftBps: plan.maxDriftBps,
      toleranceBps: plan.toleranceBps,
    }
  }

  return { ...plan, legs: kept, belowMin }
}

/**
 * PURE buy-affordability pass (unit-testable). The buy legs are funded in-batch
 * by the user's existing mhUSDC PLUS the sell legs' instant proceeds. A buy
 * whose cost exceeds the running budget would silent-fail on-chain (you'd "buy
 * 0"), so we SKIP it here + surface it in `unaffordable` rather than producing
 * a doomed leg. Buys are funded largest-first (biggest drift correction first),
 * cumulatively, so the kept buys' total never exceeds the budget → they all
 * settle. If every buy is unaffordable AND there are no sells, there's nothing
 * to do (`insufficient_funds`).
 *
 * @param mhUsdcBase6 the user's decrypted mhUSDC balance (base-6); pass 0n when
 *   it couldn't be read (conservative — buys then funded by sell proceeds only).
 */
export function applyBudgetConstraints(
  plan: Extract<RebalancePlan, { status: 'legs' }>,
  mhUsdcBase6: bigint,
): RebalancePlan {
  const sells = plan.legs.filter((l) => l.kind === 'sell')
  const buys = plan.legs.filter((l) => l.kind === 'buy')
  if (buys.length === 0) return plan // nothing to fund

  // The user's mhUSDC is exact; the sell PROCEEDS are an estimate (floored-share
  // × compute-time NAV, minus base-6 rounding + the Slice-1.5 clamp). Haircut
  // the proceeds slightly (CR L-1) so a buy funded at exactly the estimated
  // budget isn't shipped only to silent-fail on-chain by a sub-cent shortfall —
  // it's surfaced as `unaffordable` (a clear "re-run after sells settle") instead.
  const SELL_PROCEEDS_HAIRCUT = 0.999
  const sellProceedsUsd = sells.reduce((s, l) => s + l.estValueUsd, 0) * SELL_PROCEEDS_HAIRCUT
  let remaining = Number(mhUsdcBase6) / 1e6 + sellProceedsUsd

  const keptBuys: RebalanceLeg[] = []
  const unaffordable: string[] = []
  // Largest-impact buys first so the cash funds the biggest corrections.
  for (const buy of [...buys].sort((a, b) => b.estValueUsd - a.estValueUsd)) {
    if (buy.estValueUsd <= remaining) {
      keptBuys.push(buy)
      remaining -= buy.estValueUsd
    } else {
      unaffordable.push(buy.symbol)
    }
  }

  if (keptBuys.length === 0 && sells.length === 0) {
    // Only buys were requested and none can be funded.
    return { status: 'insufficient_funds', tokens: unaffordable }
  }

  // Re-assemble sells-first, buys ordered by impact (matches funding order).
  const legs: RebalanceLeg[] = [...sells, ...keptBuys]
  return { ...plan, legs, unaffordable: [...plan.unaffordable, ...unaffordable] }
}

/**
 * Per-token input to the pure drift math — gathered by `computeRebalancePlan`
 * (chain reads + decrypt) then fed to `buildRebalancePlan`. A null `navUsd` or
 * null `balanceShares` marks the token EXCLUDED (no NAV / decrypt failed).
 */
export interface RebalanceTokenInput {
  tokenAddress: `0x${string}`
  symbol: string
  navUsd: number | null
  balanceShares: bigint | null
  targetBps: number
}

/**
 * PURE drift → legs math (no chain / no decrypt — unit-testable). Given the
 * gathered per-token inputs + tolerance, produce the plan: renormalise target
 * weights over the INCLUDED set, short-circuit when max|drift| < tolerance,
 * else build minimal sell/buy legs (sells first, dust-filtered, capped at
 * MAX_LEGS keeping the largest-impact legs).
 */
export function buildRebalancePlan(
  toleranceBps: number,
  inputs: RebalanceTokenInput[],
): RebalancePlan {
  const rows: RebalanceDriftRow[] = inputs.map((inp) => {
    const excluded = inp.navUsd === null || inp.balanceShares === null
    const valueUsd =
      !excluded && inp.balanceShares !== null && inp.navUsd !== null
        ? Number(inp.balanceShares) * inp.navUsd
        : 0
    return {
      tokenAddress: inp.tokenAddress,
      symbol: inp.symbol,
      navUsd: inp.navUsd ?? 0,
      balanceShares: excluded ? null : inp.balanceShares,
      valueUsd,
      currentBps: 0,
      targetBps: inp.targetBps,
      driftBps: 0,
      excluded,
    }
  })

  const included = rows.filter((r) => !r.excluded)
  const excludedRows = rows.filter((r) => r.excluded)
  const totalValue = included.reduce((s, r) => s + r.valueUsd, 0)

  if (totalValue <= 0) {
    return {
      status: 'no_value',
      reason:
        excludedRows.length > 0
          ? 'Could not read your encrypted balances for the targeted tokens, so there is nothing to rebalance right now. Try again in a moment.'
          : 'You hold no value in your targeted tokens yet — buy into them first, then rebalance toward your targets.',
    }
  }

  // Renormalise target weights over the INCLUDED set so an excluded token
  // doesn't skew the denominator (its target bps is dropped and the rest
  // renormalised). Surfaced to the user via `excluded`.
  const includedTargetBpsSum = included.reduce((s, r) => s + r.targetBps, 0)
  const renormTargetBps = (r: RebalanceDriftRow): number =>
    includedTargetBpsSum > 0 ? (r.targetBps / includedTargetBpsSum) * BPS_TOTAL : 0

  let maxDriftBps = 0
  for (const r of included) {
    r.currentBps = Math.round((r.valueUsd / totalValue) * BPS_TOTAL)
    r.driftBps = r.currentBps - Math.round(renormTargetBps(r))
    const abs = Math.abs(r.driftBps)
    if (abs > maxDriftBps) maxDriftBps = abs
  }

  if (maxDriftBps < toleranceBps) {
    return { status: 'balanced', rows, maxDriftBps, toleranceBps }
  }

  interface Candidate extends RebalanceLeg {
    absValue: number
  }
  const candidates: Candidate[] = []
  for (const r of included) {
    if (r.navUsd <= 0) continue
    const targetValue = (renormTargetBps(r) / BPS_TOTAL) * totalValue
    const deltaValue = targetValue - r.valueUsd
    const absValue = Math.abs(deltaValue)
    if (absValue < MIN_LEG_USD) continue
    // Floor shares — conservative: buys never overspend, sells never
    // over-request beyond the computed delta (on-chain Slice-1.5 clamp is the
    // further backstop for sells).
    const shares = BigInt(Math.floor(absValue / r.navUsd))
    if (shares <= 0n) continue
    candidates.push({
      kind: deltaValue < 0 ? 'sell' : 'buy',
      tokenAddress: r.tokenAddress,
      symbol: r.symbol,
      shares: shares.toString(),
      maxSharesHint: shares.toString(),
      estValueUsd: Number(shares) * r.navUsd,
      absValue,
    })
  }

  if (candidates.length === 0) {
    // Drift exceeded tolerance but every leg is sub-dust / sub-share.
    return { status: 'balanced', rows, maxDriftBps, toleranceBps }
  }

  candidates.sort((a, b) => b.absValue - a.absValue)
  const truncated = Math.max(0, candidates.length - MAX_LEGS)
  const kept = candidates.slice(0, MAX_LEGS)
  // Sells before buys — proceeds credit mhUSDC in-batch before buys spend it.
  const ordered = [
    ...kept.filter((c) => c.kind === 'sell'),
    ...kept.filter((c) => c.kind === 'buy'),
  ]
  const legs: RebalanceLeg[] = ordered.map(({ absValue: _a, ...leg }) => leg)

  return {
    status: 'legs',
    legs,
    rows,
    maxDriftBps,
    toleranceBps,
    excluded: excludedRows,
    truncated,
    belowMin: [], // populated by applyExecutionConstraints (on-chain pass)
    unaffordable: [], // populated by applyBudgetConstraints (mhUSDC budget pass)
  }
}

export function useRebalance() {
  /**
   * Resolve USD-per-whole-share NAV for `tokenAddress`. On-chain oracle first
   * (authoritative, base-6 → USD); backend `latest_nav.nav` (decimal string)
   * fallback when the oracle is unconfigured for the build or the read fails
   * / returns 0. Returns null when no NAV is available anywhere (token
   * excluded from the rebalance with a notice rather than mis-weighted).
   */
  async function resolveNav(
    tokenAddress: `0x${string}`,
    oracle: OracleClient | null,
    backendNavUsd: number | null,
  ): Promise<number | null> {
    if (oracle) {
      try {
        const { nav } = await oracle.getNAV(tokenAddress)
        if (nav > 0n) return Number(nav) / 1e6
      } catch (e) {
        console.warn(`[useRebalance] on-chain NAV read failed for ${tokenAddress}`, e)
      }
    }
    if (backendNavUsd !== null && backendNavUsd > 0) return backendNavUsd
    return null
  }

  /**
   * Compute the rebalance plan for `walletAddress` from the saved targets,
   * decrypted balances, and public NAV. Pure-ish: reads stores + chain, never
   * mutates portfolio state. Lazy store imports keep this callable from any
   * surface (chat, Portfolio CTA) without a circular import.
   */
  async function computeRebalancePlan(
    walletAddress: `0x${string}`,
  ): Promise<RebalancePlan> {
    const { useRebalanceTargetsStore, validateRebalanceTargets } = await import(
      '@/stores/rebalanceTargets'
    )
    const { useMarketplaceStore } = await import('@/stores/marketplace')
    const { useFhe } = await import('@/composables/useFhe')
    const TokenService = await import('@/services/contracts/TokenService')

    const targetsStore = useRebalanceTargetsStore()
    targetsStore.load(walletAddress)
    const validationReason = validateRebalanceTargets(
      targetsStore.targets,
      targetsStore.toleranceBps,
    )
    if (validationReason) {
      // Distinguish "no targets set yet" (empty → nudge to the editor) from
      // "targets exist but are invalid" (corrupt / hand-edited localStorage →
      // surface the actual reason so the user isn't told to set targets they
      // already have). CR #4.
      const hasAny = Object.keys(targetsStore.targets).length > 0
      return hasAny
        ? { status: 'error', reason: `Your saved targets are invalid: ${validationReason}` }
        : { status: 'no_targets' }
    }

    const targets = targetsStore.targets // { addrLower: bps }
    const toleranceBps = targetsStore.toleranceBps

    // Token metadata (symbol) + backend NAV fallback.
    const marketplace = useMarketplaceStore()
    if (!marketplace.loaded) {
      try {
        await marketplace.load()
      } catch (e) {
        console.warn('[useRebalance] marketplace load failed', e)
      }
    }

    const oracleConfigured = !isZeroAddress(v35Addresses.oracle)
    const oracle = oracleConfigured
      ? new OracleClient(buildReadContext(), v35Addresses.oracle)
      : null

    const fhe = useFhe()
    await fhe.initialize()

    const targetAddrs = Object.keys(targets) as `0x${string}`[]
    const inputs: RebalanceTokenInput[] = []

    for (const tokenAddress of targetAddrs) {
      const meta = marketplace.getByAddress(tokenAddress)
      const symbol = meta?.symbol ?? tokenAddress.slice(0, 8)
      const backendNavUsd = meta?.latest_nav ? parseFloat(meta.latest_nav.nav) : null
      const targetBps = targets[tokenAddress.toLowerCase()] ?? 0

      const navUsd = await resolveNav(tokenAddress, oracle, backendNavUsd)

      // Decrypt the balance. A zero handle short-circuits to 0n (unheld
      // targeted token — a pure buy candidate). A 403/timeout on a real
      // handle marks balanceShares null → excluded by `buildRebalancePlan`.
      let balanceShares: bigint | null = null
      try {
        const ctHash = await TokenService.encryptedBalanceOf(walletAddress, tokenAddress)
        balanceShares = await fhe.decryptUint128ForView(ctHash, tokenAddress)
      } catch (e) {
        console.warn(`[useRebalance] balance decrypt failed for ${symbol}; excluding`, e)
        balanceShares = null
      }

      inputs.push({ tokenAddress, symbol, navUsd, balanceShares, targetBps })
    }

    const plan = buildRebalancePlan(toleranceBps, inputs)
    if (plan.status !== 'legs') return plan

    // ── On-chain execution feasibility (CR #1 + #2) ──────────────────────
    // Gather per-token `minInvestment` (legs below it revert the atomic batch)
    // and, for SELL legs, the remaining instant-redeem cap (a sell over it
    // escalates to the redemption queue, whose proceeds can't fund the buys in
    // the same UserOp). `applyExecutionConstraints` then drops sub-min legs and
    // refuses a mixed batch when a sell would queue.
    const constraints = new Map<string, LegExecutionConstraint>()
    const publicClient = getPublicClient()
    const sub = !isZeroAddress(v35Addresses.subscription)
      ? new SubscriptionClient(buildReadContext(), v35Addresses.subscription)
      : null
    await Promise.all(
      plan.legs.map(async (leg) => {
        const lower = leg.tokenAddress.toLowerCase()
        let minInvestmentShares = 0n
        try {
          const cfg = (await publicClient.readContract({
            address: v35Addresses.tokenRegistry,
            abi: tokenRegistryAbi,
            functionName: 'getConfig',
            args: [leg.tokenAddress as Address],
          })) as unknown as { minInvestment?: bigint }
          if (typeof cfg.minInvestment === 'bigint') minInvestmentShares = cfg.minInvestment
        } catch (e) {
          console.warn(`[useRebalance] getConfig failed for ${leg.symbol}; minInvestment guard skipped`, e)
        }
        let instantCapRemainingBase6: bigint | null = null
        if (leg.kind === 'sell' && sub) {
          try {
            instantCapRemainingBase6 = await sub.getInstantCapRemaining(leg.tokenAddress as Address)
          } catch (e) {
            // Unknown cap → escalation guard skipped for this token (logged).
            // Residual risk only if the cap read fails AND the sell actually
            // escalates — rare + the on-chain silent-fail remains the backstop.
            console.warn(`[useRebalance] instant-cap read failed for ${leg.symbol}; escalation guard skipped`, e)
          }
        }
        constraints.set(lower, { minInvestmentShares, instantCapRemainingBase6 })
      }),
    )

    const constrained = applyExecutionConstraints(plan, constraints)
    if (constrained.status !== 'legs') return constrained

    // ── Buy affordability (#4) ───────────────────────────────────────────
    // Buys are funded in-batch by existing mhUSDC + the sell legs' instant
    // proceeds. Decrypt the user's mhUSDC so we can skip buy legs the budget
    // can't cover (they'd silent-fail on-chain) rather than ship a doomed leg.
    // On a decrypt failure, fund buys from sell proceeds only (mhUSDC = 0n) —
    // conservative (may skip an affordable buy, never ships an unfundable one).
    let mhUsdcBase6 = 0n
    if (constrained.legs.some((l) => l.kind === 'buy')) {
      try {
        const MuHavenStableService = await import('@/services/contracts/MuHavenStableService')
        if (MuHavenStableService.isAvailable()) {
          const ct = await MuHavenStableService.confidentialBalanceOf(walletAddress)
          mhUsdcBase6 = await fhe.decryptMhUsdcForView(ct)
        }
      } catch (e) {
        console.warn('[useRebalance] mhUSDC decrypt failed; funding buys from sell proceeds only', e)
      }
    }

    return applyBudgetConstraints(constrained, mhUsdcBase6)
  }

  /**
   * Compute the plan and, when it yields legs, mint the hash-bound confirm
   * token by POSTing the explicit legs to `/agent/tools/propose_rebalance`.
   * Returns the plan + (on `status:'legs'`) the resulting ActionDescriptor to
   * hand to the ConfirmModal. Non-leg statuses (no_targets / balanced /
   * no_value) carry no descriptor — the caller surfaces them as a toast / inline.
   */
  async function buildRebalanceProposal(
    walletAddress: `0x${string}`,
  ): Promise<{ plan: RebalancePlan; descriptor: ActionDescriptor | null }> {
    const plan = await computeRebalancePlan(walletAddress)
    if (plan.status !== 'legs') return { plan, descriptor: null }
    const descriptor = await agentToolsApi.proposeRebalance({
      legs: plan.legs.map((l) => ({
        kind: l.kind,
        tokenAddress: l.tokenAddress,
        shares: l.shares,
        maxSharesHint: l.maxSharesHint,
      })),
    })
    return { plan, descriptor }
  }

  return { computeRebalancePlan, buildRebalanceProposal, resolveNav }
}
