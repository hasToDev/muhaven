import type { YieldRecord, YieldStatus } from '../model/yield-record.js';

export interface FindYieldRecordsOptions {
  limit?: number;
  offset?: number;
  status?: YieldStatus;
}

export interface PaginatedYieldRecords {
  items: YieldRecord[];
  total: number;
}

export interface IYieldRecordRepository {
  save(record: YieldRecord): Promise<void>;
  findByUserId(userId: string, options?: FindYieldRecordsOptions): Promise<PaginatedYieldRecords>;
  findById(id: string): Promise<YieldRecord | null>;
  findByDistributionId(distributionId: number): Promise<YieldRecord[]>;
  findByEscrowId(escrowId: string): Promise<YieldRecord | null>;
  updateStatus(id: string, status: YieldStatus, claimedAt?: Date): Promise<void>;
}
