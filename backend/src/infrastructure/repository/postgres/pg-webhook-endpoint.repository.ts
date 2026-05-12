import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  WebhookEndpoint,
  type WebhookEventType,
} from '../../../domain/checkout/model/webhook-endpoint.js';
import type {
  DisableWebhookEndpointInput,
  IWebhookEndpointRepository,
  IssueWebhookEndpointInput,
} from '../../../domain/checkout/repository/webhook-endpoint.repository.js';
import { checkoutWebhookEndpoints } from './schema.js';
import type { Db } from './db.js';

export class PgWebhookEndpointRepository implements IWebhookEndpointRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueWebhookEndpointInput): Promise<void> {
    await this.db.insert(checkoutWebhookEndpoints).values({
      endpointId: input.endpoint.endpointId,
      issuerUserId: input.endpoint.issuerUserId,
      url: input.endpoint.url,
      signingSecret: input.endpoint.signingSecret,
      enabledEvents: [...input.endpoint.enabledEvents],
      disabledAt: input.endpoint.disabledAt,
      createdAt: input.endpoint.createdAt,
      updatedAt: input.endpoint.updatedAt,
    });
  }

  async findById(endpointId: string): Promise<WebhookEndpoint | null> {
    const row = await this.db.query.checkoutWebhookEndpoints.findFirst({
      where: eq(checkoutWebhookEndpoints.endpointId, endpointId),
    });
    return row ? this.toDomain(row) : null;
  }

  async findActiveByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]> {
    const rows = await this.db.query.checkoutWebhookEndpoints.findMany({
      where: and(
        eq(checkoutWebhookEndpoints.issuerUserId, issuerUserId),
        isNull(checkoutWebhookEndpoints.disabledAt),
      ),
      orderBy: desc(checkoutWebhookEndpoints.createdAt),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findAllByIssuerUserId(issuerUserId: string): Promise<WebhookEndpoint[]> {
    const rows = await this.db.query.checkoutWebhookEndpoints.findMany({
      where: eq(checkoutWebhookEndpoints.issuerUserId, issuerUserId),
      orderBy: desc(checkoutWebhookEndpoints.createdAt),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async disable(
    input: DisableWebhookEndpointInput,
  ): Promise<WebhookEndpoint | null> {
    const updated = await this.db
      .update(checkoutWebhookEndpoints)
      .set({ disabledAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(checkoutWebhookEndpoints.endpointId, input.endpointId),
          eq(checkoutWebhookEndpoints.issuerUserId, input.issuerUserId),
          isNull(checkoutWebhookEndpoints.disabledAt),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  private toDomain(
    row: typeof checkoutWebhookEndpoints.$inferSelect,
  ): WebhookEndpoint {
    return new WebhookEndpoint({
      endpointId: row.endpointId,
      issuerUserId: row.issuerUserId,
      url: row.url,
      signingSecret: row.signingSecret,
      enabledEvents: (row.enabledEvents ?? []) as WebhookEventType[],
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
