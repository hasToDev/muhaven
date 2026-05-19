import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type { OracleSnapshotRead } from '../../../domain/oracle/model/oracle-payload.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export interface OracleSnapshotDto {
  ticker: string;
  snapshot_at: string;
  source: string;
  nav_dollar: string | null;
  price_dollar: string | null;
  apy_7_day: string | null;
  apy_30_day: string | null;
  daily_yield_rate: string | null;
  yield_to_maturity_percent: string | null;
  daily_yield_distributed_dollar: string | null;
  hypothetical_10k_performance: string | null;
  total_supply_token: string | null;
  total_asset_value_dollar: string | null;
  market_value_dollar: string | null;
  holding_addresses_count: number | null;
  top_5_holder_concentration: string | null;
  rwaxyz_updated_at: string | null;
}

function toDto(snap: OracleSnapshotRead): OracleSnapshotDto {
  return {
    ticker: snap.ticker,
    snapshot_at: snap.snapshotAt.toISOString(),
    source: snap.source,
    nav_dollar: snap.navDollar,
    price_dollar: snap.priceDollar,
    apy_7_day: snap.apy7Day,
    apy_30_day: snap.apy30Day,
    daily_yield_rate: snap.dailyYieldRate,
    yield_to_maturity_percent: snap.yieldToMaturityPercent,
    daily_yield_distributed_dollar: snap.dailyYieldDistributedDollar,
    hypothetical_10k_performance: snap.hypothetical10kPerformance,
    total_supply_token: snap.totalSupplyToken,
    total_asset_value_dollar: snap.totalAssetValueDollar,
    market_value_dollar: snap.marketValueDollar,
    holding_addresses_count: snap.holdingAddressesCount,
    top_5_holder_concentration: snap.top5HolderConcentration,
    rwaxyz_updated_at: snap.rwaxyzUpdatedAt?.toISOString() ?? null,
  };
}

export class GetLatestSnapshotUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(ticker: string): Promise<OracleSnapshotDto> {
    const snap = await this.oracleRepo.findLatestSnapshot(ticker);
    if (!snap) {
      throw ApplicationHttpError.notFound(
        `No oracle snapshot for ticker ${ticker}`,
      );
    }
    return toDto(snap);
  }
}
