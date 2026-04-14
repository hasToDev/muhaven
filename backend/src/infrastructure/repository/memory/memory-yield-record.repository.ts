import type {
  IYieldRecordRepository,
  FindYieldRecordsOptions,
  PaginatedYieldRecords,
} from '../../../domain/yield-history/repository/yield-record.repository.js';
import type { YieldRecord, YieldStatus } from '../../../domain/yield-history/model/yield-record.js';

export class MemoryYieldRecordRepository implements IYieldRecordRepository {
  private readonly store = new Map<string, YieldRecord>();

  async save(record: YieldRecord): Promise<void> {
    this.store.set(record.id, record);
  }

  async findByUserId(userId: string, options?: FindYieldRecordsOptions): Promise<PaginatedYieldRecords> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    let items = [...this.store.values()]
      .filter((r) => r.userId === userId)
      .filter((r) => (options?.status ? r.status === options.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = items.length;
    items = items.slice(offset, offset + limit);

    return { items, total };
  }

  async findById(id: string): Promise<YieldRecord | null> {
    return this.store.get(id) ?? null;
  }

  async findByDistributionId(distributionId: number): Promise<YieldRecord[]> {
    return [...this.store.values()].filter((r) => r.distributionId === distributionId);
  }

  async findByEscrowId(escrowId: string): Promise<YieldRecord | null> {
    for (const record of this.store.values()) {
      if (record.escrowId === escrowId) return record;
    }
    return null;
  }

  async updateStatus(id: string, status: YieldStatus, claimedAt?: Date): Promise<void> {
    const record = this.store.get(id);
    if (record) {
      record.status = status;
      if (claimedAt) {
        record.claimedAt = claimedAt;
      }
    }
  }
}
