/**
 * mhUSDC base-unit → user-visible USD formatting.
 *
 * Replaces the `(Number(units) / 1_000_000).toFixed(n)` idiom that
 * leaks precision above ~$9B (Number.MAX_SAFE_INTEGER / 1e6 ≈ 9.007e9).
 * Used by:
 *   - ConfirmModal.vue's `displayUsd` (thin wrapper)
 *   - useAgentActionRunner.ts conservation gates (runBuy / runDistribute)
 *   - any future user-facing mhUSDC copy with arbitrary-magnitude inputs
 *
 * All math is BigInt — the only IEEE-754 in this module is the optional
 * `minFractionDigits` zero-padding which is bounded by 6.
 *
 * mhUSDC has 6 decimals on chain; that scale is hard-coded here because
 * the helper is mhUSDC-specific by name. A future generic 18-decimal
 * helper would belong in a sibling export.
 */

const MHUSDC_DECIMALS = 6
const MHUSDC_SCALE = 1_000_000n

export interface FormatMhUsdcOptions {
  /** Minimum fractional digits to render. Defaults to 2 (USD convention). */
  minFractionDigits?: number
  /** Maximum fractional digits to render (cap, before trailing-zero strip). Defaults to 6. */
  maxFractionDigits?: number
  /** When true, prefixes "$" to the result. Defaults to false — callers prefix themselves. */
  withSign?: boolean
}

/**
 * Format a 6-decimal mhUSDC base-unit value. Negative inputs are
 * supported (prefixed with `-` before the optional sign).
 *
 * Examples (default opts):
 *   formatMhUsdcBigInt(0n)            → "0.00"
 *   formatMhUsdcBigInt(1n)            → "0.000001"
 *   formatMhUsdcBigInt(1_000_000n)    → "1.00"
 *   formatMhUsdcBigInt(15_500_000n)   → "15.50"
 *   formatMhUsdcBigInt(99_000_000_000_000_000n) → "99000000000.00"
 *
 * With `withSign: true`:
 *   formatMhUsdcBigInt(15_500_000n, { withSign: true }) → "$15.50"
 *
 * With wider precision (e.g. minTotalYield error copy):
 *   formatMhUsdcBigInt(1n, { minFractionDigits: 6 }) → "0.000001"
 */
export function formatMhUsdcBigInt(
  units: bigint | string,
  opts: FormatMhUsdcOptions = {},
): string {
  const minFrac = clampFrac(opts.minFractionDigits ?? 2)
  const maxFrac = clampFrac(opts.maxFractionDigits ?? MHUSDC_DECIMALS)
  // Allow `min > max`? No — clamp min down to max so a caller passing
  // a too-large minFrac (e.g. 8) still gets a sensible 6-digit cap.
  const effectiveMin = Math.min(minFrac, maxFrac)

  const big = toBigInt(units)
  const negative = big < 0n
  const abs = negative ? -big : big
  const whole = abs / MHUSDC_SCALE
  // Pad to 6 digits so leading zeros aren't lost (e.g. 1n → ".000001").
  let frac = (abs % MHUSDC_SCALE).toString().padStart(MHUSDC_DECIMALS, '0')
  // Truncate (not round) to maxFrac. Truncation matches `displayUsd`'s
  // historical behavior on ConfirmModal previews — the on-chain value
  // is the source of truth, not the rounded display copy.
  if (maxFrac < MHUSDC_DECIMALS) frac = frac.slice(0, maxFrac)
  // Strip trailing zeros down to effectiveMin digits.
  while (frac.length > effectiveMin && frac.endsWith('0')) {
    frac = frac.slice(0, -1)
  }
  // UX-H1: thousands-separated whole part so an institutional-scale
  // amount like 99 billion mhUSDC reads as `$99,000,000,000` rather
  // than `$99000000000`. Matches the dashboard's `formatUSD` convention
  // (which uses `toLocaleString('en-US')` — equivalent for whole digits).
  // Group manually because BigInt has no Intl method; insert commas
  // every 3 digits from the right.
  const wholeStr = groupThousands(whole.toString())
  const body = frac.length > 0 ? `${wholeStr}.${frac}` : wholeStr
  // Negative + withSign → "-$1.50" (USD convention). Plain negative
  // (no sign) → "-1.50".
  if (opts.withSign) {
    return negative ? `-$${body}` : `$${body}`
  }
  return negative ? `-${body}` : body
}

/**
 * Insert ASCII commas every 3 digits from the right. Pure string ops —
 * safe on BigInt-derived strings of any length. Returns `digits`
 * unchanged when shorter than 4 chars.
 *
 * Example: `groupThousands("99000000000")` → `"99,000,000,000"`.
 */
function groupThousands(digits: string): string {
  if (digits.length < 4) return digits
  const out: string[] = []
  let i = digits.length
  while (i > 3) {
    out.unshift(digits.slice(i - 3, i))
    i -= 3
  }
  out.unshift(digits.slice(0, i))
  return out.join(',')
}

function clampFrac(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > MHUSDC_DECIMALS) return MHUSDC_DECIMALS
  return Math.trunc(n)
}

function toBigInt(value: bigint | string): bigint {
  if (typeof value === 'bigint') return value
  // Reject non-integer strings up-front so a typo doesn't silently
  // BigInt-coerce a decimal (which throws SyntaxError) or a hex string
  // (which would parse as base-16 — wrong for the base-unit contract).
  // The error matches `displayUsd`'s catch-and-fallback behavior:
  // callers that pass garbage get "0" rather than a throw, since
  // these helpers run inside template renders where throwing crashes
  // the chat surface.
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}
