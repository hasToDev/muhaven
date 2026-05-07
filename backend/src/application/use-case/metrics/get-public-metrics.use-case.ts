/**
 * Wave 4 P9 · Public metrics aggregator.
 *
 * Returns aggregate-only counts for the unauthenticated `/metrics` page.
 * No per-investor data, no decryption, no per-purchase USDC volume —
 * the indexer never captured cleartext amounts; the privacy story IS
 * the metric.
 *
 * Caching: 60s in-process per-pod cache. `generatedAt` is the cache
 * fill time (clients see slightly stale values for up to 60s — fine
 * for an aggregate dashboard). Multi-replica deploys see slight cache
 * drift across pods; flagged for Wave 5 redis uplift in
 * `SELF_HOSTED_METRICS_PLAN.md §6`.
 */

import type {
  ITaxEventRepository,
  TaxEventCountsByType,
} from '../../../domain/tax-event/repository/tax-event.repository.js';
import type { INavHistoryRepository } from '../../../domain/nav-history/repository/nav-history.repository.js';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';

export interface PublicMetricsTokenDto {
  address: string;
  symbol: string;
  status: string;
}

export interface PublicMetricsDailyCount {
  day: string;
  count: number;
}

export interface PublicMetricsTokenCount {
  tokenAddress: string;
  symbol: string;
  count: number;
}

export interface PublicMetricsWrapUnwrapByDay {
  day: string;
  wrap: number;
  unwrap: number;
}

export interface PublicMetricsRedemptionByDay {
  day: string;
  instant: number;
  queued: number;
  escalated: number;
}

export interface PublicMetricsNavPoint {
  timestamp: string;
  nav: string;
}

export interface PublicMetricsNavSeries {
  tokenAddress: string;
  symbol: string;
  points: PublicMetricsNavPoint[];
}

export interface PublicMetricsDto {
  generatedAt: string;
  tokens: PublicMetricsTokenDto[];
  purchases: {
    total: number;
    byDay: PublicMetricsDailyCount[];
    byToken: PublicMetricsTokenCount[];
  };
  yieldDistributions: {
    total: number;
    byDay: PublicMetricsDailyCount[];
  };
  wrapUnwrap: {
    wrapTotal: number;
    unwrapTotal: number;
    byDay: PublicMetricsWrapUnwrapByDay[];
  };
  redemptions: {
    total: number;
    instant: number;
    queued: number;
    escalatedToQueue: number;
    byDay: PublicMetricsRedemptionByDay[];
  };
  navHistory: PublicMetricsNavSeries[];
}

export const PUBLIC_METRICS_CACHE_TTL_MS = 60_000;
export const PUBLIC_METRICS_NAV_WINDOW_DAYS = 90;

interface CacheEntry {
  value: PublicMetricsDto;
  expiresAt: number;
}

interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

function mergeDailySeries(
  a: PublicMetricsDailyCount[],
  b: PublicMetricsDailyCount[],
): PublicMetricsWrapUnwrapByDay[] {
  const days = new Map<string, { wrap: number; unwrap: number }>();
  for (const row of a) {
    const slot = days.get(row.day) ?? { wrap: 0, unwrap: 0 };
    slot.wrap += row.count;
    days.set(row.day, slot);
  }
  for (const row of b) {
    const slot = days.get(row.day) ?? { wrap: 0, unwrap: 0 };
    slot.unwrap += row.count;
    days.set(row.day, slot);
  }
  return Array.from(days.entries())
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([day, kinds]) => ({ day, ...kinds }));
}

export class GetPublicMetricsUseCase {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly taxEventRepo: ITaxEventRepository,
    private readonly navHistoryRepo: INavHistoryRepository,
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly cacheTtlMs: number = PUBLIC_METRICS_CACHE_TTL_MS,
  ) {}

  async execute(): Promise<PublicMetricsDto> {
    const now = this.clock.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const value = await this.compute(now);
    this.cache = { value, expiresAt: now + this.cacheTtlMs };
    return value;
  }

  /** Test-only escape hatch — clears the in-process cache. */
  clearCache(): void {
    this.cache = null;
  }

  private async compute(now: number): Promise<PublicMetricsDto> {
    // Pull token list first so we can resolve symbols + address case for
    // every per-token query downstream. Lower-case at this layer so the
    // entire DTO is internally consistent (the SQL boundary already
    // emits lowercase via `lower(token_address)` projections in the repo).
    const tokens = await this.rwaTokenRepo.findAll();
    const tokenByAddressLower = new Map(
      tokens.map((t) => [t.address.toLowerCase(), t] as const),
    );

    // Run aggregate-count queries in parallel — they're independent.
    const [counts, acquisitionsByToken, dispositions, acquisitionByDay, incomeByDay, wrapByDay, unwrapByDay] = await Promise.all([
      this.taxEventRepo.aggregateCounts(),
      this.taxEventRepo.acquisitionsByToken(),
      this.taxEventRepo.dispositionsByKind(),
      this.taxEventRepo.dailyCounts('Acquisition'),
      this.taxEventRepo.dailyCounts('IncomeAccrual'),
      this.taxEventRepo.dailyCounts('Wrap'),
      this.taxEventRepo.dailyCounts('Unwrap'),
    ]);

    // NAV history per token (last 90 days). Run in parallel; each
    // call hits its own primary-key range so contention is bounded.
    const navWindow = new Date(now - PUBLIC_METRICS_NAV_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const navSeriesEntries = await Promise.all(
      tokens.map(async (t) => {
        const snapshots = await this.navHistoryRepo.findByToken(t.address, {
          from: navWindow,
          // Cap at one point per ~6h over 90 days = 360 — round up to 500
          // so a slightly denser series isn't truncated. The default
          // limit (100) would silently drop most of a 90-day window.
          limit: 500,
        });
        const points: PublicMetricsNavPoint[] = snapshots
          // Repo returns desc (newest-first); page expects ascending.
          .slice()
          .reverse()
          .map((s) => ({
            timestamp: s.fetchedAt.toISOString(),
            nav: s.nav,
          }));
        return {
          tokenAddress: t.address.toLowerCase(),
          symbol: t.symbol,
          points,
        } satisfies PublicMetricsNavSeries;
      }),
    );

    return {
      generatedAt: new Date(now).toISOString(),
      tokens: tokens.map((t) => ({
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        status: t.status,
      })),
      purchases: {
        total: this.safeCount(counts, 'Acquisition'),
        byDay: acquisitionByDay,
        byToken: acquisitionsByToken
          .map((row) => {
            const token = tokenByAddressLower.get(row.tokenAddress);
            return {
              tokenAddress: row.tokenAddress,
              // Unknown tokens (e.g. a contract address that shipped
              // events but was never registered in `rwa_tokens`) fall
              // back to a truncated address as the symbol so the row
              // is still inspectable on the page.
              symbol: token?.symbol ?? `${row.tokenAddress.slice(0, 6)}…${row.tokenAddress.slice(-4)}`,
              count: row.count,
            };
          })
          .sort((a, b) => b.count - a.count),
      },
      yieldDistributions: {
        total: this.safeCount(counts, 'IncomeAccrual'),
        byDay: incomeByDay,
      },
      wrapUnwrap: {
        wrapTotal: this.safeCount(counts, 'Wrap'),
        unwrapTotal: this.safeCount(counts, 'Unwrap'),
        byDay: mergeDailySeries(wrapByDay, unwrapByDay),
      },
      redemptions: {
        total: this.safeCount(counts, 'Disposition'),
        instant: dispositions.totals.instant,
        queued: dispositions.totals.queued,
        escalatedToQueue: dispositions.totals.escalatedToQueue,
        byDay: dispositions.byDay.map((row) => ({
          day: row.day,
          instant: row.instant,
          queued: row.queued,
          escalated: row.escalatedToQueue,
        })),
      },
      navHistory: navSeriesEntries,
    };
  }

  private safeCount(counts: TaxEventCountsByType, key: keyof TaxEventCountsByType): number {
    return counts[key] ?? 0;
  }
}
