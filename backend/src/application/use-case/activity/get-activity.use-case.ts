import type { IYieldRecordRepository } from '../../../domain/yield-history/repository/yield-record.repository.js';
import type { IEscrowRepository } from '../../../domain/escrow/repository/escrow.repository.js';

export interface ActivityItemDto {
  id: string;
  type: 'yield' | 'escrow';
  status: string;
  token_address: string | null;
  amount: string | null;
  timestamp: string;
}

export class GetActivityUseCase {
  constructor(
    private readonly yieldRepo: IYieldRecordRepository,
    private readonly escrowRepo: IEscrowRepository,
  ) {}

  async execute(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: ActivityItemDto[]; has_more: boolean }> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    // Over-fetch by 1 to detect if more items exist beyond this page
    const fetchLimit = limit + offset + 1;

    const [yields, escrows] = await Promise.all([
      this.yieldRepo.findByUserId(userId, { limit: fetchLimit, offset: 0 }),
      this.escrowRepo.findByUserId(userId, { limit: fetchLimit }),
    ]);

    const yieldItems: ActivityItemDto[] = yields.items.map((y) => ({
      id: y.id,
      type: 'yield' as const,
      status: y.status,
      token_address: y.tokenAddress,
      amount: y.amount ?? null,
      timestamp: y.createdAt.toISOString(),
    }));

    const escrowItems: ActivityItemDto[] = escrows.items.map((e) => ({
      id: e.id,
      type: 'escrow' as const,
      status: e.status,
      token_address: e.tokenAddress ?? null,
      amount: e.amount != null ? String(e.amount) : null,
      timestamp: e.createdAt.toISOString(),
    }));

    const merged = [...yieldItems, ...escrowItems].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const paged = merged.slice(offset, offset + limit);
    const hasMore = merged.length > offset + limit;

    return { items: paged, has_more: hasMore };
  }
}
