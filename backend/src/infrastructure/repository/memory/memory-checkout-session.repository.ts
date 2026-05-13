import {
  CheckoutSession,
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

export class MemoryCheckoutSessionRepository implements ICheckoutSessionRepository {
  private readonly store = new Map<string, CheckoutSession>();

  async issue(input: IssueCheckoutSessionInput): Promise<void> {
    if (this.store.has(input.session.sessionId)) {
      throw new Error(`session already exists: ${input.session.sessionId}`);
    }
    this.store.set(input.session.sessionId, input.session);
  }

  async findById(sessionId: string): Promise<CheckoutSession | null> {
    return this.store.get(sessionId) ?? null;
  }

  async findByPurchaseTxHash(txHash: string): Promise<CheckoutSession | null> {
    const normalised = txHash.toLowerCase();
    for (const session of this.store.values()) {
      if (
        session.purchaseTxHash &&
        session.purchaseTxHash.toLowerCase() === normalised
      ) {
        return session;
      }
    }
    return null;
  }

  async transition(
    input: TransitionCheckoutSessionInput,
  ): Promise<CheckoutSession | null> {
    const existing = this.store.get(input.sessionId);
    if (!existing) return null;
    if (existing.status !== input.expectedStatus) return null;
    const next = new CheckoutSession({
      ...existing,
      status: input.newStatus,
      ...(input.purchaseTxHash ? { purchaseTxHash: input.purchaseTxHash } : {}),
      ...(input.buyerAddress ? { buyerAddress: input.buyerAddress } : {}),
      updatedAt: input.now,
    });
    this.store.set(input.sessionId, next);
    return next;
  }

  async sweepExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [id, session] of this.store) {
      if (
        session.status === CheckoutSessionStatus.Pending &&
        session.isExpired(now)
      ) {
        this.store.set(
          id,
          new CheckoutSession({
            ...session,
            status: CheckoutSessionStatus.Expired,
            updatedAt: now,
          }),
        );
        n++;
      }
    }
    return n;
  }

  async findByIssuerUserId(
    issuerUserId: string,
    opts: FindIssuerSessionsOpts = {},
  ): Promise<FindIssuerSessionsResult> {
    const requested = opts.limit ?? 20;
    const limit = Math.max(1, Math.min(requested, 200));

    const all = Array.from(this.store.values())
      .filter((s) => s.issuerUserId === issuerUserId)
      .filter((s) => (opts.status ? s.status === opts.status : true))
      .sort((a, b) => {
        // createdAt DESC, sessionId DESC — keyset-stable ordering.
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
      });

    const filtered = opts.cursor
      ? all.filter((s) => {
          const cMs = opts.cursor!.createdAtMs;
          const sMs = s.createdAt.getTime();
          if (sMs < cMs) return true;
          if (sMs === cMs && s.sessionId < opts.cursor!.sessionId) return true;
          return false;
        })
      : all;

    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? { createdAtMs: last.createdAt.getTime(), sessionId: last.sessionId }
      : null;

    return { sessions: page, nextCursor };
  }

  async countByIssuerAndStatus(
    issuerUserId: string,
    opts: { since?: Date; until?: Date } = {},
  ): Promise<IssuerSessionStatsRow> {
    const byStatus = Object.fromEntries(
      CHECKOUT_SESSION_STATUS_VALUES.map((s) => [s, 0]),
    ) as Record<CheckoutSessionStatus, number>;
    let total = 0;
    // Half-open `[since, until)` boundary — matches PG repo.
    for (const s of this.store.values()) {
      if (s.issuerUserId !== issuerUserId) continue;
      if (opts.since && s.createdAt < opts.since) continue;
      if (opts.until && s.createdAt >= opts.until) continue;
      byStatus[s.status] += 1;
      total += 1;
    }
    return { total, byStatus };
  }

  async countByIssuerAndDay(
    issuerUserId: string,
    opts: { since: Date; until: Date },
  ): Promise<IssuerSessionDailyBucket[]> {
    const buckets = new Map<number, number>();
    // Half-open `[since, until)` boundary — matches PG repo.
    for (const s of this.store.values()) {
      if (s.issuerUserId !== issuerUserId) continue;
      if (s.createdAt < opts.since || s.createdAt >= opts.until) continue;
      const d = s.createdAt;
      const bucketMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      buckets.set(bucketMs, (buckets.get(bucketMs) ?? 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketMs, count]) => ({ bucketMs, count }));
  }
}
