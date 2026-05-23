/**
 * Real-Postgres integration test for `PgOracleRepository.findLatestSnapshotsByTickers`.
 *
 * Added 2026-05-23 alongside the Wave 5 Path D bug #7 NAV-source split
 * fix. The bulk shape collapses the previous per-token `findFirst`
 * fanout into a single DISTINCT-ON query — that SQL is mocked-unfriendly
 * (mocked drivers can't tell you whether `ANY($1::text[])` is the right
 * shape on a `numeric[]`-typed bind, or whether `DISTINCT ON (lower(ticker))`
 * actually returns one row per case-normalized group). This suite pins
 * the contract against a real planner. Per
 * `feedback_sql_bugs_need_real_pg_integration_test`.
 *
 * Gates on `INTEGRATION_PG_URL` per the P10 pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { PgOracleRepository } from '../pg-oracle.repository.js';
import { oracleSnapshots } from '../schema.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

// Suite-scoped tickers to avoid trampling other parallel suites
// (per `feedback_parallel_integration_test_isolation`).
const T_A = 'INT_BULK_A';
const T_B = 'INT_BULK_B';
const T_C = 'INT_BULK_C'; // intentionally unseeded — exercises miss

describeIfPg('PgOracleRepository.findLatestSnapshotsByTickers (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgOracleRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgOracleRepository(db);

    await db.execute(sql`SELECT 1 FROM ${oracleSnapshots} LIMIT 0`).catch((err) => {
      throw new Error(
        `oracle_snapshots table missing — run \`pnpm db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`DELETE FROM ${oracleSnapshots} WHERE lower(ticker) IN (${T_A.toLowerCase()}, ${T_B.toLowerCase()}, ${T_C.toLowerCase()})`,
    );
  });

  async function seed(
    ticker: string,
    navDollar: string,
    snapshotAt: Date,
  ): Promise<void> {
    await db.insert(oracleSnapshots).values({
      ticker,
      snapshotAt,
      source: 'rwaxyz_scrape',
      navDollar,
    });
  }

  it('returns an empty map for empty input without hitting the DB', async () => {
    // No insert needed; we just verify the shape and that the call
    // doesn't throw on an empty array.
    const out = await repo.findLatestSnapshotsByTickers([]);
    expect(out.size).toBe(0);
  });

  it('returns the latest snapshot per ticker (DISTINCT ON behavior)', async () => {
    const earlier = new Date('2026-05-22T20:00:00Z');
    const later = new Date('2026-05-22T23:00:00Z');
    await seed(T_A, '1.0', earlier);
    await seed(T_A, '1.05', later); // newer should win
    await seed(T_B, '2400.0', earlier);

    const out = await repo.findLatestSnapshotsByTickers([T_A, T_B]);
    expect(out.size).toBe(2);
    expect(out.get(T_A.toLowerCase())?.navDollar).toBe('1.05000000');
    expect(out.get(T_B.toLowerCase())?.navDollar).toBe('2400.00000000');
  });

  it('omits tickers without any snapshot (no null-valued entries)', async () => {
    await seed(T_A, '1.0', new Date('2026-05-22T23:00:00Z'));
    const out = await repo.findLatestSnapshotsByTickers([T_A, T_C]);
    expect(out.has(T_A.toLowerCase())).toBe(true);
    expect(out.has(T_C.toLowerCase())).toBe(false);
    expect(out.size).toBe(1);
  });

  it('case-insensitive: input case does not affect resolution', async () => {
    // Writer wrote with the suite-scoped uppercase form; caller asks
    // with the lowercase form.
    await seed(T_A, '1.0', new Date('2026-05-22T23:00:00Z'));
    const out = await repo.findLatestSnapshotsByTickers([T_A.toLowerCase()]);
    expect(out.has(T_A.toLowerCase())).toBe(true);
  });

  it('dedupes mixed-case input so a caller passing both forms only pays one row of params', async () => {
    await seed(T_A, '1.0', new Date('2026-05-22T23:00:00Z'));
    const out = await repo.findLatestSnapshotsByTickers([T_A, T_A.toLowerCase()]);
    expect(out.size).toBe(1);
    expect(out.has(T_A.toLowerCase())).toBe(true);
  });
});
