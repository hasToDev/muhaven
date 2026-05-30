// Pure decision logic for the /trade Buy affordability gate.
//
// Why this MUST live client-side: on Fhenix, mhUSDC balances are encrypted
// (`euint64`). An on-chain reject of an under-funded buy is IMPOSSIBLE — the
// comparison `balance >= cost` yields an `ebool` the EVM can't branch on, and
// revealing it is async (multi-block coprocessor decrypt). That is exactly why
// `MuHavenSubscription.purchase` uses a silent-fail `FHE.select` (mints 0
// shares) instead of reverting (CoFHE pattern #3). The only place an
// under-funded buy can be rejected synchronously is the client, AFTER the
// owner decrypts their OWN balance off-chain via permit (the "Reveal" button —
// zero tx, zero side-channel leak). So this gate is THE fix, not a fallback.
//
// Three states for buy mode (sell mode is never gated here):
//   - unknown:      balance still encrypted (null) + a cost is typed → we
//                   genuinely cannot know affordability → require a Reveal first.
//   - insufficient: balance revealed + < cost → block (the tx would silent-fail
//                   and the user would pay gas for 0 shares).
//   - clear:        balance revealed + >= cost → allow.

export interface BuyGateInput {
  mode: 'buy' | 'sell'
  /** Decrypted mhUSDC balance in base units, or `null` when still encrypted. */
  mhUsdcBalance: bigint | null
  /** Estimated buy cost in mhUSDC base units, or `null` when no amount typed. */
  estimatedCost: bigint | null
}

/**
 * True when buy mode + a cost is typed + the balance is still encrypted.
 * In this state the affordability of the buy is genuinely unknown to the
 * client; the CTA must be blocked and a Reveal prompted before submit.
 */
export function isMhUsdcUnknown(i: BuyGateInput): boolean {
  return i.mode === 'buy' && i.mhUsdcBalance === null && i.estimatedCost !== null
}

/**
 * True when buy mode + balance is revealed (non-null) + it can't cover the
 * typed cost. This is the cleartext affordability check that takes over once
 * the user has revealed their balance.
 */
export function isMhUsdcInsufficient(i: BuyGateInput): boolean {
  return (
    i.mode === 'buy' &&
    i.mhUsdcBalance !== null &&
    i.estimatedCost !== null &&
    i.estimatedCost > i.mhUsdcBalance
  )
}

/**
 * True when a buy must be blocked on mhUSDC — either the balance is unknown
 * (reveal first) or it's revealed and insufficient. Convenience union for the
 * CTA's disabled state.
 */
export function isBuyBlockedOnMhUsdc(i: BuyGateInput): boolean {
  return isMhUsdcUnknown(i) || isMhUsdcInsufficient(i)
}
