import type {
  ConfirmOpenClawIntentInput,
  ConsumeOpenClawIntentInput,
  DenyOpenClawIntentInput,
  IOpenClawIntentRepository,
  IssueOpenClawIntentInput,
} from '../../../domain/agent/repository/openclaw-intent.repository.js';
import {
  OpenClawIntent,
  OpenClawIntentStatus,
  OpenClawIntentTier,
} from '../../../domain/agent/model/openclaw-intent.js';

export class MemoryOpenClawIntentRepository implements IOpenClawIntentRepository {
  private readonly store = new Map<string, OpenClawIntent>();

  async issue(input: IssueOpenClawIntentInput): Promise<void> {
    if (this.store.has(input.intent.intentId)) {
      throw new Error(`intent already exists: ${input.intent.intentId}`);
    }
    this.store.set(input.intent.intentId, input.intent);
  }

  async findById(intentId: string): Promise<OpenClawIntent | null> {
    return this.store.get(intentId) ?? null;
  }

  async confirm(input: ConfirmOpenClawIntentInput): Promise<OpenClawIntent | null> {
    const existing = this.store.get(input.intentId);
    if (!existing) return null;
    if (existing.userId !== input.userId) return null;
    if (existing.status !== OpenClawIntentStatus.Pending) return null;
    if (existing.isExpired(input.now)) return null;
    if (existing.tier === OpenClawIntentTier.MiniAppOtp) {
      if (!existing.otp) return null;
      if (input.otp == null || input.otp !== existing.otp) return null;
    }
    const next = new OpenClawIntent({
      ...existing,
      status: OpenClawIntentStatus.Confirmed,
      confirmedAt: input.now,
      updatedAt: input.now,
    });
    this.store.set(input.intentId, next);
    return next;
  }

  async consume(input: ConsumeOpenClawIntentInput): Promise<OpenClawIntent | null> {
    const existing = this.store.get(input.intentId);
    if (!existing) return null;
    if (existing.userId !== input.userId) return null;
    if (existing.status !== OpenClawIntentStatus.Confirmed) return null;
    const next = new OpenClawIntent({
      ...existing,
      status: OpenClawIntentStatus.Consumed,
      consumedAt: input.now,
      updatedAt: input.now,
    });
    this.store.set(input.intentId, next);
    return next;
  }

  async deny(input: DenyOpenClawIntentInput): Promise<OpenClawIntent | null> {
    const existing = this.store.get(input.intentId);
    if (!existing) return null;
    if (existing.userId !== input.userId) return null;
    if (existing.status !== OpenClawIntentStatus.Pending) return null;
    const next = new OpenClawIntent({
      ...existing,
      status: OpenClawIntentStatus.Denied,
      deniedAt: input.now,
      denyReason: input.reason ?? null,
      updatedAt: input.now,
    });
    this.store.set(input.intentId, next);
    return next;
  }

  async sweepExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [id, intent] of this.store) {
      if (intent.status === OpenClawIntentStatus.Pending && intent.isExpired(now)) {
        this.store.set(
          id,
          new OpenClawIntent({
            ...intent,
            status: OpenClawIntentStatus.Expired,
            updatedAt: now,
          }),
        );
        n++;
      }
    }
    return n;
  }

  async findByUserId(
    userId: string,
    opts: { status?: OpenClawIntentStatus; limit?: number } = {},
  ): Promise<OpenClawIntent[]> {
    const limit = opts.limit ?? 50;
    const all = Array.from(this.store.values())
      .filter((i) => i.userId === userId)
      .filter((i) => (opts.status ? i.status === opts.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all.slice(0, limit);
  }
}
