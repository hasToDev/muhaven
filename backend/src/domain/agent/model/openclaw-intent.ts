/**
 * OpenClaw confirmation intent (Wave 4 P4).
 *
 * An intent is a structured record minted whenever the OpenClaw skill (or
 * the Telegram bot, which is the OpenClaw gateway's user surface) wants
 * to perform a state-mutating action on behalf of a user. The intent
 * routes through one of three confirmation tiers based on amount; the
 * tier is computed at mint time and locked into the row so a malicious
 * caller can't lower it after the fact.
 *
 * Lifecycle:
 *   pending → confirmed → consumed
 *          ↘ denied
 *          ↘ expired
 *
 * Status only flips forward — application-level invariant; production
 * deploys should add a Postgres trigger as defence in depth.
 *
 * The `intentHash` is a deterministic hash over `(kind, payload, userId,
 * createdAtSec)` and is what gets surfaced in the audit log + the
 * dashboard / Mini App preview. It's NOT a UserOp hash — the broker
 * still signs the canonical UserOp at consume time.
 */

export const OpenClawIntentKind = {
  Buy: 'buy',
  Claim: 'claim',
} as const;

export type OpenClawIntentKind = (typeof OpenClawIntentKind)[keyof typeof OpenClawIntentKind];

export const OPENCLAW_INTENT_KIND_VALUES: readonly OpenClawIntentKind[] = [
  OpenClawIntentKind.Buy,
  OpenClawIntentKind.Claim,
] as const;

export const OpenClawIntentTier = {
  /** ≤ $200 — Telegram inline keyboard button. */
  Inline: 'inline',
  /** $200 — $5,000 — Mini App + 6-digit OTP. */
  MiniAppOtp: 'mini_app_otp',
  /** > $5,000 — dashboard passkey deep-link. */
  PasskeyDeeplink: 'passkey_deeplink',
} as const;

export type OpenClawIntentTier =
  (typeof OpenClawIntentTier)[keyof typeof OpenClawIntentTier];

export const OPENCLAW_INTENT_TIER_VALUES: readonly OpenClawIntentTier[] = [
  OpenClawIntentTier.Inline,
  OpenClawIntentTier.MiniAppOtp,
  OpenClawIntentTier.PasskeyDeeplink,
] as const;

export const OpenClawIntentStatus = {
  Pending: 'pending',
  Confirmed: 'confirmed',
  Consumed: 'consumed',
  Denied: 'denied',
  Expired: 'expired',
} as const;

export type OpenClawIntentStatus =
  (typeof OpenClawIntentStatus)[keyof typeof OpenClawIntentStatus];

/**
 * Tier boundaries are pinned at the type level — investors cannot raise
 * them above these ceilings (regulatory: Reg BI Care Obligation; FINRA
 * IM-2017-02 risk-control). Lowering happens via dashboard policy
 * setters (Wave 5).
 *
 * Amounts are denominated in **USDC 6-decimal units** so the JS Number
 * arithmetic stays exact — `2 ** 53` covers up to ~9 * 10^15 USDC, well
 * past any realistic single-intent ceiling.
 */
export const TIER_INLINE_MAX_USD6 = 200_000_000n; // $200
export const TIER_MINI_APP_MAX_USD6 = 5_000_000_000n; // $5,000

export interface TierThresholds {
  /** Upper bound (inclusive) for the inline tier in USDC 6-decimal units. */
  inlineMaxUsd6: bigint;
  /** Upper bound (inclusive) for the mini_app_otp tier in USDC 6-decimal units. */
  miniAppMaxUsd6: bigint;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  inlineMaxUsd6: TIER_INLINE_MAX_USD6,
  miniAppMaxUsd6: TIER_MINI_APP_MAX_USD6,
};

/**
 * Classify an intent's tier from its amount.
 *
 * Optional `thresholds` parameter is a STAGING-ONLY override surface
 * (env vars `OPENCLAW_TIER_INLINE_MAX_USD6` + `OPENCLAW_TIER_MINI_APP_MAX_USD6`
 * read at container boot, threaded into `CreateOpenClawIntentUseCase`).
 * Production deploys MUST leave the defaults; the regulator-anchored
 * ceilings are the upper bound of investor protection. Lowering them in
 * staging is the supported case (e.g., 2 mhUSDC → mid-tier so the OTP
 * surface can be exercised against tiny test amounts) — RAISING them
 * past the defaults is rejected.
 */
export function classifyTier(
  amountUsd6: bigint,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): OpenClawIntentTier {
  if (amountUsd6 < 0n) {
    throw new Error('intent amount must be non-negative');
  }
  if (thresholds.inlineMaxUsd6 > TIER_INLINE_MAX_USD6) {
    throw new Error(
      `inline tier ceiling override (${thresholds.inlineMaxUsd6}) exceeds the regulatory cap (${TIER_INLINE_MAX_USD6}); staging may LOWER the ceiling, never raise it`,
    );
  }
  if (thresholds.miniAppMaxUsd6 > TIER_MINI_APP_MAX_USD6) {
    throw new Error(
      `mini_app_otp tier ceiling override (${thresholds.miniAppMaxUsd6}) exceeds the regulatory cap (${TIER_MINI_APP_MAX_USD6}); staging may LOWER the ceiling, never raise it`,
    );
  }
  if (thresholds.inlineMaxUsd6 > thresholds.miniAppMaxUsd6) {
    throw new Error(
      `inline ceiling (${thresholds.inlineMaxUsd6}) must be ≤ mini_app_otp ceiling (${thresholds.miniAppMaxUsd6})`,
    );
  }
  if (amountUsd6 <= thresholds.inlineMaxUsd6) return OpenClawIntentTier.Inline;
  if (amountUsd6 <= thresholds.miniAppMaxUsd6) return OpenClawIntentTier.MiniAppOtp;
  return OpenClawIntentTier.PasskeyDeeplink;
}

export interface OpenClawIntentPayload {
  /** ERC-20 / fhERC-20 token address. */
  token: `0x${string}`;
  /** Amount in USDC 6-decimal units (`bigint` serialised as string). */
  amountUsd6: string;
  /** Optional: escrow id for claim intents. Stored as decimal string. */
  escrowId?: string;
  /** Free-form summary the LLM emitted, displayed verbatim in confirms. */
  summary: string;
  /** OnchainID-resolved issuer label, captured at mint time. */
  issuerLabel?: string;
}

export interface OpenClawIntentProps {
  intentId: string;
  userId: string;
  kind: OpenClawIntentKind;
  tier: OpenClawIntentTier;
  status: OpenClawIntentStatus;
  amountUsd6: bigint;
  payload: OpenClawIntentPayload;
  intentHash: string;
  /**
   * 6-digit numeric OTP for the Mini App tier. Generated at mint time;
   * delivered out-of-band via Telegram message (separate from chat). Set
   * on `tier=mini_app_otp` rows; null otherwise.
   */
  otp: string | null;
  /**
   * Telegram chat id that originated the intent (for the in-bot UX
   * round-trip). Optional — the dashboard may mint intents directly.
   */
  telegramChatId: string | null;
  /** Set when status flips to `confirmed`/`denied`/`consumed`/`expired`. */
  confirmedAt: Date | null;
  consumedAt: Date | null;
  deniedAt: Date | null;
  denyReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class OpenClawIntent implements OpenClawIntentProps {
  readonly intentId: string;
  readonly userId: string;
  readonly kind: OpenClawIntentKind;
  readonly tier: OpenClawIntentTier;
  readonly status: OpenClawIntentStatus;
  readonly amountUsd6: bigint;
  readonly payload: OpenClawIntentPayload;
  readonly intentHash: string;
  readonly otp: string | null;
  readonly telegramChatId: string | null;
  readonly confirmedAt: Date | null;
  readonly consumedAt: Date | null;
  readonly deniedAt: Date | null;
  readonly denyReason: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: OpenClawIntentProps) {
    this.intentId = props.intentId;
    this.userId = props.userId;
    this.kind = props.kind;
    this.tier = props.tier;
    this.status = props.status;
    this.amountUsd6 = props.amountUsd6;
    this.payload = props.payload;
    this.intentHash = props.intentHash;
    this.otp = props.otp;
    this.telegramChatId = props.telegramChatId;
    this.confirmedAt = props.confirmedAt;
    this.consumedAt = props.consumedAt;
    this.deniedAt = props.deniedAt;
    this.denyReason = props.denyReason;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }
}
