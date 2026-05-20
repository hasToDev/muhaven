import { z } from 'zod';
import { getLogger } from '../../core/logger.js';

function lg() {
  return getLogger('operator-alert-transport');
}

/**
 * Wave 5 Q3 (step 3) — backend → telegram-bot operator-alert push.
 *
 * Symmetric counterpart to the bot worker's `POST /operator/alert`
 * endpoint (`telegram-bot/src/index.ts` registers the handler;
 * `telegram-bot/src/operator-alert.ts` carries the validator +
 * renderer). The transport is the ONLY caller path the cron uses to
 * fire alerts on un-recoverable yield-cron failures; the
 * `NotifyYieldCronFailureUseCase` composes the sanitizer + this
 * transport into a single entry point.
 *
 * Posture (matches `notify-intent-to-bot.use-case.ts`):
 *   - Logging fallback is the default whenever the operator hasn't
 *     wired `TELEGRAM_BOT_WORKER_URL` + `TELEGRAM_BOT_SERVICE_SECRET`
 *     + `OPERATOR_TELEGRAM_CHAT_ID`. The transport stays callable; the
 *     cron's catch path doesn't have to feature-detect.
 *   - HTTP transport uses a 5s AbortController timeout. Failures are
 *     logged at WARN + swallowed — a Telegram outage MUST NOT propagate
 *     to the cron's tick handler.
 *   - Header is `x-muhaven-service-secret` (constant-time compared on
 *     the bot side) to mirror `/intent/notify` + `/issuer-channel/
 *     broadcast`. NOT `Authorization: Bearer` — that header is reserved
 *     for the worker → backend direction (see
 *     `src/interface/middleware/with-service-secret.ts`).
 *
 * Why two interfaces (`IOperatorAlertTransport` vs `IBotIntentTransport`)
 * instead of one: their payload shapes diverge by design. Intent
 * notifications include MarkdownV2-pre-rendered preview rows + an OTP
 * leg; operator alerts are a thin severity + plaintext-message tuple.
 * Mixing them into one transport would require either (a) a union type
 * the caller has to switch on every send, or (b) a god-object payload
 * that lets the bot worker accidentally cross-deliver an operator alert
 * to a user chat. Separate interfaces enforce the privacy boundary at
 * the type level.
 */

/**
 * Strict-shape schema for the OperatorAlertPayload that
 * `IOperatorAlertTransport.notify` accepts. Defined as a Zod schema (vs
 * the hand-rolled validator the bot worker uses) so the cron's
 * `NotifyYieldCronFailureUseCase` test surface can re-use the same
 * parser to assert shape compliance under fuzzed inputs — defense in
 * depth against a future sanitizer regression letting through a 1500-
 * char `shortMessage`.
 *
 * Round-1 Backend-Arch L-1 follow-up: invoked at the HTTP wire
 * boundary inside `HttpOperatorAlertTransport.notify` so the schema is
 * a real prod-path guard, not just a test-surface assertion. A failed
 * parse logs at ERROR + DROPS the alert (refusal beats forwarding
 * garbage to the bot).
 */
export const OperatorAlertPayloadSchema = z
  .object({
    tokenSymbol: z.string().min(1).max(64),
    /** Optional — only present when a cron failure landed mid-epoch. */
    epochId: z.bigint().optional(),
    /** `err.name`; capped at 64 chars. */
    errorClass: z.string().min(1).max(64),
    /** Pre-sanitised, redacted, length-capped failure detail. */
    shortMessage: z.string().min(1).max(1024),
    severity: z.enum(['info', 'warn', 'error']),
  })
  .strict();

export type OperatorAlertPayload = z.infer<typeof OperatorAlertPayloadSchema>;

export interface IOperatorAlertTransport {
  notify(payload: OperatorAlertPayload): Promise<void>;
}

/**
 * Default transport — logs the payload + drops it. Active whenever the
 * operator hasn't wired `TELEGRAM_BOT_WORKER_URL` /
 * `TELEGRAM_BOT_SERVICE_SECRET` / `OPERATOR_TELEGRAM_CHAT_ID`. The cron's
 * catch path is the same in either configuration; only the side-effect
 * differs.
 */
export class LoggingOperatorAlertTransport implements IOperatorAlertTransport {
  async notify(payload: OperatorAlertPayload): Promise<void> {
    lg().info(
      {
        tokenSymbol: payload.tokenSymbol,
        errorClass: payload.errorClass,
        severity: payload.severity,
        epochId: payload.epochId?.toString(),
      },
      'operator alert (transport=logging)',
    );
  }
}

export interface HttpOperatorAlertTransportOpts {
  botWorkerUrl: string;
  serviceSecret: string;
  /** Chat ID the bot worker delivers the alert to. Single-recipient by
   *  design (v3.1 plan — multi-operator routing deferred). */
  chatId: string;
  timeoutMs?: number;
}

/**
 * HTTP transport — composes the plaintext message from the payload
 * fields, POSTs to `${botWorkerUrl}/operator/alert` with the shared
 * service secret. 5s AbortController timeout. Errors are logged at
 * WARN; never re-thrown to the caller.
 *
 * Why we compose the message here (vs sending structured fields to the
 * bot): the bot's `/operator/alert` body is intentionally a simple
 * `{chatId, severity, message}` tuple per v3.1 plan C.1. The bot
 * escapes MarkdownV2 + prepends a severity emoji; everything else is
 * the backend's responsibility. This split keeps the bot stateless
 * (re-usable for any future operator-alert producer) and keeps the
 * Telegram message-text contract owned by the backend (the producer
 * decides what info the operator needs to triage).
 *
 * Round-1 Backend-Arch M-2 (deferred): a future EmailOperatorAlert
 * transport would also need a rendered "what the operator sees" string
 * — at that point, lift `composeMessage` into the use-case so both
 * transports read the same composed `displayMessage`. Today's single-
 * transport story doesn't justify the refactor; the contract is owned
 * by the use case → transport edge via `OperatorAlertPayloadSchema`,
 * so a future move is mechanical.
 */
export class HttpOperatorAlertTransport implements IOperatorAlertTransport {
  constructor(private readonly opts: HttpOperatorAlertTransportOpts) {}

  async notify(payload: OperatorAlertPayload): Promise<void> {
    // Round-1 Backend-Arch L-1 — re-parse at the wire boundary so the
    // strict schema is a real runtime guard, not a test-only assertion.
    // A future sanitiser regression that produces a 1500-char
    // `shortMessage` would still TypeScript-typecheck; the parse fails
    // here and we drop the alert (log at ERROR for triage).
    const parsed = OperatorAlertPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      lg().error(
        {
          tokenSymbol: payload.tokenSymbol,
          errorClass: payload.errorClass,
          zodIssues: parsed.error.issues.slice(0, 3).map((i) => ({
            path: i.path.join('.'),
            code: i.code,
          })),
        },
        'operator alert payload failed wire-boundary validation — dropped',
      );
      return;
    }
    const message = composeMessage(parsed.data);
    const body = {
      chatId: this.opts.chatId,
      severity: parsed.data.severity,
      message,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
    try {
      const res = await fetch(`${this.opts.botWorkerUrl}/operator/alert`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-muhaven-service-secret': this.opts.serviceSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        lg().warn(
          {
            status: res.status,
            tokenSymbol: payload.tokenSymbol,
            errorClass: payload.errorClass,
          },
          'operator alert notify failed (non-2xx)',
        );
      }
    } catch (err) {
      lg().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'operator alert notify threw — telegram delivery dropped',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Build the plaintext message body the bot worker MarkdownV2-escapes.
 * Order: structured header rows first (Token / Error / optional Epoch),
 * blank line, sanitised free-text body. Operators scan top-down on
 * Telegram — the structured rows let them filter by token + error class
 * at a glance.
 *
 * `epochId` is rendered via `BigInt.toString()` to avoid serialisation
 * surprises. The cron passes the on-chain `Epoch` id (uint256); JSON
 * doesn't natively support that width but Telegram's MarkdownV2 doesn't
 * care — it's text.
 *
 * Length budget (uint256 epoch worst case):
 *   header = `Token: ` (7) + 64 + `\n` (1)
 *          + `Error: ` (7) + 64 + `\n` (1)
 *          + `Epoch: ` (7) + 78 + `\n` (1)
 *          + `\n` (1)
 *          = 231 chars max
 *   body budget = 1024 − header = 793 chars min
 *
 * The bot worker's 1024 cap is on the `message` field — we trim the
 * BODY against the post-header budget (NOT the full composed string)
 * so a partial-address walkback never crosses into the header (would
 * otherwise chew Epoch: digits — Reality L-1). The body trim returns
 * the canonical address bytes intact when the slice would have split
 * mid-address; the operator sees the address OR no address at all,
 * never a partial 39-hex prefix that's a valid Etherscan search.
 */
export function composeMessage(payload: OperatorAlertPayload): string {
  // Round-2 R2-CR HIGH + Reality L-1: pre-trim shortMessage against the
  // remaining body budget BEFORE concatenating the header. The earlier
  // post-compose slice could (a) chop a preserved address mid-stream
  // OR (b) chew Epoch: digits — both produce operator-confusing alerts
  // (`fund failed for token ` ← address missing). By trimming the
  // shortMessage in isolation, the walkback only sees body bytes and
  // the structured header is invariant.
  const header = buildHeader(payload);
  const COMPOSED_MAX = 1024;
  if (header.length >= COMPOSED_MAX) {
    // Pathological — header alone exceeds the cap. Slice header with
    // surrogate-pair safety (no address inside the header, so the
    // partial-address walkback isn't relevant).
    return surrogateSafeSlice(header, COMPOSED_MAX);
  }
  const bodyBudget = COMPOSED_MAX - header.length;
  const body = trimShortMessageForBody(payload.shortMessage, bodyBudget);
  return header + body;
}

function buildHeader(payload: OperatorAlertPayload): string {
  const lines: string[] = [
    `Token: ${payload.tokenSymbol}`,
    `Error: ${payload.errorClass}`,
  ];
  if (payload.epochId !== undefined) {
    lines.push(`Epoch: ${payload.epochId.toString()}`);
  }
  return lines.join('\n') + '\n\n';
}

/**
 * Trim `body` to `budget` chars with surrogate-pair + partial-address
 * safety. Same guards as `capShortMessage` in the sanitiser, but
 * measured against the per-call header-aware budget. Walks back ONLY
 * within the body so Epoch: digits in the header are never affected.
 */
function trimShortMessageForBody(body: string, budget: number): string {
  if (body.length <= budget) return body;
  let trimmed = body.slice(0, budget);
  const lastCode = trimmed.charCodeAt(trimmed.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    trimmed = trimmed.slice(0, trimmed.length - 1);
  }
  const partial = trimmed.match(/0x[a-fA-F0-9]{1,39}$/);
  if (partial) {
    trimmed = trimmed.slice(0, trimmed.length - partial[0].length);
  }
  return trimmed;
}

function surrogateSafeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const lastCode = out.charCodeAt(out.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}
