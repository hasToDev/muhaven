import { desc, eq } from 'drizzle-orm';
import {
  WebhookDelivery,
  type WebhookDeliveryStatus,
} from '../../../domain/checkout/model/webhook-delivery.js';
import type {
  CompleteWebhookDeliveryInput,
  IWebhookDeliveryRepository,
  IssueWebhookDeliveryInput,
} from '../../../domain/checkout/repository/webhook-delivery.repository.js';
import type { WebhookEventType } from '../../../domain/checkout/model/webhook-endpoint.js';
import { checkoutWebhookDeliveries } from './schema.js';
import type { Db } from './db.js';

export class PgWebhookDeliveryRepository implements IWebhookDeliveryRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueWebhookDeliveryInput): Promise<void> {
    await this.db.insert(checkoutWebhookDeliveries).values({
      deliveryId: input.delivery.deliveryId,
      endpointId: input.delivery.endpointId,
      sessionId: input.delivery.sessionId,
      eventType: input.delivery.eventType,
      status: input.delivery.status,
      responseStatus: input.delivery.responseStatus,
      responseBodyExcerpt: input.delivery.responseBodyExcerpt,
      errorMessage: input.delivery.errorMessage,
      attemptedAt: input.delivery.attemptedAt,
      completedAt: input.delivery.completedAt,
    });
  }

  async complete(
    input: CompleteWebhookDeliveryInput,
  ): Promise<WebhookDelivery | null> {
    const updated = await this.db
      .update(checkoutWebhookDeliveries)
      .set({
        status: input.status,
        responseStatus: input.responseStatus,
        responseBodyExcerpt: input.responseBodyExcerpt,
        errorMessage: input.errorMessage,
        completedAt: input.completedAt,
      })
      .where(eq(checkoutWebhookDeliveries.deliveryId, input.deliveryId))
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async findById(deliveryId: string): Promise<WebhookDelivery | null> {
    const row = await this.db.query.checkoutWebhookDeliveries.findFirst({
      where: eq(checkoutWebhookDeliveries.deliveryId, deliveryId),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByEndpointId(
    endpointId: string,
    opts: { limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    const rows = await this.db.query.checkoutWebhookDeliveries.findMany({
      where: eq(checkoutWebhookDeliveries.endpointId, endpointId),
      orderBy: desc(checkoutWebhookDeliveries.attemptedAt),
      limit: opts.limit ?? 50,
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findBySessionId(
    sessionId: string,
    opts: { limit?: number } = {},
  ): Promise<WebhookDelivery[]> {
    const rows = await this.db.query.checkoutWebhookDeliveries.findMany({
      where: eq(checkoutWebhookDeliveries.sessionId, sessionId),
      orderBy: desc(checkoutWebhookDeliveries.attemptedAt),
      limit: opts.limit ?? 50,
    });
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(
    row: typeof checkoutWebhookDeliveries.$inferSelect,
  ): WebhookDelivery {
    return new WebhookDelivery({
      deliveryId: row.deliveryId,
      endpointId: row.endpointId,
      sessionId: row.sessionId,
      eventType: row.eventType as WebhookEventType,
      status: row.status as WebhookDeliveryStatus,
      responseStatus: row.responseStatus,
      responseBodyExcerpt: row.responseBodyExcerpt,
      errorMessage: row.errorMessage,
      attemptedAt: row.attemptedAt,
      completedAt: row.completedAt,
    });
  }
}
