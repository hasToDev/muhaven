import { WebhookDelivery } from '../../../domain/checkout/model/webhook-delivery.js';
import type {
  CompleteWebhookDeliveryInput,
  IWebhookDeliveryRepository,
  IssueWebhookDeliveryInput,
} from '../../../domain/checkout/repository/webhook-delivery.repository.js';

export class MemoryWebhookDeliveryRepository implements IWebhookDeliveryRepository {
  private readonly store = new Map<string, WebhookDelivery>();

  async issue(input: IssueWebhookDeliveryInput): Promise<void> {
    if (this.store.has(input.delivery.deliveryId)) {
      throw new Error(`delivery already exists: ${input.delivery.deliveryId}`);
    }
    this.store.set(input.delivery.deliveryId, input.delivery);
  }

  async complete(
    input: CompleteWebhookDeliveryInput,
  ): Promise<WebhookDelivery | null> {
    const existing = this.store.get(input.deliveryId);
    if (!existing) return null;
    const next = new WebhookDelivery({
      ...existing,
      status: input.status,
      responseStatus: input.responseStatus,
      responseBodyExcerpt: input.responseBodyExcerpt,
      errorMessage: input.errorMessage,
      completedAt: input.completedAt,
    });
    this.store.set(input.deliveryId, next);
    return next;
  }

  async findById(deliveryId: string): Promise<WebhookDelivery | null> {
    return this.store.get(deliveryId) ?? null;
  }

  async findByEndpointId(
    endpointId: string,
    opts: { limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    const limit = opts.limit ?? 50;
    return Array.from(this.store.values())
      .filter((d) => d.endpointId === endpointId)
      .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime())
      .slice(0, limit);
  }

  async findBySessionId(
    sessionId: string,
    opts: { limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    const limit = opts.limit ?? 50;
    return Array.from(this.store.values())
      .filter((d) => d.sessionId === sessionId)
      .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime())
      .slice(0, limit);
  }
}
