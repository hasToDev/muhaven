/**
 * Real-Postgres integration test for `PgNavHistoryRepository`.
 *
 * Pins the case-insensitivity invariant on every read path. The
 * nav-worker writes checksummed addresses (mixed case from
 * `engine.ts:STAGING_TBILL1` etc.) but every caller of this repo (e.g.
 * `quote.use-case.ts`, `portfolio-summary.use-case.ts`,
 * `metrics.use-case.ts`) lowercases at the boundary. A plain
 * `eq(col, input)` would silently miss — surfaced 2026-05-09 when
 * AGENTIC_TEST_PLAN §1c step 4 hit "No NAV snapshot indexed for TBILL1"
 * even though `nav-worker` had inserted 21 backfill rows (memory rule
 * `feedback_address_case_at_repo_boundary`).
 *
 * Gates on `INTEGRATION_PG_URL` per the P10 pattern — `pnpm test` skips
 * locally when the env var is unset; CI sets it via the
 * `backend-vitest-pg` job in `.github/workflows/ci.yml`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { PgNavHistoryRepository } from '../pg-nav-history.repository.js';
import { tokenNavHistory } from '../schema.js';
import { NavSnapshot } from '../../../../domain/nav-history/model/nav-snapshot.js';
import { randomUUID } from 'node:crypto';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const TBILL_CHECKSUMMED = '0xe80a64C13759e9b823265e2691c7C481EaAaf6e2';
const TBILL_LOWER = TBILL_CHECKSUMMED.toLowerCase();
const TBILL_UPPER = TBILL_CHECKSUMMED.toUpperCase();
const GOLD_CHECKSUMMED = '0x80327c5D46c2c4C517B5f021f69cA7667f30b270';

describeIfPg('PgNavHistoryRepository · case-insensitive token-address lookup (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgNavHistoryRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgNavHistoryRepository(db);

    await db.execute(sql`SELECT 1 FROM ${tokenNavHistory} LIMIT 0`).catch((err) => {
      throw new Error(
        `token_nav_history table missing — run \`pnpm db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ${tokenNavHistory}`);
  });

  function snapshot(
    tokenAddress: string,
    nav: string,
    fetchedAt = new Date('2026-05-09T12:00:00Z'),
  ): NavSnapshot {
    return new NavSnapshot({
      id: randomUUID(),
      tokenAddress,
      nav,
      apy: '3.69',
      totalAum: null,
      yieldRate: '3.69',
      source: 'fred:DGS3MO',
      sourceType: 'api',
      sourceTimestamp: fetchedAt,
      fetchedAt,
      createdAt: fetchedAt,
    });
  }

  describe('findLatestByToken', () => {
    it('finds a checksummed-address row when the lookup is lowercased', async () => {
      // Mimics the nav-worker write path: address is checksummed.
      await repo.save(snapshot(TBILL_CHECKSUMMED, '1.0'));
      // Mimics the quote use-case lookup path: address is lowercased.
      const found = await repo.findLatestByToken(TBILL_LOWER);
      expect(found).not.toBeNull();
      expect(found?.nav).toBe('1.0');
    });

    it('finds a lowercased-address row when the lookup is checksummed', async () => {
      await repo.save(snapshot(TBILL_LOWER, '1.0'));
      const found = await repo.findLatestByToken(TBILL_CHECKSUMMED);
      expect(found).not.toBeNull();
    });

    it('finds an UPPERCASED-address row when the lookup is mixed case', async () => {
      await repo.save(snapshot(TBILL_UPPER, '1.0'));
      const found = await repo.findLatestByToken(TBILL_CHECKSUMMED);
      expect(found).not.toBeNull();
    });

    it('picks the row with the latest fetchedAt across mixed-case writers', async () => {
      const earlier = new Date('2026-05-09T10:00:00Z');
      const later = new Date('2026-05-09T13:00:00Z');
      await repo.save(snapshot(TBILL_CHECKSUMMED, '1.0', earlier));
      await repo.save(snapshot(TBILL_LOWER, '1.05', later));
      const found = await repo.findLatestByToken(TBILL_CHECKSUMMED);
      expect(found?.nav).toBe('1.05');
    });

    it('returns null when no row matches, even with mixed case', async () => {
      const found = await repo.findLatestByToken(TBILL_CHECKSUMMED);
      expect(found).toBeNull();
    });
  });

  describe('findByToken (history)', () => {
    it('returns rows across writer-case variants', async () => {
      await repo.save(snapshot(TBILL_CHECKSUMMED, '1.0', new Date('2026-05-08T12:00:00Z')));
      await repo.save(snapshot(TBILL_LOWER, '1.01', new Date('2026-05-09T12:00:00Z')));
      const rows = await repo.findByToken(TBILL_CHECKSUMMED);
      expect(rows).toHaveLength(2);
      // Default order is fetchedAt desc.
      expect(rows[0].nav).toBe('1.01');
    });
  });

  describe('findLatestForAllTokens', () => {
    it('collapses mixed-case writers into a single canonical group per token', async () => {
      // Two writers, two cases — should resolve to ONE TBILL1 group.
      await repo.save(snapshot(TBILL_CHECKSUMMED, '1.0', new Date('2026-05-08T12:00:00Z')));
      await repo.save(snapshot(TBILL_LOWER, '1.01', new Date('2026-05-09T12:00:00Z')));
      // Plus a different token.
      await repo.save(snapshot(GOLD_CHECKSUMMED, '2400.5'));

      const all = await repo.findLatestForAllTokens();
      expect(all).toHaveLength(2);
      // The TBILL1 group's latest should be the lowered-case row from
      // 2026-05-09 (later fetchedAt wins).
      const tbill = all.find((s) => s.tokenAddress.toLowerCase() === TBILL_LOWER);
      expect(tbill?.nav).toBe('1.01');
      const gold = all.find((s) => s.tokenAddress.toLowerCase() === GOLD_CHECKSUMMED.toLowerCase());
      expect(gold?.nav).toBe('2400.5');
    });
  });
});
