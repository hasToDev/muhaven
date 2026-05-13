import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import {
  CheckoutSession,
  type CheckoutSessionMetadata,
  CheckoutSessionStatus,
  CHECKOUT_SESSION_STATUS_VALUES,
} from '../../../domain/checkout/model/checkout-session.js';
import type {
  ICheckoutSessionRepository,
  IssueCheckoutSessionInput,
  TransitionCheckoutSessionInput,
  FindIssuerSessionsOpts,
  FindIssuerSessionsResult,
  IssuerSessionStatsRow,
  IssuerSessionDailyBucket,
} from '../../../domain/checkout/repository/checkout-session.repository.js';
import { checkoutSessions } from './schema.js';
import type { Db } from './db.js';

/**
 * Hard cap on page size to keep memory + wire round-trip bounded; the
 * issuer-side use-case caps at 50 in addition. Tests exercise the cap
 * directly so cursor pagination stays deterministic on small pages.
 */
const MAX_PAGE_LIMIT = 200;

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

  async findByPurchaseTxHash(txHash: string): Promise<CheckoutSession | null> {
    // Wave 5 P4 — `CheckoutSettlementIndexer` calls this for every
    // `MuHavenSubscription.Purchased` event. Most events are non-
    // checkout (dashboard direct purchases also emit this event), so
    // null returns are the common case; the indexer treats null as
    // "skip, not our session." Use `lower()` on both sides per the
    // address-case repo-boundary rule even though tx hashes are
    // case-stable in practice (defensive against any future caller
    // that normalises differently).
    const normalised = txHash.toLowerCase();
    const row = await this.db.query.checkoutSessions.findFirst({
      where: sql`LOWER(${checkoutSessions.purchaseTxHash}) = ${normalised}`,
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
    opts: FindIssuerSessionsOpts = {},
  ): Promise<FindIssuerSessionsResult> {
    const requested = opts.limit ?? 20;
    const limit = Math.max(1, Math.min(requested, MAX_PAGE_LIMIT));
    // Keyset (createdAt, sessionId) tuple comparison — same shape as the
    // P1 audit-events pagination cursor fix. Drizzle has no first-class
    // tuple operator so we hand-roll the OR-form: createdAt strictly
    // older, OR same createdAt and sessionId strictly smaller.
    const conditions = [eq(checkoutSessions.issuerUserId, issuerUserId)];
    if (opts.status) {
      conditions.push(eq(checkoutSessions.status, opts.status));
    }
    if (opts.cursor) {
      const cursorDate = new Date(opts.cursor.createdAtMs);
      conditions.push(
        or(
          lt(checkoutSessions.createdAt, cursorDate),
          and(
            eq(checkoutSessions.createdAt, cursorDate),
            lt(checkoutSessions.sessionId, opts.cursor.sessionId),
          ),
        )!,
      );
    }

    const rows = await this.db.query.checkoutSessions.findMany({
      where: and(...conditions),
      orderBy: [desc(checkoutSessions.createdAt), desc(checkoutSessions.sessionId)],
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? { createdAtMs: last.createdAt.getTime(), sessionId: last.sessionId }
      : null;

    return {
      sessions: page.map((r) => this.toDomain(r)),
      nextCursor,
    };
  }

  async countByIssuerAndStatus(
    issuerUserId: string,
    opts: { since?: Date; until?: Date } = {},
  ): Promise<IssuerSessionStatsRow> {
    // Half-open `[since, until)` boundary per arch-review HIGH-2 fix.
    // Inclusive-both-ends previously double-counted sessions created at
    // exactly the boundary tick across adjacent ranges (e.g. a row
    // created at `now` shows up in both `7d` and `30d`).
    const conditions = [eq(checkoutSessions.issuerUserId, issuerUserId)];
    if (opts.since) conditions.push(gte(checkoutSessions.createdAt, opts.since));
    if (opts.until) conditions.push(lt(checkoutSessions.createdAt, opts.until));

    const rows = await this.db
      .select({
        status: checkoutSessions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(checkoutSessions)
      .where(and(...conditions))
      .groupBy(checkoutSessions.status);

    const byStatus = Object.fromEntries(
      CHECKOUT_SESSION_STATUS_VALUES.map((s) => [s, 0]),
    ) as Record<CheckoutSessionStatus, number>;
    let total = 0;
    for (const r of rows) {
      const k = r.status as CheckoutSessionStatus;
      byStatus[k] = r.count;
      total += r.count;
    }
    return { total, byStatus };
  }

  async countByIssuerAndDay(
    issuerUserId: string,
    opts: { since: Date; until: Date },
  ): Promise<IssuerSessionDailyBucket[]> {
    // UTC day bucket — `date_trunc('day', created_at AT TIME ZONE 'UTC')`
    // yields a timestamp at the day's midnight which we then convert to
    // epoch-ms for the wire shape. Postgres returns the bucket as a
    // Date, which JS coerces consistently to UTC ms via `getTime()`.
    // The `'UTC'` literal is HARDCODED inside the template — never bind
    // a runtime tz string here, that would be a SQLi vector (arch-review
    // MEDIUM-4 note).
    //
    // Half-open `[since, until)` boundary mirrors countByIssuerAndStatus.
    const rows = await this.db
      .select({
        bucket: sql<Date>`date_trunc('day', ${checkoutSessions.createdAt} AT TIME ZONE 'UTC')`,
        count: sql<number>`count(*)::int`,
      })
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.issuerUserId, issuerUserId),
          gte(checkoutSessions.createdAt, opts.since),
          lt(checkoutSessions.createdAt, opts.until),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return rows.map((r) => ({
      bucketMs: r.bucket instanceof Date ? r.bucket.getTime() : new Date(r.bucket).getTime(),
      count: r.count,
    }));
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
