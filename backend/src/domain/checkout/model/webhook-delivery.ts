import type { WebhookEventType } from './webhook-endpoint.js';

/**
 * Single attempt at delivering a webhook event to an issuer endpoint.
 *
 * Recorded BEFORE the HTTP request so a crashed worker / network
 * partition leaves an auditable "in-flight" trail. Status flips on
 * completion: `delivered` (2xx) / `failed` (4xx, 5xx, network error,
 * timeout). Retry policy lives in the dispatcher; the row only records
 * what actually happened.
 *
 * Wave 4 ships single-attempt delivery (no retry budget). Wave 5 adds
 * exponential backoff + dead-letter queue.
 */

export const WebhookDeliveryStatus = {
  Pending: 'pending',
  Delivered: 'delivered',
  Failed: 'failed',
} as const;

export type WebhookDeliveryStatus =
  (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export interface WebhookDeliveryProps {
  deliveryId: string;
  endpointId: string;
  sessionId: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  /** HTTP status returned by the issuer; null if the request never completed. */
  responseStatus: number | null;
  /**
   * Truncated response body (≤4KB). Useful for debugging issuer-side
   * failures from the dashboard. NEVER stores the request body — that's
   * recoverable from `(sessionId, eventType, attemptedAt)`.
   */
  responseBodyExcerpt: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
  completedAt: Date | null;
}

export class WebhookDelivery implements WebhookDeliveryProps {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly sessionId: string;
  readonly eventType: WebhookEventType;
  readonly status: WebhookDeliveryStatus;
  readonly responseStatus: number | null;
  readonly responseBodyExcerpt: string | null;
  readonly errorMessage: string | null;
  readonly attemptedAt: Date;
  readonly completedAt: Date | null;

  constructor(props: WebhookDeliveryProps) {
    this.deliveryId = props.deliveryId;
    this.endpointId = props.endpointId;
    this.sessionId = props.sessionId;
    this.eventType = props.eventType;
    this.status = props.status;
    this.responseStatus = props.responseStatus;
    this.responseBodyExcerpt = props.responseBodyExcerpt;
    this.errorMessage = props.errorMessage;
    this.attemptedAt = props.attemptedAt;
    this.completedAt = props.completedAt;
  }
}

export const WEBHOOK_DELIVERY_ID_PREFIX = 'whd_';
