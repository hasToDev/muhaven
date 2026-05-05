import type { WebhookDelivery } from '../model/webhook-delivery.js';

export interface IssueWebhookDeliveryInput {
  delivery: WebhookDelivery;
}

export interface CompleteWebhookDeliveryInput {
  deliveryId: string;
  status: 'delivered' | 'failed';
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  errorMessage: string | null;
  completedAt: Date;
}

export interface IWebhookDeliveryRepository {
  issue(input: IssueWebhookDeliveryInput): Promise<void>;
  /** Mark a previously-issued (pending) delivery as delivered or failed. */
  complete(input: CompleteWebhookDeliveryInput): Promise<WebhookDelivery | null>;
  findById(deliveryId: string): Promise<WebhookDelivery | null>;
  findByEndpointId(
    endpointId: string,
    opts?: { limit?: number },
  ): Promise<WebhookDelivery[]>;
  findBySessionId(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<WebhookDelivery[]>;
}
