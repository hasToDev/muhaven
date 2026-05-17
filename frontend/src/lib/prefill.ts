/**
 * Shared helpers for parsing Path C deep-link query params.
 *
 * Path C contract: a deep-link from `@muhaven/mcp` pre-fills a form on
 * TradePage / CashPage / YieldsPage but NEVER auto-submits. Pre-fill is
 * convenience; the user must always review + tap the existing CTA.
 *
 * These helpers exist so the parsing rules are pinned in ONE place
 * (avoids the three pages drifting on what amounts/precisions to accept).
 */

export interface SanitizeAmountOptions {
  /** When true, accept decimal strings up to `maxDp` fractional digits. */
  readonly allowDecimals: boolean;
  /** Max fractional digits when `allowDecimals` is true. Default 6 (mhUSDC / USDC base unit floor). */
  readonly maxDp?: number;
}

/**
 * Sanitize a `?amount=` / `?shares=` query-string value for safe form
 * pre-fill. Returns the cleaned string when valid, or `null` to leave
 * the form field empty (Path C contract: silent reject is better than
 * surfacing an incorrect pre-fill the user might tap through).
 *
 * Rules:
 *  - Always rejects: empty string, negative, leading + or whitespace,
 *    scientific notation, thousands separators, multiple decimal points,
 *    leading zeros (`05`, `00`), leading/trailing dot (`.5`, `5.`).
 *  - When `allowDecimals: false`: rejects any input containing `.`.
 *    Used by TradePage sell mode (fhERC-20 shares are integer base
 *    units per `project_decimals_lie_wave4_p0`; "2.5 shares" would
 *    silently floor on the on-chain submit).
 *  - When `allowDecimals: true`: accepts up to `maxDp` fractional
 *    digits; truncates the trailing portion silently so the form
 *    field receives the canonical bounded form (avoids the est-cost
 *    preview vs on-chain submission divergence flagged by Frontend
 *    review H-4 / Code Reviewer L1).
 *
 * Match the regex shape used by the MCP package's
 * `decimalUsdcAmountSchema` so server-side validation + client-side
 * parsing land on the same canonical form.
 */
export function sanitizePrefillAmount(
  raw: string | undefined | null,
  options: SanitizeAmountOptions,
): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Length cap: matches the MCP schema's 48-char ceiling to keep
  // pre-fill / wire-format limits consistent.
  if (trimmed.length > 48) return null;

  if (!options.allowDecimals) {
    // Positive integer: no leading zeros allowed.
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    return trimmed;
  }

  // Decimal allowed. Same regex shape as decimalUsdcAmountSchema:
  // `0` OR a positive integer, optional fractional part of 1..maxDp digits.
  const maxDp = options.maxDp ?? 6;
  const re = new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${maxDp}})?$`);
  if (!re.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve a `?token=` query value (either symbol or 0x-address) against
 * a marketplace token list. Returns the matching token or `null` when
 * the query value didn't match anything — never falls back to a
 * default token. Silent fallback is the Frontend review's H-1 hazard
 * (LLM proposes GOLD1, dashboard silently snaps to user's most-traded
 * TBILL1, user taps Buy → wrong asset).
 *
 * Case-insensitive on both the symbol comparison and the address
 * comparison (matches the repo-boundary lowercase convention from
 * memory `feedback_address_case_at_repo_boundary`).
 */
export function resolveTokenIdentifier<T extends { address: string; symbol: string }>(
  queryToken: string | undefined | null,
  tokens: readonly T[],
): T | null {
  if (!queryToken) return null;
  const trimmed = queryToken.trim();
  if (trimmed.length === 0) return null;
  const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(trimmed);
  if (looksLikeAddress) {
    const lower = trimmed.toLowerCase();
    return tokens.find((t) => t.address.toLowerCase() === lower) ?? null;
  }
  const lower = trimmed.toLowerCase();
  return tokens.find((t) => t.symbol.toLowerCase() === lower) ?? null;
}
