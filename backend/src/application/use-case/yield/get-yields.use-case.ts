import type {
  IYieldRecordRepository,
  FindYieldRecordsOptions,
} from '../../../domain/yield-history/repository/yield-record.repository.js';
import type { YieldRecord } from '../../../domain/yield-history/model/yield-record.js';
import type { YieldStatus } from '../../../domain/yield-history/model/yield-record.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export interface YieldRecordDto {
  id: string;
  distribution_id: number;
  escrow_id: string | null;
  token_address: string;
  amount: string | null;
  status: string;
  claimed_at: string | null;
  created_at: string;
}

function toDto(record: YieldRecord): YieldRecordDto {
  return {
    id: record.id,
    distribution_id: record.distributionId,
    escrow_id: record.escrowId ?? null,
    token_address: record.tokenAddress,
    amount: record.amount ?? null,
    status: record.status,
    claimed_at: record.claimedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
  };
}

export class GetYieldsUseCase {
  constructor(private readonly yieldRepo: IYieldRecordRepository) {}

  async execute(
    userId: string,
    options?: { limit?: number; offset?: number; status?: string },
  ): Promise<{ items: YieldRecordDto[]; total: number }> {
    const findOptions: FindYieldRecordsOptions = {
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
      status: options?.status as YieldStatus | undefined,
    };

    const result = await this.yieldRepo.findByUserId(userId, findOptions);

    return {
      items: result.items.map(toDto),
      total: result.total,
    };
  }
}

export class GetYieldByIdUseCase {
  constructor(private readonly yieldRepo: IYieldRecordRepository) {}

  async execute(id: string, userId: string): Promise<YieldRecordDto> {
    const record = await this.yieldRepo.findById(id);
    if (!record || record.userId !== userId) {
      throw ApplicationHttpError.notFound('Yield record not found');
    }
    return toDto(record);
  }
}
