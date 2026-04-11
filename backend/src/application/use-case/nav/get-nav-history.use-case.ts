import type { INavHistoryRepository } from '../../../domain/nav-history/repository/nav-history.repository.js';
import type { NavSnapshot } from '../../../domain/nav-history/model/nav-snapshot.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export interface NavSnapshotDto {
  nav: string;
  apy: string | null;
  total_aum: string | null;
  yield_rate: string | null;
  source: string;
  source_type: string;
  source_timestamp: string | null;
  fetched_at: string;
}

function toDto(snapshot: NavSnapshot): NavSnapshotDto {
  return {
    nav: snapshot.nav,
    apy: snapshot.apy ?? null,
    total_aum: snapshot.totalAum ?? null,
    yield_rate: snapshot.yieldRate ?? null,
    source: snapshot.source,
    source_type: snapshot.sourceType,
    source_timestamp: snapshot.sourceTimestamp?.toISOString() ?? null,
    fetched_at: snapshot.fetchedAt.toISOString(),
  };
}

const RANGE_MAP: Record<string, number> = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365,
};

export class GetNavHistoryUseCase {
  constructor(private readonly navRepo: INavHistoryRepository) {}

  async execute(
    tokenAddress: string,
    range?: string,
  ): Promise<{ snapshots: NavSnapshotDto[] }> {
    const days = RANGE_MAP[range ?? '6m'] ?? 180;
    const from = new Date();
    from.setDate(from.getDate() - days);

    const snapshots = await this.navRepo.findByToken(tokenAddress, { from });
    return { snapshots: snapshots.map(toDto) };
  }
}

export class GetLatestNavUseCase {
  constructor(private readonly navRepo: INavHistoryRepository) {}

  async execute(tokenAddress: string): Promise<NavSnapshotDto> {
    const snapshot = await this.navRepo.findLatestByToken(tokenAddress);
    if (!snapshot) {
      throw ApplicationHttpError.notFound(`No NAV data for token ${tokenAddress}`);
    }
    return toDto(snapshot);
  }
}
