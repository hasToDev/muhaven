import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type {
  ConfirmOpenClawIntentInput,
  ConsumeOpenClawIntentInput,
  DenyOpenClawIntentInput,
  IOpenClawIntentRepository,
  IssueOpenClawIntentInput,
} from '../../../domain/agent/repository/openclaw-intent.repository.js';
import {
  OpenClawIntent,
  type OpenClawIntentKind,
  type OpenClawIntentPayload,
  type OpenClawIntentStatus,
  type OpenClawIntentTier,
} from '../../../domain/agent/model/openclaw-intent.js';
import { openclawIntents } from './schema.js';
import type { Db } from './db.js';

export class PgOpenClawIntentRepository implements IOpenClawIntentRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueOpenClawIntentInput): Promise<void> {
    await this.db.insert(openclawIntents).values({
      intentId: input.intent.intentId,
      userId: input.intent.userId,
      kind: input.intent.kind,
      tier: input.intent.tier,
      status: input.intent.status,
      amountUsd6: input.intent.amountUsd6.toString(),
      payload: input.intent.payload,
      intentHash: input.intent.intentHash,
      otp: input.intent.otp,
      telegramChatId: input.intent.telegramChatId,
      confirmedAt: input.intent.confirmedAt,
      consumedAt: input.intent.consumedAt,
      deniedAt: input.intent.deniedAt,
      denyReason: input.intent.denyReason,
      expiresAt: input.intent.expiresAt,
      createdAt: input.intent.createdAt,
      updatedAt: input.intent.updatedAt,
    });
  }

  async findById(intentId: string): Promise<OpenClawIntent | null> {
    const row = await this.db.query.openclawIntents.findFirst({
      where: eq(openclawIntents.intentId, intentId),
    });
    return row ? this.toDomain(row) : null;
  }

  async confirm(input: ConfirmOpenClawIntentInput): Promise<OpenClawIntent | null> {
    // Read once to know the tier — cheap because it's a PK lookup. The
    // tier dictates whether OTP equality belongs in the WHERE clause.
    const existing = await this.findById(input.intentId);
    if (!existing) return null;

    // All other invariants are pushed into the conditional UPDATE so the
    // SQL is the single source of truth: status pending + not yet
    // expired + (when tier=mini_app_otp) cleartext OTP matches under SQL
    // equality. The OTP cannot mutate post-issue (no UPDATE path writes
    // it), so the read-then-update window is structurally race-free —
    // the SQL-side check is the comment-truth contract, not a latent
    // race fix.
    const conditions = [
      eq(openclawIntents.intentId, input.intentId),
      eq(openclawIntents.userId, input.userId),
      eq(openclawIntents.status, 'pending'),
      gt(openclawIntents.expiresAt, input.now),
    ];
    if (existing.tier === 'mini_app_otp') {
      if (!input.otp) return null;
      conditions.push(eq(openclawIntents.otp, input.otp));
    }

    const updated = await this.db
      .update(openclawIntents)
      .set({
        status: 'confirmed',
        confirmedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(...conditions))
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async consume(input: ConsumeOpenClawIntentInput): Promise<OpenClawIntent | null> {
    const updated = await this.db
      .update(openclawIntents)
      .set({
        status: 'consumed',
        consumedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(openclawIntents.intentId, input.intentId),
          eq(openclawIntents.userId, input.userId),
          eq(openclawIntents.status, 'confirmed'),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async deny(input: DenyOpenClawIntentInput): Promise<OpenClawIntent | null> {
    const updated = await this.db
      .update(openclawIntents)
      .set({
        status: 'denied',
        deniedAt: input.now,
        denyReason: input.reason ?? null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(openclawIntents.intentId, input.intentId),
          eq(openclawIntents.userId, input.userId),
          eq(openclawIntents.status, 'pending'),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async sweepExpired(now: Date): Promise<number> {
    const updated = await this.db
      .update(openclawIntents)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(eq(openclawIntents.status, 'pending'), lt(openclawIntents.expiresAt, now)),
      )
      .returning({ id: openclawIntents.intentId });
    return updated.length;
  }

  async findByUserId(
    userId: string,
    opts: { status?: OpenClawIntentStatus; limit?: number } = {},
  ): Promise<OpenClawIntent[]> {
    const limit = opts.limit ?? 50;
    const where = opts.status
      ? and(eq(openclawIntents.userId, userId), eq(openclawIntents.status, opts.status))
      : eq(openclawIntents.userId, userId);
    const rows = await this.db.query.openclawIntents.findMany({
      where,
      orderBy: desc(openclawIntents.createdAt),
      limit,
    });
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof openclawIntents.$inferSelect): OpenClawIntent {
    return new OpenClawIntent({
      intentId: row.intentId,
      userId: row.userId,
      kind: row.kind as OpenClawIntentKind,
      tier: row.tier as OpenClawIntentTier,
      status: row.status as OpenClawIntentStatus,
      amountUsd6: BigInt(row.amountUsd6),
      payload: row.payload as OpenClawIntentPayload,
      intentHash: row.intentHash,
      otp: row.otp,
      telegramChatId: row.telegramChatId,
      confirmedAt: row.confirmedAt,
      consumedAt: row.consumedAt,
      deniedAt: row.deniedAt,
      denyReason: row.denyReason,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
