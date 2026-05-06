import { z } from 'zod';
import { getLogger } from '../../../../core/logger.js';

// Lazy logger getter — keeps module-load free of `getEnv()` so test
// imports of this file don't trigger schema validation (existing
// services that do top-level `getLogger(...)` are intentionally not
// in the agent-tool unit-test transitive import set).
function lg() {
  return getLogger('publish-issuer-channel-event');
}

/**
 * Wave 4 P7 — issuer-side Telegram channel broadcast hook.
 *
 * Backend emits a sanitised aggregate event after a successful
 * `DistributionFunded` SDK callback (or any other issuer-narrative event
 * the agent surface produces). The Telegram bot worker (P4) is the
 * consumer — it receives the payload via webhook and posts to the
 * pre-configured issuer channel.
 *
 * Privacy posture: aggregate stats only — total escrow count,
 * distribution id, token symbol. NEVER per-investor data; NEVER
 * encrypted-handle ctHashes (would tempt a downstream consumer to
 * attempt decryption with the wrong permit, leaking a privacy boundary
 * P8 already audited).
 *
 * Operator setup is deferred to the grant-submission window
 * (PROGRESS.md §"P4 operator tasks"). Until the BotFather + tunnel +
 * channel-id provisioning lands, the hook is wired but inert — it
 * logs the payload and exits cleanly.
 *
 * Wave 5 swap: when the indexer subscribes to YieldDistributor's
 * `DistributionFunded` event, that subscriber calls
 * `PublishIssuerChannelEventUseCase.execute(...)` directly. Today
 * callers from the agent surface dispatch on commit-side audit; full
 * indexer wiring lands when the operator setup completes.
 */

export const IssuerChannelEventSchema = z
  .object({
    /** Logical event family — keeps the bot worker's switch simple. */
    eventType: z.enum(['distribution_funded', 'kyc_added', 'kyc_removed', 'token_unpaused']),
    /** Token the event is scoped to. */
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    tokenSymbol: z.string().min(1).max(32),
    /** Distribution-id when applicable; otherwise null. */
    distributionId: z.union([z.number().int().nonnegative(), z.null()]),
    /** Total amount in PUSDC base units when applicable (cleartext-by-design). */
    totalUsd6: z.union([z.string().regex(/^\d+$/), z.null()]),
    /** Issuer label rendered to the channel ("Acme RWA" / "TBILL Issuer"). */
    issuerLabel: z.string().min(1).max(120),
    /** Optional human-readable summary line composed by the agent. */
    summary: z.string().min(1).max(280).optional(),
    /** Optional on-chain tx hash for an Arbiscan link in the message. */
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte hex tx hash')
      .nullable()
      .optional(),
  })
  .strict();

export type IssuerChannelEvent = z.infer<typeof IssuerChannelEventSchema>;

export interface IIssuerChannelTransport {
  /** Forward the event to the Telegram bot worker (or any subscriber). */
  publish(event: IssuerChannelEvent): Promise<void>;
}

/**
 * Default transport — logs the event and returns. Swap for
 * `HttpIssuerChannelTransport` when the bot-worker endpoint is online.
 */
export class LoggingIssuerChannelTransport implements IIssuerChannelTransport {
  async publish(event: IssuerChannelEvent): Promise<void> {
    lg().info({ event }, 'issuer-channel event (transport=logging)');
  }
}

/**
 * HTTP transport — posts the sanitised event to the bot worker's
 * `/issuer-channel/broadcast` endpoint. The bot worker authenticates
 * the inbound request via the shared `TELEGRAM_BOT_SERVICE_SECRET` (the
 * same secret already used by the dashboard → bot path), so the
 * outbound POST attaches it as a header.
 *
 * Failures are logged + swallowed: a Telegram outage MUST NOT block the
 * agent's commit path or revert an on-chain action. The audit log still
 * records the underlying tx — the channel post is a notification, not
 * a source-of-truth.
 */
export class HttpIssuerChannelTransport implements IIssuerChannelTransport {
  constructor(
    private readonly opts: {
      botWorkerUrl: string;
      serviceSecret: string;
      timeoutMs?: number;
    },
  ) {}

  async publish(event: IssuerChannelEvent): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
    try {
      const res = await fetch(`${this.opts.botWorkerUrl}/issuer-channel/broadcast`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-muhaven-service-secret': this.opts.serviceSecret,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) {
        lg().warn(
          { status: res.status, eventType: event.eventType },
          'issuer-channel publish failed (non-2xx)',
        );
      }
    } catch (err) {
      lg().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'issuer-channel publish threw — channel notification dropped (audit log unaffected)',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Wave 4 P7 use-case — single entry point for any agent-surface caller
 * that wants to broadcast a sanitised issuer-narrative event. Strict
 * schema-validation up-front rejects unknown event types before any
 * outbound side-effect.
 */
export class PublishIssuerChannelEventUseCase {
  constructor(private readonly transport: IIssuerChannelTransport) {}

  async execute(event: IssuerChannelEvent): Promise<void> {
    // Defensive re-parse — the caller already validated, but a
    // boundary use-case re-validates so a future caller that bypasses
    // the schema (e.g., a direct DI into the transport) still gets
    // the same contract.
    const parsed = IssuerChannelEventSchema.parse(event);
    await this.transport.publish(parsed);
  }
}
