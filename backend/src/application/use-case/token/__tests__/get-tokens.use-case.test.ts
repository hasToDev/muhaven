/**
 * Wave 5 — `GetTokensUseCase` + `GetTokenByAddressUseCase` unit
 * coverage for the NAV-source split fallback (bug #7,
 * `development/DEV_WAVE_5/NAV_SOURCE_SPLIT.md`, 2026-05-23).
 *
 * Scenarios:
 *   1. nav-history hit  → no oracle fallback fired, NAV from history
 *   2. nav-history miss + oracle hit → synthesized NAV from oracle row
 *   3. nav-history miss + oracle miss → null latest_nav
 *   4. nav-history miss + oracle hit but `navDollar` null → null latest_nav
 *   5. mixed cohort (one history, one oracle, one missing) → correct per-token
 *   6. constructed without an `oracleRepo` arg → no fallback, no throw
 *
 * The `GetTokenByAddressUseCase` mirror has the same three core paths.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GetTokensUseCase, GetTokenByAddressUseCase } from '../get-tokens.use-case.js';
import { RwaToken } from '../../../../domain/token-registry/model/rwa-token.js';
import { NavSnapshot } from '../../../../domain/nav-history/model/nav-snapshot.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../domain/nav-history/repository/nav-history.repository.js';
import type { IUserRepository } from '../../../../domain/auth/repository/user.repository.js';
import type { IOracleRepository } from '../../../../domain/oracle/repository/oracle.repository.js';
import type { OracleSnapshotRead } from '../../../../domain/oracle/model/oracle-payload.js';

const NOW = new Date('2026-05-23T02:00:00Z');

function token(symbol: string, address: string): RwaToken {
  return new RwaToken({
    id: randomUUID(),
    address,
    name: `${symbol} mock`,
    symbol,
    issuerAddress: '0x' + 'a'.repeat(40),
    apy: '5.0',
    kycTier: 1,
    assetClass: 'treasury',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function navHistorySnapshot(addr: string, nav: string): NavSnapshot {
  return new NavSnapshot({
    id: randomUUID(),
    tokenAddress: addr,
    nav,
    apy: '5.0',
    source: 'fred:DGS3MO',
    sourceType: 'api',
    fetchedAt: NOW,
    createdAt: NOW,
  });
}

function oracleSnapshot(
  ticker: string,
  navDollar: string | null,
  overrides: Partial<OracleSnapshotRead> = {},
): OracleSnapshotRead {
  return {
    ticker,
    snapshotAt: NOW,
    source: 'rwaxyz_scrape',
    navDollar,
    priceDollar: null,
    apy7Day: '4.95',
    apy30Day: '4.80',
    dailyYieldRate: '0.0136',
    yieldToMaturityPercent: null,
    dailyYieldDistributedDollar: null,
    hypothetical10kPerformance: null,
    totalSupplyToken: null,
    totalAssetValueDollar: '7500000.00',
    marketValueDollar: '7600000.00',
    holdingAddressesCount: 42,
    top5HolderConcentration: null,
    rwaxyzUpdatedAt: new Date('2026-05-22T23:00:00Z'),
    ...overrides,
  };
}

function makeTokenRepo(tokens: RwaToken[]): IRwaTokenRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn().mockResolvedValue(tokens),
    findByAddress: vi.fn((addr: string) =>
      Promise.resolve(tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase()) ?? null),
    ),
    findByIssuer: vi.fn(),
    findByStatus: vi.fn(),
    update: vi.fn(),
    updateIssuer: vi.fn(),
    updatePausedStatus: vi.fn(),
  } as unknown as IRwaTokenRepository;
}

function makeNavRepo(rows: NavSnapshot[]): INavHistoryRepository {
  return {
    save: vi.fn(),
    findByToken: vi.fn().mockResolvedValue([]),
    findLatestByToken: vi.fn((addr: string) =>
      Promise.resolve(
        rows.find((r) => r.tokenAddress.toLowerCase() === addr.toLowerCase()) ?? null,
      ),
    ),
    findLatestForAllTokens: vi.fn().mockResolvedValue(rows),
  };
}

function makeOracleRepo(rows: Map<string, OracleSnapshotRead | null>): {
  repo: IOracleRepository;
  findLatestSnapshot: ReturnType<typeof vi.fn>;
  findLatestSnapshotsByTickers: ReturnType<typeof vi.fn>;
} {
  // Singular form — used by `GetTokenByAddressUseCase` only. Matches
  // the contract of the Pg impl (case-insensitive lookup).
  const findLatestSnapshot = vi.fn(async (ticker: string) =>
    rows.get(ticker.toLowerCase()) ?? null,
  );
  // Bulk form — used by `GetTokensUseCase` to collapse fanout to one
  // round-trip. Returns lowercase-keyed map; tickers with no snapshot
  // are absent (NOT `null`-valued) per the interface contract.
  const findLatestSnapshotsByTickers = vi.fn(async (tickers: readonly string[]) => {
    const out = new Map<string, OracleSnapshotRead>();
    for (const t of tickers) {
      const found = rows.get(t.toLowerCase());
      if (found) out.set(t.toLowerCase(), found);
    }
    return out;
  });
  const repo = {
    ingestAsset: vi.fn(),
    findMetadata: vi.fn(),
    findMetadataList: vi.fn(),
    findLatestSnapshot,
    findLatestSnapshotsByTickers,
    findTimeseries: vi.fn(),
  } as unknown as IOracleRepository;
  return { repo, findLatestSnapshot, findLatestSnapshotsByTickers };
}

function makeUserRepo(): IUserRepository {
  return {
    findById: vi.fn(),
    findByWalletAddress: vi.fn().mockResolvedValue(null),
    findByWalletAddresses: vi.fn().mockResolvedValue([]),
    save: vi.fn(),
  };
}

const TBILL_ADDR = '0xe80a64c13759e9b823265e2691c7c481eaaaf6e2';
const CETES_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const BUIDL_ADDR = '0xabcdef1234567890abcdef1234567890abcdef12';

describe('GetTokensUseCase · NAV-source split fallback', () => {
  it('uses nav-history when present and skips the oracle bulk call entirely', async () => {
    const tbill = token('TBILL1', TBILL_ADDR);
    const tokenRepo = makeTokenRepo([tbill]);
    const navRepo = makeNavRepo([navHistorySnapshot(TBILL_ADDR, '1.0123')]);
    const { repo: oracleRepo, findLatestSnapshotsByTickers } = makeOracleRepo(new Map());

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, makeUserRepo(), oracleRepo);
    const { tokens } = await useCase.execute();

    expect(tokens).toHaveLength(1);
    expect(tokens[0].latest_nav?.nav).toBe('1.0123');
    expect(tokens[0].latest_nav?.source).toBe('fred:DGS3MO');
    // Bulk call MUST be skipped when no tokens are missing — saves the
    // round-trip + the empty-array param-type quirk in pg drivers.
    expect(findLatestSnapshotsByTickers).not.toHaveBeenCalled();
  });

  it('falls back to oracle_snapshots when nav-history is empty (single bulk call)', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const tokenRepo = makeTokenRepo([cetes]);
    const navRepo = makeNavRepo([]);
    const oracleRows = new Map<string, OracleSnapshotRead>([
      ['cetes', oracleSnapshot('CETES', '1.0498')],
    ]);
    const { repo: oracleRepo, findLatestSnapshotsByTickers } = makeOracleRepo(oracleRows);

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, makeUserRepo(), oracleRepo);
    const { tokens } = await useCase.execute();

    expect(findLatestSnapshotsByTickers).toHaveBeenCalledTimes(1);
    expect(findLatestSnapshotsByTickers).toHaveBeenCalledWith(['CETES']);
    expect(tokens[0].latest_nav).not.toBeNull();
    expect(tokens[0].latest_nav?.nav).toBe('1.0498');
    expect(tokens[0].latest_nav?.apy).toBe('4.95');
    expect(tokens[0].latest_nav?.total_aum).toBe('7500000.00');
    expect(tokens[0].latest_nav?.source).toBe('rwaxyz_scrape');
    expect(tokens[0].latest_nav?.source_type).toBe('api');
  });

  it('returns null latest_nav when neither nav-history nor oracle has a row', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const useCase = new GetTokensUseCase(
      makeTokenRepo([cetes]),
      makeNavRepo([]),
      makeUserRepo(),
      makeOracleRepo(new Map()).repo,
    );
    const { tokens } = await useCase.execute();
    expect(tokens[0].latest_nav).toBeNull();
  });

  it('returns null latest_nav when oracle row has navDollar = null', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const oracleRows = new Map<string, OracleSnapshotRead>([
      ['cetes', oracleSnapshot('CETES', null)],
    ]);
    const useCase = new GetTokensUseCase(
      makeTokenRepo([cetes]),
      makeNavRepo([]),
      makeUserRepo(),
      makeOracleRepo(oracleRows).repo,
    );
    const { tokens } = await useCase.execute();
    expect(tokens[0].latest_nav).toBeNull();
  });

  it('resolves a mixed cohort (history-hit, oracle-fallback, both-miss) per token', async () => {
    const tbill = token('TBILL1', TBILL_ADDR);
    const cetes = token('CETES', CETES_ADDR);
    const buidl = token('BUIDL', BUIDL_ADDR);
    const tokenRepo = makeTokenRepo([tbill, cetes, buidl]);
    const navRepo = makeNavRepo([navHistorySnapshot(TBILL_ADDR, '0.99')]);
    const oracleRows = new Map<string, OracleSnapshotRead>([
      ['cetes', oracleSnapshot('CETES', '1.04')],
      // BUIDL intentionally absent — exercises both-miss
    ]);
    const { repo: oracleRepo, findLatestSnapshotsByTickers } = makeOracleRepo(oracleRows);

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, makeUserRepo(), oracleRepo);
    const { tokens } = await useCase.execute();

    const byAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
    expect(byAddr.get(TBILL_ADDR)?.latest_nav?.nav).toBe('0.99');
    expect(byAddr.get(CETES_ADDR)?.latest_nav?.nav).toBe('1.04');
    expect(byAddr.get(BUIDL_ADDR)?.latest_nav).toBeNull();
    // Bulk call invoked ONCE with only the two tokens missing from
    // nav-history; TBILL1 never queried against oracle.
    expect(findLatestSnapshotsByTickers).toHaveBeenCalledTimes(1);
    const argTickers = findLatestSnapshotsByTickers.mock.calls[0][0] as string[];
    expect(argTickers).toEqual(['CETES', 'BUIDL']);
    expect(argTickers).not.toContain('TBILL1');
  });

  it('preserves exact-case symbol when calling oracleRepo (drift guard)', async () => {
    // Wave 5 1A catalogue has mixed-case symbols (`syrupUSDC`, `ONyc`,
    // `NVDAon`, `MUon`). The repo's case-insensitive predicate is the
    // load-bearing safety net, but we still want to detect any
    // future code path that pre-lowercases the symbol before handing
    // it to the repo — that would mask a `lower(ticker)` index miss.
    const syrup = token('syrupUSDC', '0x' + 'd'.repeat(40));
    const { repo: oracleRepo, findLatestSnapshotsByTickers } = makeOracleRepo(new Map());
    const useCase = new GetTokensUseCase(
      makeTokenRepo([syrup]),
      makeNavRepo([]),
      makeUserRepo(),
      oracleRepo,
    );
    await useCase.execute();
    expect(findLatestSnapshotsByTickers).toHaveBeenCalledWith(['syrupUSDC']);
  });

  it('omits the fallback path when constructed without an oracleRepo', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const useCase = new GetTokensUseCase(makeTokenRepo([cetes]), makeNavRepo([]), makeUserRepo());
    const { tokens } = await useCase.execute();
    expect(tokens[0].latest_nav).toBeNull();
  });

  it('synthesizes apy from apy30Day when apy7Day is null', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const oracleRows = new Map<string, OracleSnapshotRead>([
      ['cetes', oracleSnapshot('CETES', '1.04', { apy7Day: null, apy30Day: '4.80' })],
    ]);
    const useCase = new GetTokensUseCase(
      makeTokenRepo([cetes]),
      makeNavRepo([]),
      makeUserRepo(),
      makeOracleRepo(oracleRows).repo,
    );
    const { tokens } = await useCase.execute();
    expect(tokens[0].latest_nav?.apy).toBe('4.80');
  });

  // Wave 5 Slice 1 (MCP sell) — per-token RedemptionQueue resolution.
  it('resolves redemption_queue_address from the env map (case-insensitive on token key)', async () => {
    const tbill = token('TBILL1', TBILL_ADDR);
    const cetes = token('CETES', CETES_ADDR);
    const QUEUE = '0x435af5af238abe80dd4dc571c38c167f407c4e9c';
    const useCase = new GetTokensUseCase(
      makeTokenRepo([tbill, cetes]),
      makeNavRepo([]),
      makeUserRepo(),
      undefined,
      // Map key is lower-cased per parseTokenAddressMap; TBILL_ADDR is
      // already lower-case here, but toDto lower-cases the token address too.
      { [TBILL_ADDR]: QUEUE },
    );
    const { tokens } = await useCase.execute();
    const tbillDto = tokens.find((t) => t.symbol === 'TBILL1');
    const cetesDto = tokens.find((t) => t.symbol === 'CETES');
    expect(tbillDto?.redemption_queue_address).toBe(QUEUE);
    // No map entry for CETES → null (graceful — viaQueue degrades to Path C).
    expect(cetesDto?.redemption_queue_address).toBeNull();
  });

  it('defaults redemption_queue_address to null when no queue map is supplied', async () => {
    const useCase = new GetTokensUseCase(
      makeTokenRepo([token('TBILL1', TBILL_ADDR)]),
      makeNavRepo([]),
      makeUserRepo(),
    );
    const { tokens } = await useCase.execute();
    expect(tokens[0].redemption_queue_address).toBeNull();
  });
});

describe('GetTokenByAddressUseCase · NAV-source split fallback', () => {
  it('uses nav-history when present', async () => {
    const tbill = token('TBILL1', TBILL_ADDR);
    const tokenRepo = makeTokenRepo([tbill]);
    const navRepo = makeNavRepo([navHistorySnapshot(TBILL_ADDR, '1.0')]);
    const { repo: oracleRepo, findLatestSnapshot } = makeOracleRepo(new Map());

    const useCase = new GetTokenByAddressUseCase(tokenRepo, navRepo, makeUserRepo(), oracleRepo);
    const dto = await useCase.execute(TBILL_ADDR);

    expect(dto?.latest_nav?.nav).toBe('1.0');
    expect(findLatestSnapshot).not.toHaveBeenCalled();
  });

  it('falls back to oracle_snapshots when nav-history is empty', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const tokenRepo = makeTokenRepo([cetes]);
    const navRepo = makeNavRepo([]);
    const oracleRows = new Map<string, OracleSnapshotRead>([
      ['cetes', oracleSnapshot('CETES', '1.0498')],
    ]);
    const { repo: oracleRepo } = makeOracleRepo(oracleRows);

    const useCase = new GetTokenByAddressUseCase(tokenRepo, navRepo, makeUserRepo(), oracleRepo);
    const dto = await useCase.execute(CETES_ADDR);

    expect(dto?.latest_nav?.nav).toBe('1.0498');
    expect(dto?.latest_nav?.source).toBe('rwaxyz_scrape');
  });

  it('returns null latest_nav when neither source has a row', async () => {
    const cetes = token('CETES', CETES_ADDR);
    const useCase = new GetTokenByAddressUseCase(
      makeTokenRepo([cetes]),
      makeNavRepo([]),
      makeUserRepo(),
      makeOracleRepo(new Map()).repo,
    );
    const dto = await useCase.execute(CETES_ADDR);
    expect(dto).not.toBeNull();
    expect(dto?.latest_nav).toBeNull();
  });

  it('returns null DTO when the token is not registered (no fallback fired)', async () => {
    const { repo: oracleRepo, findLatestSnapshot } = makeOracleRepo(new Map());
    const useCase = new GetTokenByAddressUseCase(
      makeTokenRepo([]),
      makeNavRepo([]),
      makeUserRepo(),
      oracleRepo,
    );
    const dto = await useCase.execute(CETES_ADDR);
    expect(dto).toBeNull();
    expect(findLatestSnapshot).not.toHaveBeenCalled();
  });
});
