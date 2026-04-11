import { and, eq, count, desc } from 'drizzle-orm';
import type {
  IYieldRecordRepository,
  FindYieldRecordsOptions,
  PaginatedYieldRecords,
} from '../../../domain/yield-history/repository/yield-record.repository.js';
import { YieldRecord } from '../../../domain/yield-history/model/yield-record.js';
import type { YieldStatus } from '../../../domain/yield-history/model/yield-record.js';
import { yieldRecords } from './schema.js';
import type { Db } from './db.js';

export class PgYieldRecordRepository implements IYieldRecordRepository {
  constructor(private readonly db: Db) {}

  async save(record: YieldRecord): Promise<void> {
    await this.db.insert(yieldRecords).values({
      id: record.id,
      userId: record.userId,
      distributionId: record.distributionId,
      escrowId: record.escrowId,
      tokenAddress: record.tokenAddress,
      amount: record.amount,
      status: record.status,
      claimedAt: record.claimedAt,
      createdAt: record.createdAt,
    });
  }

  async findByUserId(userId: string, options?: FindYieldRecordsOptions): Promise<PaginatedYieldRecords> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const conditions = [eq(yieldRecords.userId, userId)];

    if (options?.status) {
      conditions.push(eq(yieldRecords.status, options.status));
    }

    const [rows, totalResult] = await Promise.all([
      this.db.query.yieldRecords.findMany({
        where: and(...conditions),
        orderBy: [desc(yieldRecords.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ count: count() })
        .from(yieldRecords)
        .where(and(...conditions)),
    ]);

    return {
      items: rows.map((r) => this.toDomain(r)),
      total: Number(totalResult[0]?.count ?? 0),
    };
  }

  async findById(id: string): Promise<YieldRecord | null> {
    const row = await this.db.query.yieldRecords.findFirst({
      where: eq(yieldRecords.id, id),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByDistributionId(distributionId: number): Promise<YieldRecord[]> {
    const rows = await this.db.query.yieldRecords.findMany({
      where: eq(yieldRecords.distributionId, distributionId),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async updateStatus(id: string, status: YieldStatus, claimedAt?: Date): Promise<void> {
    await this.db
      .update(yieldRecords)
      .set({ status, claimedAt })
      .where(eq(yieldRecords.id, id));
  }

  private toDomain(row: typeof yieldRecords.$inferSelect): YieldRecord {
    return new YieldRecord({
      id: row.id,
      userId: row.userId,
      distributionId: row.distributionId,
      escrowId: row.escrowId ?? undefined,
      tokenAddress: row.tokenAddress,
      amount: row.amount ?? undefined,
      status: row.status as YieldStatus,
      claimedAt: row.claimedAt ?? undefined,
      createdAt: row.createdAt,
    });
  }
}
