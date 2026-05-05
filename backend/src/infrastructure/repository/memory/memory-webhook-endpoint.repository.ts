import { WebhookEndpoint } from '../../../domain/checkout/model/webhook-endpoint.js';
import type {
  DisableWebhookEndpointInput,
  IWebhookEndpointRepository,
  IssueWebhookEndpointInput,
} from '../../../domain/checkout/repository/webhook-endpoint.repository.js';

export class MemoryWebhookEndpointRepository implements IWebhookEndpointRepository {
  private readonly store = new Map<string, WebhookEndpoint>();

  async issue(input: IssueWebhookEndpointInput): Promise<void> {
    if (this.store.has(input.endpoint.endpointId)) {
      throw new Error(`endpoint already exists: ${input.endpoint.endpointId}`);
    }
    this.store.set(input.endpoint.endpointId, input.endpoint);
  }

  async findById(endpointId: string): Promise<WebhookEndpoint | null> {
    return this.store.get(endpointId) ?? null;
  }

  async findActiveByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]> {
    const now = new Date();
    return Array.from(this.store.values())
      .filter((e) => e.issuerUserId === issuerUserId)
      .filter((e) => e.isActive(now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async disable(input: DisableWebhookEndpointInput): Promise<WebhookEndpoint | null> {
    const existing = this.store.get(input.endpointId);
    if (!existing) return null;
    if (existing.issuerUserId !== input.issuerUserId) return null;
    if (existing.disabledAt !== null) return null;
    const next = new WebhookEndpoint({
      ...existing,
      disabledAt: input.now,
      updatedAt: input.now,
    });
    this.store.set(input.endpointId, next);
    return next;
  }
}
