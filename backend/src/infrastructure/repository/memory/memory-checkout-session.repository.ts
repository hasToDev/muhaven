import {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import type {
  ICheckoutSessionRepository,
  IssueCheckoutSessionInput,
  TransitionCheckoutSessionInput,
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
    opts: { status?: CheckoutSessionStatus; limit?: number } = {},
  ): Promise<CheckoutSession[]> {
    const limit = opts.limit ?? 50;
    return Array.from(this.store.values())
      .filter((s) => s.issuerUserId === issuerUserId)
      .filter((s) => (opts.status ? s.status === opts.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
