/**
 * Pure formatting + validation helpers for the MuHaven Telegram Mini App
 * (Wave 4 P4 mid-tier confirmation surface).
 *
 * Extracted from `main.ts` so the regex / parsing logic is testable in
 * isolation. `main.ts` keeps the DOM-glue + Telegram-host integration.
 */

/**
 * MuHaven OpenClaw intent id format — `oci_<26-char Crockford-base32>`.
 *
 * The 26-char body uses the Crockford alphabet's uppercase glyphs only
 * (no lowercase, no Crockford ambiguity-strip glyphs in practice; we
 * match on `[A-Z0-9]` to keep the regex compatible with any 26-char
 * uppercase-base32 minted upstream).
 */
export const INTENT_ID_RE = /^oci_[A-Z0-9]{26}$/;

/**
 * 6-digit OTP, `\d{6}`.
 */
export const OTP_RE = /^\d{6}$/;

export function isValidIntentId(id: string | null | undefined): id is string {
  return typeof id === 'string' && INTENT_ID_RE.test(id);
}

export function isValidOtp(otp: string | null | undefined): otp is string {
  return typeof otp === 'string' && OTP_RE.test(otp);
}

/**
 * Group a digit string with `,` thousand separators. Pure helper —
 * intentionally locale-agnostic because Telegram Mini Apps display the
 * same string regardless of the user's device locale (otherwise the
 * intent preview that the bot generated wouldn't match what the Mini
 * App renders).
 */
export function withSeparators(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a USDC 6-decimal base unit string as either `$X.YY` (under $1M)
 * or `$X` (≥$1M, cents dropped because the channel can't fit them
 * cleanly and 6dp on a >=$1M figure is usually noise).
 */
export function formatUsd(amountUsd6: string): string {
  // Throws on malformed input — caller should validate against an
  // explicit regex before passing in.
  const parsed = BigInt(amountUsd6);
  const whole = parsed / 1_000_000n;
  const cents = parsed % 1_000_000n;
  const wholeStr = whole.toString();
  if (whole < 1_000_000n) {
    const centsTwo = (cents / 10_000n).toString().padStart(2, '0');
    return `$${withSeparators(wholeStr)}.${centsTwo}`;
  }
  return `$${withSeparators(wholeStr)}`;
}
