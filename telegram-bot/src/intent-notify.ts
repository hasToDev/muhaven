/**
 * Wave 4 P4 — `/intent/notify` request validation + preview rendering.
 *
 * Pure helpers extracted from `index.ts` so the bot worker's main entry-
 * point stays a thin Express wiring layer + the validation / formatting
 * logic stays unit-testable without standing up the full HTTP server.
 *
 * Hardening invariants:
 *   - Service-secret check + this validator BOTH fire on every request.
 *     The schema is duplicated on the backend (strict-Zod parse on the
 *     way out); we re-check here so a compromised intermediary can't
 *     slip a malformed payload past the service-secret gate.
 *   - The OTP MUST appear ONLY for `tier === 'mini_app_otp'`. A
 *     defensive cross-check rejects an inline-tier notification carrying
 *     an OTP — defense in depth against a future caller bypassing the
 *     schema (the inline tier has no Mini App button, so a leaked OTP
 *     would land in a bubble where it can't be entered).
 *   - The preview text is MarkdownV2-escaped per Bot API rules. Every
 *     dynamic substring runs through `escapeMarkdownV2`.
 */

import { escapeMarkdownV2 } from './telegram-api.js';

export interface IntentNotificationBody {
  telegramChatId?: unknown;
  intent?: {
    intentId?: unknown;
    kind?: unknown;
    tier?: unknown;
    amountUsd6?: unknown;
    intentHash?: unknown;
    expiresAt?: unknown;
    payload?: {
      token?: unknown;
      summary?: unknown;
      issuerLabel?: unknown;
      escrowId?: unknown;
    };
  };
  otp?: unknown;
}

export interface ValidatedIntentNotification {
  telegramChatId: string;
  intent: {
    intentId: string;
    kind: 'buy' | 'claim';
    tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink';
    amountUsd6: string;
    intentHash: string;
    expiresAt: string;
    payload: {
      token: string;
      summary: string;
      issuerLabel?: string;
      escrowId?: string;
    };
  };
  otp?: string;
}

const CHAT_ID_RE = /^-?\d{1,32}$/;
const INTENT_ID_RE = /^oci_[A-Z0-9]{26}$/;
const HASH_HEX_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^0x[a-fA-F0-9]{40}$/;
const OTP_RE = /^\d{6}$/;

export function validateIntentNotificationBody(
  body: IntentNotificationBody | null,
):
  | { ok: true; value: ValidatedIntentNotification }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'malformed body' };
  }
  if (typeof body.telegramChatId !== 'string' || !CHAT_ID_RE.test(body.telegramChatId)) {
    return { ok: false, error: 'invalid telegramChatId' };
  }
  const i = body.intent;
  if (!i || typeof i !== 'object') {
    return { ok: false, error: 'missing intent' };
  }
  if (typeof i.intentId !== 'string' || !INTENT_ID_RE.test(i.intentId)) {
    return { ok: false, error: 'invalid intent.intentId' };
  }
  if (i.kind !== 'buy' && i.kind !== 'claim') {
    return { ok: false, error: 'invalid intent.kind' };
  }
  if (i.tier !== 'inline' && i.tier !== 'mini_app_otp' && i.tier !== 'passkey_deeplink') {
    return { ok: false, error: 'invalid intent.tier' };
  }
  if (typeof i.amountUsd6 !== 'string' || !/^\d+$/.test(i.amountUsd6)) {
    return { ok: false, error: 'invalid intent.amountUsd6' };
  }
  if (typeof i.intentHash !== 'string' || !HASH_HEX_RE.test(i.intentHash)) {
    return { ok: false, error: 'invalid intent.intentHash' };
  }
  if (typeof i.expiresAt !== 'string' || i.expiresAt.length === 0) {
    return { ok: false, error: 'invalid intent.expiresAt' };
  }
  const p = i.payload;
  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'missing intent.payload' };
  }
  if (typeof p.token !== 'string' || !TOKEN_RE.test(p.token)) {
    return { ok: false, error: 'invalid intent.payload.token' };
  }
  if (typeof p.summary !== 'string' || p.summary.length === 0 || p.summary.length > 280) {
    return { ok: false, error: 'invalid intent.payload.summary' };
  }
  let issuerLabel: string | undefined;
  if (p.issuerLabel !== undefined) {
    if (typeof p.issuerLabel !== 'string' || p.issuerLabel.length === 0 || p.issuerLabel.length > 120) {
      return { ok: false, error: 'invalid intent.payload.issuerLabel' };
    }
    issuerLabel = p.issuerLabel;
  }
  let escrowId: string | undefined;
  if (p.escrowId !== undefined) {
    if (typeof p.escrowId !== 'string' || p.escrowId.length === 0 || p.escrowId.length > 64) {
      return { ok: false, error: 'invalid intent.payload.escrowId' };
    }
    escrowId = p.escrowId;
  }
  let otp: string | undefined;
  if (body.otp !== undefined) {
    if (typeof body.otp !== 'string' || !OTP_RE.test(body.otp)) {
      return { ok: false, error: 'invalid otp' };
    }
    otp = body.otp;
  }
  if (otp !== undefined && i.tier !== 'mini_app_otp') {
    return { ok: false, error: 'otp present on non-mini_app_otp tier' };
  }
  return {
    ok: true,
    value: {
      telegramChatId: body.telegramChatId,
      intent: {
        intentId: i.intentId,
        kind: i.kind,
        tier: i.tier,
        amountUsd6: i.amountUsd6,
        intentHash: i.intentHash,
        expiresAt: i.expiresAt,
        payload: {
          token: p.token,
          summary: p.summary,
          ...(issuerLabel ? { issuerLabel } : {}),
          ...(escrowId ? { escrowId } : {}),
        },
      },
      ...(otp ? { otp } : {}),
    },
  };
}

/**
 * Render the intent preview for the inline-keyboard message. Pure
 * function — keeps the formatter testable in isolation. Every dynamic
 * substring is escaped per MarkdownV2 rules.
 *
 * The format mirrors the issuer-channel renderer (title + detail rows
 * + summary line). Keep it short — Telegram caps message length and a
 * long preview pushes the keyboard buttons below the fold on mobile.
 */
export function renderIntentPreview(intent: ValidatedIntentNotification['intent']): string {
  const verb = intent.kind === 'buy' ? 'Buy' : 'Claim';
  const tokenShort = `${intent.payload.token.slice(0, 6)}…${intent.payload.token.slice(-4)}`;
  const usd = formatUsdFromBaseUnits(intent.amountUsd6);
  const issuer = intent.payload.issuerLabel ?? 'Unverified issuer';
  const expires = formatExpiresAt(intent.expiresAt);
  const tierTag =
    intent.tier === 'inline'
      ? 'Inline confirm'
      : intent.tier === 'mini_app_otp'
        ? 'Mini App + 6\\-digit code'
        : 'Dashboard passkey';
  const lines = [
    `*MuHaven \\- ${escapeMarkdownV2(verb)} ${escapeMarkdownV2(tokenShort)}*`,
    `_Issuer: ${escapeMarkdownV2(issuer)}_`,
    '',
    `Amount: ${escapeMarkdownV2(usd)}`,
    `Tier: ${tierTag}`,
    `Expires: ${escapeMarkdownV2(expires)}`,
    '',
    escapeMarkdownV2(intent.payload.summary),
    '',
    intent.tier === 'inline'
      ? '_Tap *Confirm* to submit on\\-chain, or *Deny* to cancel\\._'
      : intent.tier === 'mini_app_otp'
        ? '_Tap *Open Mini App*, paste the 6\\-digit code from the next message, then Confirm\\._'
        : '_Tap *Confirm in dashboard* to authorise with your passkey\\._',
  ];
  return lines.join('\n');
}

/** Render the OTP message — separate bubble, mid-tier only. */
export function renderOtpMessage(otp: string): string {
  return [
    '🔢 *MuHaven verification code*',
    '',
    `\`${escapeMarkdownV2(otp)}\``,
    '',
    'Open the Mini App from the previous message and paste this 6\\-digit code\\. Do not share it\\.',
  ].join('\n');
}

/** Format USDC 6dp base units as `$X.YY`. Locale-agnostic by design. */
export function formatUsdFromBaseUnits(amountUsd6: string): string {
  const v = BigInt(amountUsd6);
  const whole = (v / 1_000_000n).toString();
  const cents = ((v % 1_000_000n) / 10_000n).toString().padStart(2, '0');
  return `$${withSeparators(whole)}.${cents}`;
}

function withSeparators(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format an ISO-8601 expiresAt as a `HH:MM UTC` line — short enough to
 * fit one row, locale-agnostic, never falls back to the host's tz.
 */
export function formatExpiresAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm} UTC`;
}
