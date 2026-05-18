/**
 * Decimal math helpers for the MCP tool layer.
 *
 * Mirrors `backend/src/application/use-case/agent/tool/quote.use-case.ts`
 * (`parseDecimalToUsd6`) but lives inside `@muhaven/mcp` so the package
 * stays self-contained — the MCP server must not pull a backend import.
 *
 * Why string-parse + BigInt: float arithmetic on NAV values like
 * `2400.5` or `0.123457` loses precision under JS's binary64. Every
 * value rendered to the user via the MCP-built deep-link URL passes
 * through this layer, so a sub-1-share-cost computation must NOT round
 * the user into a surprise mhUSDC spend.
 *
 * Truncates fractional precision past 6 decimal places (no rounding —
 * matches the fhERC-20 `decimals=0` floor convention used by
 * `MuHavenSubscription.purchase`'s `shares * navUsd6 → mhUSDC base
 * units` arithmetic).
 */

/**
 * Parse a decimal-price string ("1.000000", "2400.5", "1", "0.01")
 * into 6-dp base units. `1.0` → `1_000_000n`, `2400.5` → `2_400_500_000n`,
 * `0.01` → `10_000n`.
 *
 * Throws on: empty / non-numeric / negative / scientific notation /
 * leading-plus / leading-dot / trailing-dot / whitespace.
 */
export function parseDecimalToUsd6(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!m) {
    throw new Error(`Invalid decimal price: ${JSON.stringify(decimal)}`);
  }
  const intPart = m[1]!;
  const fracPart = m[2] ?? '';
  const fracPadded = (fracPart + '000000').slice(0, 6);
  return BigInt(intPart + fracPadded);
}

/**
 * Compute the integer share count a `mhUSDC notional` buys at a given
 * NAV, using floor division to mirror the on-chain `Subscription.
 * purchase` arithmetic (`shares = notionalUsd6 / navUsd6` in 6dp base
 * units → integer share count).
 *
 * Returns `0n` when the notional is less than the per-share price —
 * the caller's job to surface that as an actionable error to the LLM
 * (a `0`-share buy would silent-fail on-chain).
 */
export function computeSharesFromUsd6(
  notionalUsd6: bigint,
  navUsd6: bigint,
): bigint {
  if (navUsd6 <= 0n) {
    throw new Error('navUsd6 must be positive');
  }
  if (notionalUsd6 < 0n) {
    throw new Error('notionalUsd6 must be non-negative');
  }
  return notionalUsd6 / navUsd6;
}

/**
 * Format a 6-dp base-unit value as a human-readable decimal string.
 * `1_000_000n` → `"1"`, `1_500_000n` → `"1.5"`, `123_456n` → `"0.123456"`.
 * Trailing zeros trimmed from the fractional part; integer values
 * have no decimal point.
 *
 * Used to render the user-facing "estimated cost ~X mhUSDC" alongside
 * the computed share count.
 */
export function formatUsd6AsDecimal(usd6: bigint): string {
  if (usd6 < 0n) {
    throw new Error('usd6 must be non-negative');
  }
  const whole = usd6 / 1_000_000n;
  const frac = usd6 % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}
