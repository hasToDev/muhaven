import { randomBytes } from 'node:crypto';
import { getLogger } from '../../core/logger.js';
import {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WEBHOOK_DELIVERY_ID_PREFIX,
} from '../../domain/checkout/model/webhook-delivery.js';
import {
  WebhookEndpoint,
  type WebhookEventType,
} from '../../domain/checkout/model/webhook-endpoint.js';
import type { IWebhookDeliveryRepository } from '../../domain/checkout/repository/webhook-delivery.repository.js';
import type { IWebhookEndpointRepository } from '../../domain/checkout/repository/webhook-endpoint.repository.js';
import { WebhookSigner } from './webhook-signer.js';

/**
 * Dispatch a single webhook event to every active endpoint registered
 * by the issuer. Wave 4 ships fire-once-per-attempt — no retry budget,
 * no dead-letter queue. Failed deliveries are recorded for issuer-side
 * dashboard visibility (Wave 5 dashboard) and can be re-driven manually.
 *
 * NOTE: Wave 4 dispatcher fires inline with the transition write. Wave
 * 5 should move dispatch to a queue to keep the API response latency
 * bounded by the local DB write — a slow issuer endpoint shouldn't
 * stretch the dashboard's transition request.
 */

/** ~4KB cap on persisted response body excerpts. */
const MAX_BODY_EXCERPT = 4 * 1024;

/** ~30s timeout per webhook delivery — long-tail endpoints get cut. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface WebhookDispatchInput {
  eventType: WebhookEventType;
  sessionId: string;
  issuerUserId: string;
  /** Cleartext metadata payload — NEVER includes the encrypted blob. */
  payload: Record<string, unknown>;
  now?: Date;
}

export class WebhookDispatcher {
  private readonly signer = new WebhookSigner();
  private readonly logger = getLogger('WebhookDispatcher');

  constructor(
    private readonly endpointRepo: IWebhookEndpointRepository,
    private readonly deliveryRepo: IWebhookDeliveryRepository,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async dispatch(input: WebhookDispatchInput): Promise<WebhookDelivery[]> {
    const now = input.now ?? new Date();
    const endpoints = await this.endpointRepo.findActiveByIssuerUserId(
      input.issuerUserId,
    );
    const matching = endpoints.filter((e) => e.matches(input.eventType));
    if (matching.length === 0) return [];

    const deliveries: WebhookDelivery[] = [];
    for (const endpoint of matching) {
      const delivery = await this.deliverOne(endpoint, input, now);
      deliveries.push(delivery);
    }
    return deliveries;
  }

  private async deliverOne(
    endpoint: WebhookEndpoint,
    input: WebhookDispatchInput,
    now: Date,
  ): Promise<WebhookDelivery> {
    const deliveryId = `${WEBHOOK_DELIVERY_ID_PREFIX}${randomBytes(16).toString('hex')}`;
    const body = JSON.stringify({
      id: deliveryId,
      type: input.eventType,
      created: Math.floor(now.getTime() / 1000),
      sessionId: input.sessionId,
      data: input.payload,
    });
    const bodyBytes = Buffer.from(body, 'utf-8');
    const sig = this.signer.sign(endpoint.signingSecret, bodyBytes, now);

    const pending = new WebhookDelivery({
      deliveryId,
      endpointId: endpoint.endpointId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      status: WebhookDeliveryStatus.Pending,
      responseStatus: null,
      responseBodyExcerpt: null,
      errorMessage: null,
      attemptedAt: now,
      completedAt: null,
    });
    await this.deliveryRepo.issue({ delivery: pending });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let responseStatus: number | null = null;
    let responseBodyExcerpt: string | null = null;
    let errorMessage: string | null = null;
    let status: 'delivered' | 'failed' = 'failed';

    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [sig.name]: sig.value,
        },
        body,
        signal: ac.signal,
      });
      responseStatus = response.status;
      const text = await safeReadText(response);
      responseBodyExcerpt = text === null ? null : truncate(text, MAX_BODY_EXCERPT);
      status = response.status >= 200 && response.status < 300 ? 'delivered' : 'failed';
      if (status === 'failed') {
        errorMessage = `non-2xx response: ${response.status}`;
      }
    } catch (err) {
      const e = err as Error;
      errorMessage = e.name === 'AbortError' ? 'timeout' : e.message;
      this.logger.warn(
        { endpointId: endpoint.endpointId, sessionId: input.sessionId, err: errorMessage },
        'webhook delivery failed',
      );
    } finally {
      clearTimeout(timer);
    }

    const completed = await this.deliveryRepo.complete({
      deliveryId,
      status,
      responseStatus,
      responseBodyExcerpt,
      errorMessage,
      completedAt: new Date(),
    });
    return completed ?? pending;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}
