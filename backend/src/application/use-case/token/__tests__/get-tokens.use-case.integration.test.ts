/**
 * Wave 5 — Real-Postgres integration coverage for the NAV-source split
 * fallback (bug #7, `development/DEV_WAVE_5/NAV_SOURCE_SPLIT.md`).
 *
 * The unit tests in `get-tokens.use-case.test.ts` stub both repositories;
 * this suite wires the real Pg drivers + Drizzle schema so a future
 * refactor that drifts the SQL contract (e.g. `findLatestSnapshot`'s
 * `lower(ticker) = lower(?)` predicate, or `findLatestForAllTokens`'s
 * DISTINCT-ON ordering) cannot quietly land — per
 * `feedback_sql_bugs_need_real_pg_integration_test`.
 *
 * Coverage:
 *   1. nav-history hit  → primary path returns the on-chain NAV
 *   2. nav-history empty + oracle_snapshots hit → synthesized NAV
 *      surfaces with `source = 'rwaxyz_scrape'`
 *   3. ticker case-mismatch (`'cetes'` row vs `symbol='CETES'`) →
 *      fallback still resolves (the oracle repo's case-insensitive
 *      predicate is load-bearing for the catalog)
 *
 * Gates on `INTEGRATION_PG_URL` per the P10 pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../../../../infrastructure/repository/postgres/schema.js';
import { PgRwaTokenRepository } from '../../../../infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { PgNavHistoryRepository } from '../../../../infrastructure/repository/postgres/pg-nav-history.repository.js';
import { PgOracleRepository } from '../../../../infrastructure/repository/postgres/pg-oracle.repository.js';
import {
  rwaTokens,
  tokenNavHistory,
  oracleSnapshots,
  tokenMetadata,
} from '../../../../infrastructure/repository/postgres/schema.js';
import { GetTokensUseCase, GetTokenByAddressUseCase } from '../get-tokens.use-case.js';
import { RwaToken } from '../../../../domain/token-registry/model/rwa-token.js';
import { NavSnapshot } from '../../../../domain/nav-history/model/nav-snapshot.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

// Suite-scoped address namespace — these IDs/addresses are unique to
// this file so parallel integration suites that hit the same DB don't
// collide (per `feedback_parallel_integration_test_isolation`).
const TBILL_ADDR = '0x' + 'b'.repeat(40);
const CETES_ADDR = '0x' + 'c'.repeat(40);
const ISSUER_ADDR = '0x' + 'a'.repeat(40);

describeIfPg('GetTokensUseCase · NAV-source split fallback (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let tokenRepo: PgRwaTokenRepository;
  let navRepo: PgNavHistoryRepository;
  let oracleRepo: PgOracleRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    tokenRepo = new PgRwaTokenRepository(db);
    navRepo = new PgNavHistoryRepository(db);
    oracleRepo = new PgOracleRepository(db);

    for (const t of [rwaTokens, tokenNavHistory, oracleSnapshots, tokenMetadata]) {
      await db.execute(sql`SELECT 1 FROM ${t} LIMIT 0`).catch((err) => {
        throw new Error(
          `table missing — run \`pnpm db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
        );
      });
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Targeted deletes scoped to THIS suite's addresses + tickers so
    // parallel integration suites (e.g. pg-nav-history) don't have
    // their fixtures trampled — see
    // `feedback_parallel_integration_test_isolation`.
    await db.execute(
      sql`DELETE FROM ${tokenNavHistory} WHERE lower(token_address) IN (${TBILL_ADDR.toLowerCase()}, ${CETES_ADDR.toLowerCase()})`,
    );
    await db.execute(
      sql`DELETE FROM ${oracleSnapshots} WHERE lower(ticker) IN ('tbill1', 'cetes')`,
    );
    await db.execute(
      sql`DELETE FROM ${rwaTokens} WHERE address IN (${TBILL_ADDR}, ${CETES_ADDR})`,
    );
  });

  async function seedToken(symbol: string, address: string, status: 'active' | 'winding_down' = 'active') {
    const now = new Date('2026-05-23T02:00:00Z');
    await tokenRepo.save(
      new RwaToken({
        id: randomUUID(),
        address,
        name: `${symbol} integration fixture`,
        symbol,
        issuerAddress: ISSUER_ADDR,
        kycTier: 1,
        assetClass: 'treasury',
        status,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async function seedNavHistory(address: string, nav: string) {
    await navRepo.save(
      new NavSnapshot({
        id: randomUUID(),
        tokenAddress: address,
        nav,
        apy: '5.10',
        source: 'fred:DGS3MO',
        sourceType: 'api',
        fetchedAt: new Date('2026-05-23T01:00:00Z'),
        createdAt: new Date('2026-05-23T01:00:00Z'),
      }),
    );
  }

  async function seedOracleSnapshot(
    ticker: string,
    navDollar: string,
    snapshotAt: Date = new Date('2026-05-22T23:00:00Z'),
  ) {
    await db.insert(oracleSnapshots).values({
      ticker,
      snapshotAt,
      source: 'rwaxyz_scrape',
      navDollar,
      apy7Day: '4.95',
      totalAssetValueDollar: '7500000.00',
      holdingAddressesCount: 42,
      rwaxyzUpdatedAt: new Date('2026-05-22T22:00:00Z'),
    });
  }

  it('returns nav-history NAV when both sources are populated (primary wins)', async () => {
    await seedToken('TBILL1', TBILL_ADDR, 'winding_down');
    await seedNavHistory(TBILL_ADDR, '1.0042');
    await seedOracleSnapshot('TBILL1', '9.99'); // should be ignored

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, undefined, oracleRepo);
    const { tokens } = await useCase.execute();

    const tbill = tokens.find((t) => t.address.toLowerCase() === TBILL_ADDR.toLowerCase());
    expect(tbill).toBeDefined();
    expect(tbill?.latest_nav?.nav).toBe('1.0042');
    expect(tbill?.latest_nav?.source).toBe('fred:DGS3MO');
  });

  it('falls back to oracle_snapshots when nav-history is empty (Wave 5 1A path)', async () => {
    await seedToken('CETES', CETES_ADDR, 'active');
    await seedOracleSnapshot('CETES', '1.0498');

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, undefined, oracleRepo);
    const { tokens } = await useCase.execute();

    const cetes = tokens.find((t) => t.address.toLowerCase() === CETES_ADDR.toLowerCase());
    expect(cetes).toBeDefined();
    expect(cetes?.latest_nav).not.toBeNull();
    expect(cetes?.latest_nav?.nav).toBe('1.04980000'); // numeric(20,8) round-trip
    expect(cetes?.latest_nav?.apy).toBe('4.950000');
    expect(cetes?.latest_nav?.total_aum).toBe('7500000.00000000');
    expect(cetes?.latest_nav?.source).toBe('rwaxyz_scrape');
    expect(cetes?.latest_nav?.source_type).toBe('api');
  });

  it('resolves oracle fallback when token.symbol mixed-case differs from oracle ticker', async () => {
    // The Wave 5 1A catalogue includes mixed-case symbols (`syrupUSDC`,
    // `ONyc`, `NVDAon`, `MUon`). The oracle repo's case-insensitive
    // predicate is what keeps the fallback honest in practice.
    await seedToken('CETES', CETES_ADDR, 'active');
    await seedOracleSnapshot('cetes', '1.0500'); // lowercased writer

    const useCase = new GetTokensUseCase(tokenRepo, navRepo, undefined, oracleRepo);
    const { tokens } = await useCase.execute();

    const cetes = tokens.find((t) => t.address.toLowerCase() === CETES_ADDR.toLowerCase());
    expect(cetes?.latest_nav?.nav).toBe('1.05000000');
  });

  it('GetTokenByAddressUseCase resolves oracle fallback for a single token lookup', async () => {
    await seedToken('CETES', CETES_ADDR, 'active');
    await seedOracleSnapshot('CETES', '1.0123');

    const useCase = new GetTokenByAddressUseCase(tokenRepo, navRepo, undefined, oracleRepo);
    const dto = await useCase.execute(CETES_ADDR);

    expect(dto).not.toBeNull();
    expect(dto?.latest_nav?.nav).toBe('1.01230000');
    expect(dto?.latest_nav?.source).toBe('rwaxyz_scrape');
  });
});
