import { z } from 'zod';
import { getLogger } from '../../../../core/logger.js';
import {
  OpenClawIntentKind,
  type OpenClawIntentPayload,
  OpenClawIntentTier,
  classifyTier,
} from '../../../../domain/agent/model/openclaw-intent.js';
import type { ITelegramLinkRepository } from '../../../../domain/agent/repository/telegram-link.repository.js';
import { CreateOpenClawIntentUseCase } from './create-intent.use-case.js';

function lg() {
  return getLogger('notify-intent-to-bot');
}

/**
 * Wave 4 P4 — backend → telegram-bot push channel.
 *
 * Symmetric counterpart to the bot worker → backend service-secret path
 * already wired by `/api/v1/agent/openclaw/intent/{confirm-inline,
 * deny-inline,confirm,deny,lookup-miniapp}`. The bot worker exposes a
 * single new endpoint, `POST /intent/notify`, that takes the freshly
 * minted intent + (optional) OTP and renders it as a Telegram message
 * with the appropriate inline keyboard. The notifier authenticates with
 * the same `TELEGRAM_BOT_SERVICE_SECRET` already shared on both sides.
 *
 * Privacy posture identical to the issuer-channel hook: failures are
 * logged + swallowed. A Telegram outage MUST NOT block a propose flow
 * (the dashboard ConfirmModal stays the canonical surface; Telegram is
 * a parallel notification channel).
 */

export const BotIntentNotificationSchema = z
  .object({
    telegramChatId: z.string().regex(/^-?\d{1,32}$/),
    intent: z
      .object({
        intentId: z.string().regex(/^oci_[A-Z0-9]{26}$/),
        kind: z.enum(['buy', 'claim']),
        tier: z.enum(['inline', 'mini_app_otp', 'passkey_deeplink']),
        amountUsd6: z.string().regex(/^\d+$/),
        intentHash: z.string().regex(/^[0-9a-f]{64}$/),
        expiresAt: z.string().min(1),
        payload: z
          .object({
            token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
            summary: z.string().min(1).max(280),
            issuerLabel: z.string().min(1).max(120).optional(),
            escrowId: z.string().min(1).max(64).optional(),
          })
          .strict(),
      })
      .strict(),
    /** OTP cleartext, present iff `intent.tier === 'mini_app_otp'`. */
    otp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();

export type BotIntentNotification = z.infer<typeof BotIntentNotificationSchema>;

export interface IBotIntentTransport {
  notify(payload: BotIntentNotification): Promise<void>;
}

/**
 * Default transport — logs the payload + drops it. Active whenever the
 * operator hasn't wired `TELEGRAM_BOT_WORKER_URL` yet, so the use-case is
 * callable from a propose flow without exploding.
 */
export class LoggingBotIntentTransport implements IBotIntentTransport {
  async notify(payload: BotIntentNotification): Promise<void> {
    lg().info(
      {
        intentId: payload.intent.intentId,
        tier: payload.intent.tier,
        kind: payload.intent.kind,
      },
      'bot intent notification (transport=logging)',
    );
  }
}

/**
 * HTTP transport — POSTs to the bot worker's `/intent/notify` endpoint
 * with the shared service secret. 5s timeout (mirrors
 * `HttpIssuerChannelTransport`).
 */
export class HttpBotIntentTransport implements IBotIntentTransport {
  constructor(
    private readonly opts: {
      botWorkerUrl: string;
      serviceSecret: string;
      timeoutMs?: number;
    },
  ) {}

  async notify(payload: BotIntentNotification): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
    try {
      const res = await fetch(`${this.opts.botWorkerUrl}/intent/notify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-muhaven-service-secret': this.opts.serviceSecret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        lg().warn(
          {
            status: res.status,
            intentId: payload.intent.intentId,
            tier: payload.intent.tier,
          },
          'bot intent notify failed (non-2xx)',
        );
      }
    } catch (err) {
      lg().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'bot intent notify threw — telegram delivery dropped (audit log unaffected)',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface MintAndDeliverInput {
  userId: string;
  kind: OpenClawIntentKind;
  amountUsd6: bigint;
  payload: Omit<OpenClawIntentPayload, 'amountUsd6'> & { amountUsd6?: never };
  now?: Date;
}

export interface MintAndDeliverResult {
  /** Whether a Telegram link was found + the bot was notified. */
  delivered: boolean;
  /** Tier the intent classified into (informative only). */
  tier?: OpenClawIntentTier;
  /** Intent id (informative only). */
  intentId?: string;
}

/**
 * Single-call helper for propose-* tools.
 *
 * Looks up the user's Telegram link; if found, mints an OpenClawIntent
 * (delegated to `CreateOpenClawIntentUseCase`) and forwards it to the
 * bot worker via the injected transport. If no link, returns
 * `{ delivered: false }` with no side-effects.
 *
 * Failure-safe: every step is wrapped so a Telegram outage / link-row
 * race never bubbles up to the propose use-case. The dashboard
 * ConfirmModal flow continues regardless.
 */
export class MintAndDeliverOpenClawIntentUseCase {
  constructor(
    private readonly createIntent: CreateOpenClawIntentUseCase,
    private readonly telegramLinkRepo: ITelegramLinkRepository,
    private readonly transport: IBotIntentTransport,
  ) {}

  async execute(input: MintAndDeliverInput): Promise<MintAndDeliverResult> {
    let links;
    try {
      links = await this.telegramLinkRepo.findByUserId(input.userId);
    } catch (err) {
      lg().warn(
        { err: err instanceof Error ? err.message : String(err), userId: input.userId },
        'telegram link lookup threw; skipping bot delivery',
      );
      return { delivered: false };
    }
    const active = links.find((l) => l.isActive());
    if (!active) {
      return { delivered: false };
    }

    let result;
    try {
      result = await this.createIntent.execute({
        userId: input.userId,
        kind: input.kind,
        amountUsd6: input.amountUsd6,
        payload: input.payload,
        telegramChatId: active.telegramChatId,
        ...(input.now ? { now: input.now } : {}),
      });
    } catch (err) {
      lg().warn(
        { err: err instanceof Error ? err.message : String(err), userId: input.userId },
        'OpenClaw intent mint threw; skipping bot delivery',
      );
      return { delivered: false };
    }

    const tier = classifyTier(input.amountUsd6);
    const notification: BotIntentNotification = {
      telegramChatId: active.telegramChatId,
      intent: {
        intentId: result.intent.intentId,
        kind: result.intent.kind,
        tier: result.intent.tier,
        amountUsd6: result.intent.amountUsd6.toString(),
        intentHash: result.intent.intentHash,
        expiresAt: result.intent.expiresAt.toISOString(),
        payload: {
          token: result.intent.payload.token,
          summary: result.intent.payload.summary,
          ...(result.intent.payload.issuerLabel
            ? { issuerLabel: result.intent.payload.issuerLabel }
            : {}),
          ...(result.intent.payload.escrowId ? { escrowId: result.intent.payload.escrowId } : {}),
        },
      },
      ...(result.otp ? { otp: result.otp } : {}),
    };
    try {
      await this.transport.notify(notification);
    } catch (err) {
      // Defensive: the transport already swallows; this catch is a
      // belt-and-braces against a future transport that throws.
      lg().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'bot intent notify rethrow swallowed',
      );
    }
    return {
      delivered: true,
      tier,
      intentId: result.intent.intentId,
    };
  }
}
