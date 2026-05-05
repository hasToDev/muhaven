/**
 * Issuer-registered webhook endpoint (Wave 4 P5).
 *
 * Stripe-style event delivery: when a checkout session transitions, the
 * backend POSTs a signed JSON envelope to every active endpoint the
 * issuer has registered. Signing is HMAC-SHA256 over the timestamped
 * canonical payload (see WebhookSigner).
 *
 * Endpoints are scoped to a single issuer userId. Admin endpoints (Wave
 * 5 dashboard) live above this primitive.
 */

export const WebhookEventType = {
  SessionCreated: 'checkout.session.created',
  SessionFunded: 'checkout.session.funded',
  SessionWrapped: 'checkout.session.wrapped',
  SessionPurchased: 'checkout.session.purchased',
  SessionSettled: 'checkout.session.settled',
  SessionExpired: 'checkout.session.expired',
  SessionFailed: 'checkout.session.failed',
} as const;

export type WebhookEventType =
  (typeof WebhookEventType)[keyof typeof WebhookEventType];

export const WEBHOOK_EVENT_TYPE_VALUES: readonly WebhookEventType[] = [
  WebhookEventType.SessionCreated,
  WebhookEventType.SessionFunded,
  WebhookEventType.SessionWrapped,
  WebhookEventType.SessionPurchased,
  WebhookEventType.SessionSettled,
  WebhookEventType.SessionExpired,
  WebhookEventType.SessionFailed,
] as const;

export interface WebhookEndpointProps {
  endpointId: string;
  issuerUserId: string;
  /** Target URL the backend POSTs to. Must be HTTPS in production. */
  url: string;
  /**
   * Per-endpoint signing secret — generated at create time and shown to
   * the issuer ONCE in the create response. Stored as raw bytes (base64
   * encoded in JSON). Receiver libraries verify HMAC-SHA256 against this
   * secret + the canonical payload (Stripe-style `v1=…` scheme).
   */
  signingSecret: string;
  /** Subset of event types the issuer wants to receive; empty = all. */
  enabledEvents: readonly WebhookEventType[];
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class WebhookEndpoint implements WebhookEndpointProps {
  readonly endpointId: string;
  readonly issuerUserId: string;
  readonly url: string;
  readonly signingSecret: string;
  readonly enabledEvents: readonly WebhookEventType[];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: WebhookEndpointProps) {
    this.endpointId = props.endpointId;
    this.issuerUserId = props.issuerUserId;
    this.url = props.url;
    this.signingSecret = props.signingSecret;
    this.enabledEvents = props.enabledEvents;
    this.disabledAt = props.disabledAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  isActive(now: Date = new Date()): boolean {
    return this.disabledAt === null || this.disabledAt.getTime() > now.getTime();
  }

  /** True if this endpoint should receive `eventType`. */
  matches(eventType: WebhookEventType): boolean {
    if (this.enabledEvents.length === 0) return true;
    return this.enabledEvents.includes(eventType);
  }
}

/**
 * Endpoint id format: `whe_<26-char alphabet>`. Same shape as session id
 * for audit-log uniformity.
 */
export const WEBHOOK_ENDPOINT_ID_PREFIX = 'whe_';
export const WEBHOOK_ENDPOINT_ID_RE = /^whe_[A-Z0-9]{26}$/;
