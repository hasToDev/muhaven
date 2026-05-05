import { and, desc, eq, lt } from 'drizzle-orm';
import {
  CheckoutSession,
  type CheckoutSessionMetadata,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type {
  ICheckoutSessionRepository,
  IssueCheckoutSessionInput,
  TransitionCheckoutSessionInput,
} from '../../../domain/checkout/repository/checkout-session.repository.js';
import { checkoutSessions } from './schema.js';
import type { Db } from './db.js';

export class PgCheckoutSessionRepository implements ICheckoutSessionRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueCheckoutSessionInput): Promise<void> {
    await this.db.insert(checkoutSessions).values({
      sessionId: input.session.sessionId,
      issuerUserId: input.session.issuerUserId,
      status: input.session.status,
      metadata: input.session.metadata,
      buyerAddress: input.session.buyerAddress,
      encPayload: input.session.encPayload,
      purchaseTxHash: input.session.purchaseTxHash,
      expiresAt: input.session.expiresAt,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
    });
  }

  async findById(sessionId: string): Promise<CheckoutSession | null> {
    const row = await this.db.query.checkoutSessions.findFirst({
      where: eq(checkoutSessions.sessionId, sessionId),
    });
    return row ? this.toDomain(row) : null;
  }

  async transition(
    input: TransitionCheckoutSessionInput,
  ): Promise<CheckoutSession | null> {
    const set: Record<string, unknown> = {
      status: input.newStatus,
      updatedAt: input.now,
    };
    if (input.purchaseTxHash) set.purchaseTxHash = input.purchaseTxHash;
    if (input.buyerAddress) set.buyerAddress = input.buyerAddress;

    const updated = await this.db
      .update(checkoutSessions)
      .set(set)
      .where(
        and(
          eq(checkoutSessions.sessionId, input.sessionId),
          eq(checkoutSessions.status, input.expectedStatus),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async sweepExpired(now: Date): Promise<number> {
    const updated = await this.db
      .update(checkoutSessions)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(checkoutSessions.status, 'pending'),
          lt(checkoutSessions.expiresAt, now),
        ),
      )
      .returning({ id: checkoutSessions.sessionId });
    return updated.length;
  }

  async findByIssuerUserId(
    issuerUserId: string,
    opts: { status?: CheckoutSessionStatus; limit?: number } = {},
  ): Promise<CheckoutSession[]> {
    const limit = opts.limit ?? 50;
    const where = opts.status
      ? and(
          eq(checkoutSessions.issuerUserId, issuerUserId),
          eq(checkoutSessions.status, opts.status),
        )
      : eq(checkoutSessions.issuerUserId, issuerUserId);
    const rows = await this.db.query.checkoutSessions.findMany({
      where,
      orderBy: desc(checkoutSessions.createdAt),
      limit,
    });
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof checkoutSessions.$inferSelect): CheckoutSession {
    return new CheckoutSession({
      sessionId: row.sessionId,
      issuerUserId: row.issuerUserId,
      status: row.status as CheckoutSessionStatus,
      metadata: row.metadata as CheckoutSessionMetadata,
      buyerAddress: (row.buyerAddress as `0x${string}` | null) ?? null,
      encPayload: row.encPayload,
      purchaseTxHash: row.purchaseTxHash,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
