/**
 * Wave 5 Q3 (step 3) — `/operator/alert` request validation + rendering.
 *
 * Pure helpers extracted from `index.ts` so the bot worker's main entry
 * point stays a thin Express wiring layer + the validation / formatting
 * logic stays unit-testable without standing up the full HTTP server.
 *
 * Counterpart to backend
 * `backend/src/infrastructure/operator/operator-alert-transport.ts` →
 * `HttpOperatorAlertTransport`. The backend already composes a plaintext
 * `message` from a sanitized `OperatorAlertPayload`; the bot's job is to
 * (a) authenticate (service secret in `index.ts`), (b) validate the
 * shape (here), (c) escape MarkdownV2 reserved characters, (d) prepend
 * a severity emoji, (e) send.
 *
 * Hardening invariants:
 *   - Service-secret check + this validator BOTH fire on every request
 *     (defense in depth — a compromised intermediary can't slip a
 *     malformed payload past the service-secret gate).
 *   - `chatId` regex `/^-?\d{1,32}$/` matches the existing
 *     `intent-notify.ts` constraint — covers user-private chats AND
 *     supergroups (`-100…`).
 *   - `message` length capped at 1024 chars BEFORE escaping. After
 *     MarkdownV2 escaping the on-wire string can grow by up to ~2×
 *     (every reserved char becomes 2 chars), but Telegram's per-message
 *     cap is 4096 — 2048 fits comfortably with the severity-emoji
 *     prefix and any future renderer additions.
 *   - The renderer never invokes anything that could throw; the only
 *     side effect is producing the rendered text. Send-failure handling
 *     happens at the Express layer (200 even on send error, mirrors
 *     `intent-notify.ts:188-196`).
 *
 * INVARIANT (codified per Q3 plan C.1, Security Engineer #10): the bot
 * worker MUST NOT add any backend-callback endpoint for `/operator/alert`
 * replies (no "operator clicks ACK" feature). If a future feature ever
 * adds one, the new endpoint goes through the same `x-muhaven-service-
 * secret` gate as the existing intent endpoints — operator alerts are
 * one-way, broadcast-style, intentionally.
 */

import { escapeMarkdownV2 } from './telegram-api.js';

export type OperatorAlertSeverity = 'info' | 'warn' | 'error';

export interface OperatorAlertBody {
  chatId?: unknown;
  message?: unknown;
  severity?: unknown;
}

export interface ValidatedOperatorAlert {
  chatId: string;
  message: string;
  severity: OperatorAlertSeverity;
}

// Round-2 API-Tester HIGH-1 — reject leading zeros at the validator
// so the bot's constant-time string compare against the configured
// `OPERATOR_TELEGRAM_CHAT_ID` is sound. `'00012345'` and `'12345'` are
// the same Telegram chat numerically but the lexical compare would 403
// (or vice-versa). The regex `^-?(?:0|[1-9]\d{0,31})$` accepts `0`,
// positive integers without leading zeros, and negative integers up to
// 32 digits (Telegram's supergroup IDs are 13 digits today, well under
// the cap).
const CHAT_ID_RE = /^-?(?:0|[1-9]\d{0,31})$/;
const MESSAGE_MAX = 1024;
const SEVERITY_VALUES: readonly OperatorAlertSeverity[] = ['info', 'warn', 'error'];

// Round-2 API-Tester HIGH-2 — lone UTF-16 surrogates in the message
// silent-fail at Telegram with `400 Bad Request`, which the bot's catch
// returns as 200 send-failed → operator never sees the alert. Reject
// pre-send. `containsLoneSurrogate` walks the string code-unit by code-
// unit and refuses if any high surrogate isn't followed by a low (or
// vice versa).
function containsLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate must be immediately followed by a low surrogate.
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // skip the matched low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without a preceding high.
      return true;
    }
  }
  return false;
}

export function validateOperatorAlertBody(
  body: OperatorAlertBody | null,
):
  | { ok: true; value: ValidatedOperatorAlert }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'malformed body' };
  }
  if (typeof body.chatId !== 'string' || !CHAT_ID_RE.test(body.chatId)) {
    return { ok: false, error: 'invalid chatId' };
  }
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return { ok: false, error: 'invalid message' };
  }
  if (body.message.length > MESSAGE_MAX) {
    return { ok: false, error: 'message too long' };
  }
  if (containsLoneSurrogate(body.message)) {
    return { ok: false, error: 'invalid utf-16 message' };
  }
  if (
    typeof body.severity !== 'string' ||
    !SEVERITY_VALUES.includes(body.severity as OperatorAlertSeverity)
  ) {
    return { ok: false, error: 'invalid severity' };
  }
  return {
    ok: true,
    value: {
      chatId: body.chatId,
      message: body.message,
      severity: body.severity as OperatorAlertSeverity,
    },
  };
}

/**
 * Render the alert body for Telegram. Severity emoji prepended to the
 * first line; full message body is MarkdownV2-escaped line by line so
 * any reserved char in the backend-composed plaintext (e.g. `.` in
 * `0.05%`, `_` in `enc_total_yield`, `(` in `RateOverflowError(USYC=…)`)
 * doesn't make Telegram silently drop the message.
 *
 * The emoji set matches the v3.1 plan C.1:
 *   info  → ℹ️
 *   warn  → ⚠️
 *   error → 🚨
 */
export function renderOperatorAlert(alert: ValidatedOperatorAlert): string {
  const emoji = severityEmoji(alert.severity);
  const escaped = escapeMarkdownV2(alert.message);
  return `${emoji} ${escaped}`;
}

export function severityEmoji(severity: OperatorAlertSeverity): string {
  switch (severity) {
    case 'info':
      return 'ℹ️';
    case 'warn':
      return '⚠️';
    case 'error':
      return '🚨';
  }
}
