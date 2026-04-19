import type {
  IYieldRecordRepository,
  FindYieldRecordsOptions,
} from '../../../domain/yield-history/repository/yield-record.repository.js';
import type { YieldRecord } from '../../../domain/yield-history/model/yield-record.js';
import type { YieldStatus } from '../../../domain/yield-history/model/yield-record.js';
import type { IEscrowRepository } from '../../../domain/escrow/repository/escrow.repository.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export interface YieldRecordDto {
  id: string;
  distribution_id: number;
  /**
   * On-chain escrow ID (numeric string, e.g. "15") — the value the frontend
   * passes to `MuHavenEscrow.redeem(uint256)`. Resolved from the linked
   * Escrow entity's `onChainEscrowId` field. Null when the underlying
   * escrow hasn't been indexed on-chain yet.
   *
   * NOT the backend Escrow entity UUID (which is what `YieldRecord.escrowId`
   * stores internally) — returning that directly would make the frontend
   * throw `cannot convert <uuid> to bigint` on claim.
   */
  escrow_id: string | null;
  token_address: string;
  amount: string | null;
  status: string;
  claimed_at: string | null;
  created_at: string;
}

function toDto(record: YieldRecord, onChainEscrowId: string | null): YieldRecordDto {
  return {
    id: record.id,
    distribution_id: record.distributionId,
    escrow_id: onChainEscrowId,
    token_address: record.tokenAddress,
    amount: record.amount ?? null,
    status: record.status,
    claimed_at: record.claimedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
  };
}

async function resolveOnChainIds(
  escrowRepo: IEscrowRepository,
  records: YieldRecord[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(records.map((r) => r.escrowId).filter((id): id is string => !!id))];
  const escrows = await Promise.all(ids.map((id) => escrowRepo.findById(id)));
  const map = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i++) {
    map.set(ids[i]!, escrows[i]?.onChainEscrowId ?? null);
  }
  return map;
}

export class GetYieldsUseCase {
  constructor(
    private readonly yieldRepo: IYieldRecordRepository,
    private readonly escrowRepo: IEscrowRepository,
  ) {}

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
    const onChainIdMap = await resolveOnChainIds(this.escrowRepo, result.items);

    return {
      items: result.items.map((r) => toDto(r, r.escrowId ? onChainIdMap.get(r.escrowId) ?? null : null)),
      total: result.total,
    };
  }
}

export class GetYieldByIdUseCase {
  constructor(
    private readonly yieldRepo: IYieldRecordRepository,
    private readonly escrowRepo: IEscrowRepository,
  ) {}

  async execute(id: string, userId: string): Promise<YieldRecordDto> {
    const record = await this.yieldRepo.findById(id);
    if (!record || record.userId !== userId) {
      throw ApplicationHttpError.notFound('Yield record not found');
    }
    const escrow = record.escrowId ? await this.escrowRepo.findById(record.escrowId) : null;
    return toDto(record, escrow?.onChainEscrowId ?? null);
  }
}
