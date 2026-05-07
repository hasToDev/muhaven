/**
 * Wave 4 P9 — `GetPublicMetricsUseCase` unit coverage.
 *
 * Five scenarios per `SELF_HOSTED_METRICS_PLAN.md §2d`:
 * 1. Cache hit — second call within TTL returns same generatedAt
 * 2. Cache expiry — second call after TTL re-queries
 * 3. Empty data — well-formed response with zero counts
 * 4. Single-token sparseness — byToken has one entry, both tokens in tokens[]
 * 5. NavHistory partial coverage — token A has 90 days of data, token B has 7
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GetPublicMetricsUseCase } from '../get-public-metrics.use-case.js';
import type {
  AcquisitionsByToken,
  DailyCount,
  DispositionsByKindResult,
  ITaxEventRepository,
  TaxEventCountsByType,
} from '../../../../domain/tax-event/repository/tax-event.repository.js';
import type { TaxEventType } from '../../../../domain/tax-event/model/tax-event.js';
import type {
  FindNavHistoryOptions,
  INavHistoryRepository,
} from '../../../../domain/nav-history/repository/nav-history.repository.js';
import { NavSnapshot } from '../../../../domain/nav-history/model/nav-snapshot.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import { RwaToken, type TokenStatus } from '../../../../domain/token-registry/model/rwa-token.js';

class StubTaxEventRepo implements ITaxEventRepository {
  counts: TaxEventCountsByType = {
    Acquisition: 0,
    Disposition: 0,
    IncomeAccrual: 0,
    FeeEvent: 0,
    Wrap: 0,
    Unwrap: 0,
    Transfer: 0,
  };
  perTypeDaily: Partial<Record<TaxEventType, DailyCount[]>> = {};
  acquisitionsByTokenRows: AcquisitionsByToken[] = [];
  dispositionsByKindResult: DispositionsByKindResult = {
    totals: { instant: 0, queued: 0, escalatedToQueue: 0 },
    byDay: [],
  };
  callCounts = {
    aggregateCounts: 0,
    dailyCounts: 0,
    acquisitionsByToken: 0,
    dispositionsByKind: 0,
  };

  async saveMany() {
    return 0;
  }
  async findByHolder() {
    return [];
  }
  async aggregateCounts() {
    this.callCounts.aggregateCounts++;
    return this.counts;
  }
  async dailyCounts(eventType: TaxEventType) {
    this.callCounts.dailyCounts++;
    return this.perTypeDaily[eventType] ?? [];
  }
  async acquisitionsByToken() {
    this.callCounts.acquisitionsByToken++;
    return this.acquisitionsByTokenRows;
  }
  async dispositionsByKind() {
    this.callCounts.dispositionsByKind++;
    return this.dispositionsByKindResult;
  }
}

class StubNavHistoryRepo implements INavHistoryRepository {
  perToken = new Map<string, NavSnapshot[]>();
  callCounts = { findByToken: 0 };

  async save() {}
  async findByToken(tokenAddress: string, options?: FindNavHistoryOptions) {
    this.callCounts.findByToken++;
    const all = this.perToken.get(tokenAddress.toLowerCase()) ?? [];
    const limit = options?.limit ?? 100;
    return all.slice(0, limit);
  }
  async findLatestByToken() {
    return null;
  }
  async findLatestForAllTokens() {
    return [];
  }
}

class StubRwaTokenRepo implements IRwaTokenRepository {
  tokens: RwaToken[] = [];
  callCounts = { findAll: 0 };

  async save() {}
  async findById() {
    return null;
  }
  async findAll() {
    this.callCounts.findAll++;
    return this.tokens;
  }
  async findByAddress() {
    return null;
  }
  async findByIssuer() {
    return [];
  }
  async findByStatus() {
    return [];
  }
  async update() {}
  async updateIssuer() {}
  async updatePausedStatus() {}
}

function makeToken(overrides: Partial<{ symbol: string; address: string; status: TokenStatus }> = {}): RwaToken {
  const now = new Date('2026-05-07T00:00:00Z');
  return new RwaToken({
    id: overrides.symbol ?? 'TOK',
    address: overrides.address ?? '0xAbCDEf0000000000000000000000000000000001',
    name: overrides.symbol ?? 'Token',
    symbol: overrides.symbol ?? 'TOK',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    kycTier: 1,
    assetClass: 'treasury',
    status: overrides.status ?? 'active',
    createdAt: now,
    updatedAt: now,
  });
}

function makeNav(tokenAddress: string, fetchedAt: Date, nav = '1.0000'): NavSnapshot {
  return new NavSnapshot({
    id: `${tokenAddress}-${fetchedAt.toISOString()}`,
    tokenAddress,
    nav,
    source: 'oracle',
    sourceType: 'on_chain',
    fetchedAt,
    createdAt: fetchedAt,
  });
}

function makeClock(initial: number) {
  let now = initial;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('GetPublicMetricsUseCase', () => {
  let taxRepo: StubTaxEventRepo;
  let navRepo: StubNavHistoryRepo;
  let tokenRepo: StubRwaTokenRepo;

  beforeEach(() => {
    taxRepo = new StubTaxEventRepo();
    navRepo = new StubNavHistoryRepo();
    tokenRepo = new StubRwaTokenRepo();
  });

  it('cache hit: second call within TTL returns the same generatedAt and does not re-query', async () => {
    tokenRepo.tokens = [makeToken()];
    taxRepo.counts.Acquisition = 5;
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock, 60_000);

    const first = await uc.execute();
    const initialCalls = { ...taxRepo.callCounts };

    clock.advance(30_000);
    const second = await uc.execute();

    expect(second.generatedAt).toBe(first.generatedAt);
    expect(taxRepo.callCounts.aggregateCounts).toBe(initialCalls.aggregateCounts);
    expect(tokenRepo.callCounts.findAll).toBe(1);
  });

  it('cache expiry: second call after TTL re-queries and emits a new generatedAt', async () => {
    tokenRepo.tokens = [makeToken()];
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock, 60_000);

    const first = await uc.execute();

    clock.advance(60_001);
    const second = await uc.execute();

    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(tokenRepo.callCounts.findAll).toBe(2);
    expect(taxRepo.callCounts.aggregateCounts).toBe(2);
  });

  it('empty data: returns a well-formed response with zero counts and empty arrays', async () => {
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock);

    const out = await uc.execute();

    expect(out.tokens).toEqual([]);
    expect(out.purchases).toEqual({ total: 0, byDay: [], byToken: [] });
    expect(out.yieldDistributions).toEqual({ total: 0, byDay: [] });
    expect(out.wrapUnwrap).toEqual({ wrapTotal: 0, unwrapTotal: 0, byDay: [] });
    expect(out.redemptions).toEqual({
      total: 0,
      instant: 0,
      queued: 0,
      escalatedToQueue: 0,
      byDay: [],
    });
    expect(out.navHistory).toEqual([]);
    expect(typeof out.generatedAt).toBe('string');
  });

  it('single-token sparseness: only one of two tokens has activity; both render in tokens[]', async () => {
    const tbillAddr = '0xAbCDEf0000000000000000000000000000000001';
    const goldAddr = '0xAbCDEf0000000000000000000000000000000002';
    tokenRepo.tokens = [
      makeToken({ symbol: 'TBILL1', address: tbillAddr }),
      makeToken({ symbol: 'GOLD1', address: goldAddr }),
    ];
    taxRepo.counts.Acquisition = 4;
    taxRepo.acquisitionsByTokenRows = [{ tokenAddress: tbillAddr.toLowerCase(), count: 4 }];
    taxRepo.perTypeDaily.Acquisition = [{ day: '2026-05-01', count: 4 }];
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock);

    const out = await uc.execute();

    expect(out.tokens.map((t) => t.symbol).sort()).toEqual(['GOLD1', 'TBILL1']);
    expect(out.purchases.byToken).toEqual([
      { tokenAddress: tbillAddr.toLowerCase(), symbol: 'TBILL1', count: 4 },
    ]);
    expect(out.purchases.total).toBe(4);
    expect(out.purchases.byDay).toEqual([{ day: '2026-05-01', count: 4 }]);
    // Lower-cased addresses everywhere — never checksum case.
    expect(out.tokens.every((t) => t.address === t.address.toLowerCase())).toBe(true);
  });

  it('navHistory partial coverage: token A has 90 days of NAV, token B has 7; both render with correct counts', async () => {
    const aAddr = '0xAaaa000000000000000000000000000000000001';
    const bAddr = '0xBbbb000000000000000000000000000000000002';
    tokenRepo.tokens = [
      makeToken({ symbol: 'A', address: aAddr }),
      makeToken({ symbol: 'B', address: bAddr }),
    ];
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    // Repo returns desc (newest-first) by contract; stub mirrors that.
    const aSeries: NavSnapshot[] = [];
    for (let i = 0; i < 90; i++) {
      aSeries.push(makeNav(aAddr, new Date(now - i * day), `1.${i.toString().padStart(4, '0')}`));
    }
    const bSeries: NavSnapshot[] = [];
    for (let i = 0; i < 7; i++) {
      bSeries.push(makeNav(bAddr, new Date(now - i * day)));
    }
    navRepo.perToken.set(aAddr.toLowerCase(), aSeries);
    navRepo.perToken.set(bAddr.toLowerCase(), bSeries);
    const clock = makeClock(now);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock);

    const out = await uc.execute();

    expect(out.navHistory).toHaveLength(2);
    const a = out.navHistory.find((s) => s.symbol === 'A')!;
    const b = out.navHistory.find((s) => s.symbol === 'B')!;
    expect(a.points).toHaveLength(90);
    expect(b.points).toHaveLength(7);
    // Ascending order — first point is the OLDEST.
    expect(new Date(a.points[0].timestamp).getTime()).toBeLessThan(
      new Date(a.points[a.points.length - 1].timestamp).getTime(),
    );
    // Lower-cased addresses in the output regardless of input case.
    expect(a.tokenAddress).toBe(aAddr.toLowerCase());
  });

  it('disposition kinds and wrap/unwrap merge into per-day buckets correctly', async () => {
    tokenRepo.tokens = [makeToken()];
    taxRepo.counts.Wrap = 3;
    taxRepo.counts.Unwrap = 2;
    taxRepo.counts.Disposition = 5;
    taxRepo.perTypeDaily.Wrap = [
      { day: '2026-05-01', count: 2 },
      { day: '2026-05-02', count: 1 },
    ];
    taxRepo.perTypeDaily.Unwrap = [{ day: '2026-05-02', count: 2 }];
    taxRepo.dispositionsByKindResult = {
      totals: { instant: 3, queued: 1, escalatedToQueue: 1 },
      byDay: [
        { day: '2026-05-01', instant: 2, queued: 0, escalatedToQueue: 0 },
        { day: '2026-05-02', instant: 1, queued: 1, escalatedToQueue: 1 },
      ],
    };
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock);

    const out = await uc.execute();

    expect(out.wrapUnwrap.wrapTotal).toBe(3);
    expect(out.wrapUnwrap.unwrapTotal).toBe(2);
    expect(out.wrapUnwrap.byDay).toEqual([
      { day: '2026-05-01', wrap: 2, unwrap: 0 },
      { day: '2026-05-02', wrap: 1, unwrap: 2 },
    ]);
    expect(out.redemptions.total).toBe(5);
    expect(out.redemptions.byDay).toEqual([
      { day: '2026-05-01', instant: 2, queued: 0, escalated: 0 },
      { day: '2026-05-02', instant: 1, queued: 1, escalated: 1 },
    ]);
  });

  it('clearCache flushes — explicit cache invalidation', async () => {
    tokenRepo.tokens = [makeToken()];
    const clock = makeClock(1_700_000_000_000);
    const uc = new GetPublicMetricsUseCase(taxRepo, navRepo, tokenRepo, clock);

    await uc.execute();
    uc.clearCache();
    await uc.execute();

    expect(tokenRepo.callCounts.findAll).toBe(2);
  });
});
