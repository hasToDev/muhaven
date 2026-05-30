import type { RebalancePlan, RebalanceLeg, RebalanceDriftRow } from '@/composables/useRebalance'

/**
 * Wave 5 Slice 3 — pure copy helpers for the rebalance surfaces (chat toast +
 * Portfolio CTA + ConfirmModal preview). Kept Vue-free so the mapping from a
 * computed `RebalancePlan` to user-facing strings is directly unit-testable.
 * All copy says `mhUSDC` (never PUSDC) per CLAUDE.md naming.
 */

/** bps → human percent, e.g. 500 → "5%", 1234 → "12.34%". */
export function bpsToPct(bps: number): string {
  const pct = bps / 100
  // Trim trailing zeros: 5 → "5%", 12.34 → "12.34%".
  return `${parseFloat(pct.toFixed(2))}%`
}

/** "Sell 14 CETES · Buy 1 USTBL" — sells first, matching execution order. */
export function rebalanceLegsSummary(legs: RebalanceLeg[]): string {
  return legs
    .map((l) => `${l.kind === 'sell' ? 'Sell' : 'Buy'} ${l.shares} ${l.symbol}`)
    .join(' · ')
}

/**
 * Map a NON-leg plan to a toast spec. Returns null for `status: 'legs'` (that
 * path opens the ConfirmModal instead of toasting). Severity maps to the
 * vue-sonner method the caller invokes.
 */
export function describeRebalancePlanShortfall(
  plan: RebalancePlan,
): { severity: 'info' | 'success' | 'error'; title: string; description: string } | null {
  switch (plan.status) {
    case 'legs':
      return null
    case 'no_targets':
      return {
        severity: 'info',
        title: 'Set your target allocations first',
        description:
          'Open the Portfolio page and set your target mix (must total 100%), then ask me to rebalance.',
      }
    case 'no_value':
      return { severity: 'info', title: 'Nothing to rebalance', description: plan.reason }
    case 'balanced':
      return {
        severity: 'success',
        title: 'Already balanced',
        description: `Your largest drift is ${bpsToPct(plan.maxDriftBps)}, within your ${bpsToPct(
          plan.toleranceBps,
        )} tolerance — no rebalance needed.`,
      }
    case 'sell_exceeds_instant':
      return {
        severity: 'info',
        title: 'Sell too large to rebalance in one step',
        description: `Selling ${plan.tokens.join(', ')} exceeds the instant-redeem limit, so it would settle via the redemption queue — and the buys can't be funded until it clears. Sell ${plan.tokens.join(', ')} on its own first (Trade page), then rebalance again once it settles.`,
      }
    case 'all_below_min':
      return {
        severity: 'info',
        title: 'Nothing to rebalance right now',
        description: `Your mix has drifted (largest ${bpsToPct(
          plan.maxDriftBps,
        )}), but each adjustment${
          plan.belowMin.length ? ` (${plan.belowMin.join(', ')})` : ''
        } is below the token's minimum investment — there's nothing executable this round.`,
      }
    case 'insufficient_funds':
      return {
        severity: 'info',
        title: 'Not enough balance to buy your targets',
        description: `Even after selling your overweight holdings, you don't have enough mhUSDC to buy ${plan.tokens.join(
          ', ',
        )} (not even one share) — so there's nothing to do. Wrap more USDC into mhUSDC on the Cash page and rebalance again, or lower the target.`,
      }
    case 'cannot_deploy':
      return {
        severity: 'info',
        title: 'Target too small to buy a whole share',
        description: plan.tokens.length
          ? `Even counting your mhUSDC, your target slice for ${plan.tokens.join(
              ', ',
            )} is smaller than one whole share at its current price — so the whole rebalance is blocked until it's feasible. Raise ${plan.tokens.join(
              ', ',
            )}'s target %, wrap more mhUSDC, grow your portfolio, or buy ${plan.tokens.join(
              ', ',
            )} directly first.`
          : `This rebalance has nothing it can buy, so there's no sale to make. Adjust your targets or wrap more mhUSDC first.`,
      }
    case 'error':
      return { severity: 'error', title: 'Rebalance failed', description: plan.reason }
    default: {
      // Exhaustiveness guard (CR N-2): a future RebalancePlan status that
      // forgets a copy mapping becomes a COMPILE error here, not a silent
      // no-feedback no-op.
      const _exhaustive: never = plan
      void _exhaustive
      return null
    }
  }
}

/**
 * Secondary notices for a `status: 'legs'` plan — excluded tokens (balance
 * couldn't be read) and leg-cap truncation. Never silently drops coverage
 * (the "no silent caps" rule). Empty array when there's nothing to flag.
 */
export function rebalanceNotices(plan: Extract<RebalancePlan, { status: 'legs' }>): string[] {
  const out: string[] = []
  if (plan.excluded.length > 0) {
    const names = plan.excluded.map((r: RebalanceDriftRow) => r.symbol).join(', ')
    out.push(
      `Couldn't read your balance for ${names} — excluded from this rebalance. The rest were rebalanced among themselves.`,
    )
  }
  if (plan.belowMin.length > 0) {
    out.push(
      `Skipped ${plan.belowMin.join(', ')} — the adjustment was below the token's minimum investment.`,
    )
  }
  if (plan.unaffordable.length > 0) {
    out.push(
      `Skipped buying ${plan.unaffordable.join(', ')} — not enough mhUSDC (cash + sell proceeds) to fund it this round. Wrap more mhUSDC or re-run after your sells settle.`,
    )
  }
  if (plan.truncated > 0) {
    out.push(
      `Capped at ${plan.legs.length} legs — ${plan.truncated} smaller adjustment(s) were skipped this round. Re-run to continue.`,
    )
  }
  return out
}
