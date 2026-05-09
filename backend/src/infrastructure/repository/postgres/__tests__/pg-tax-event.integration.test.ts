/**
 * Real-Postgres integration test for the Wave 4 P9 tax-event aggregate
 * methods. Locks in the SQL-level behaviour the unit tests can't cover:
 * `lower(token_address)` projection at the boundary, jsonb
 * `metadata->>'kind'` extract, `date_trunc('day', ...)` UTC bucketing,
 * and group-by behaviour on the seven-value pg enum.
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
import { PgTaxEventRepository } from '../pg-tax-event.repository.js';
import { taxEvents } from '../schema.js';
import { TaxEvent } from '../../../../domain/tax-event/model/tax-event.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const TBILL_LOWER = '0xabcdef0000000000000000000000000000000001';
const TBILL_CHECK = '0xAbCdEf0000000000000000000000000000000001';
const GOLD_LOWER = '0xabcdef0000000000000000000000000000000002';
const HOLDER = '0x1111111111111111111111111111111111111111';

describeIfPg('PgTaxEventRepository · Wave 4 P9 aggregates (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgTaxEventRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgTaxEventRepository(db);

    await db.execute(sql`SELECT 1 FROM ${taxEvents} LIMIT 0`).catch((err) => {
      throw new Error(
        `tax_events table missing — run \`pnpm db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ${taxEvents}`);
  });

  function evt(
    overrides: Partial<ConstructorParameters<typeof TaxEvent>[0]> & { txHash: string },
  ): TaxEvent {
    return new TaxEvent({
      logIndex: 0,
      eventType: 'Acquisition',
      holderAddress: HOLDER,
      tokenAddress: TBILL_LOWER,
      blockNumber: '100',
      blockTimestamp: new Date('2026-05-01T12:00:00Z'),
      navAtTime: null,
      referenceId: null,
      metadata: null,
      ...overrides,
    });
  }

  describe('aggregateCounts', () => {
    it('groups counts across all seven event types and returns zero for absent types', async () => {
      await repo.saveMany([
        evt({ txHash: '0xa1', eventType: 'Acquisition' }),
        evt({ txHash: '0xa2', eventType: 'Acquisition' }),
        evt({ txHash: '0xb1', eventType: 'Disposition', metadata: { kind: 'instant' } }),
        evt({ txHash: '0xc1', eventType: 'Wrap' }),
      ]);

      const counts = await repo.aggregateCounts();

      expect(counts.Acquisition).toBe(2);
      expect(counts.Disposition).toBe(1);
      expect(counts.Wrap).toBe(1);
      expect(counts.IncomeAccrual).toBe(0);
      expect(counts.FeeEvent).toBe(0);
      expect(counts.Unwrap).toBe(0);
      expect(counts.Transfer).toBe(0);
    });
  });

  describe('dailyCounts', () => {
    it('buckets by `date_trunc(day)` in UTC and orders ascending', async () => {
      await repo.saveMany([
        evt({ txHash: '0x1', blockTimestamp: new Date('2026-05-01T01:00:00Z') }),
        evt({ txHash: '0x2', blockTimestamp: new Date('2026-05-01T23:00:00Z') }),
        evt({ txHash: '0x3', blockTimestamp: new Date('2026-05-02T03:00:00Z') }),
      ]);

      const out = await repo.dailyCounts('Acquisition');

      expect(out).toEqual([
        { day: '2026-05-01', count: 2 },
        { day: '2026-05-02', count: 1 },
      ]);
    });

    it('returns an empty array when no events of that type exist', async () => {
      await repo.saveMany([evt({ txHash: '0xa', eventType: 'Wrap' })]);

      const out = await repo.dailyCounts('Acquisition');

      expect(out).toEqual([]);
    });
  });

  describe('acquisitionsByToken', () => {
    it('lower-cases token_address regardless of stored case', async () => {
      // Same logical token, but mixed casing on the stored row. The
      // SQL `lower(token_address)` projection collapses both into the
      // same group — proves the address-case posture works at the
      // SQL boundary.
      await repo.saveMany([
        evt({ txHash: '0x1', tokenAddress: TBILL_LOWER }),
        evt({
          txHash: '0x2',
          logIndex: 1,
          tokenAddress: TBILL_CHECK,
        }),
        evt({ txHash: '0x3', tokenAddress: GOLD_LOWER }),
      ]);

      const out = await repo.acquisitionsByToken();

      const tbill = out.find((r) => r.tokenAddress === TBILL_LOWER);
      const gold = out.find((r) => r.tokenAddress === GOLD_LOWER);
      expect(tbill?.count).toBe(2);
      expect(gold?.count).toBe(1);
      // Every projected address is lower-cased.
      for (const row of out) {
        expect(row.tokenAddress).toBe(row.tokenAddress.toLowerCase());
      }
    });

    it('filters out rows with null token_address (Wrap/Unwrap rows have token=null)', async () => {
      await repo.saveMany([
        evt({ txHash: '0xa', eventType: 'Acquisition', tokenAddress: TBILL_LOWER }),
        evt({ txHash: '0xb', eventType: 'Acquisition', tokenAddress: null }),
      ]);

      const out = await repo.acquisitionsByToken();

      expect(out).toEqual([{ tokenAddress: TBILL_LOWER, count: 1 }]);
    });
  });

  describe('hasInvestorActivity', () => {
    // Wave 4 follow-up — locks in the SQL-level cash-rail exclusion
    // against a real pg enum. Unit-level stub coverage lives in
    // `apply-issuer.use-case.test.ts`; this case proves the
    // `inArray(eventType, INVESTOR_ACTIVITY_EVENT_TYPES)` filter
    // actually reaches Postgres correctly. Regression for the
    // 2026-05-09 issuer-onboarding bug (fresh wallet wraps USDC →
    // locked out of /apply-issuer).
    const HOLDER_LOWER = '0x2222222222222222222222222222222222222222';
    const HOLDER_CHECK = '0x2222222222222222222222222222222222222222';

    it('returns false for a holder with only cash-rail Wrap rows', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xw1',
          eventType: 'Wrap',
          holderAddress: HOLDER_LOWER,
          tokenAddress: null,
          metadata: { kind: 'wrap' },
        }),
      ]);

      expect(await repo.hasInvestorActivity(HOLDER_LOWER)).toBe(false);
    });

    it('returns false for a holder with only Unwrap rows', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xu1',
          eventType: 'Unwrap',
          holderAddress: HOLDER_LOWER,
          tokenAddress: null,
          metadata: { kind: 'unwrap' },
        }),
      ]);

      expect(await repo.hasInvestorActivity(HOLDER_LOWER)).toBe(false);
    });

    it('returns true when the holder has an RWA Acquisition alongside cash-rail Wrap rows', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xw1',
          eventType: 'Wrap',
          holderAddress: HOLDER_LOWER,
          tokenAddress: null,
        }),
        evt({
          txHash: '0xa1',
          eventType: 'Acquisition',
          holderAddress: HOLDER_LOWER,
          tokenAddress: TBILL_LOWER,
        }),
      ]);

      expect(await repo.hasInvestorActivity(HOLDER_LOWER)).toBe(true);
    });

    it.each(['Disposition', 'IncomeAccrual', 'FeeEvent', 'Transfer'] as const)(
      'returns true when the holder has any %s row',
      async (eventType) => {
        await repo.saveMany([
          evt({
            txHash: `0x${eventType}`,
            eventType,
            holderAddress: HOLDER_LOWER,
            tokenAddress: TBILL_LOWER,
          }),
        ]);

        expect(await repo.hasInvestorActivity(HOLDER_LOWER)).toBe(true);
      },
    );

    it('matches case-insensitively at the address boundary', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xa1',
          eventType: 'Acquisition',
          holderAddress: HOLDER_LOWER,
          tokenAddress: TBILL_LOWER,
        }),
      ]);

      expect(await repo.hasInvestorActivity(HOLDER_CHECK.toUpperCase())).toBe(true);
    });

    it('returns false for an unknown holder', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xa1',
          eventType: 'Acquisition',
          holderAddress: HOLDER_LOWER,
          tokenAddress: TBILL_LOWER,
        }),
      ]);

      expect(
        await repo.hasInvestorActivity('0x9999999999999999999999999999999999999999'),
      ).toBe(false);
    });
  });

  describe('dispositionsByKind', () => {
    it('extracts metadata->>kind via jsonb operator and groups for both totals + byDay', async () => {
      await repo.saveMany([
        evt({
          txHash: '0xa',
          eventType: 'Disposition',
          metadata: { kind: 'instant' },
          blockTimestamp: new Date('2026-05-01T12:00:00Z'),
        }),
        evt({
          txHash: '0xb',
          eventType: 'Disposition',
          metadata: { kind: 'instant' },
          blockTimestamp: new Date('2026-05-01T15:00:00Z'),
        }),
        evt({
          txHash: '0xc',
          eventType: 'Disposition',
          metadata: { kind: 'queued' },
          blockTimestamp: new Date('2026-05-02T08:00:00Z'),
        }),
        evt({
          txHash: '0xd',
          eventType: 'Disposition',
          metadata: { kind: 'escalated_to_queue' },
          blockTimestamp: new Date('2026-05-02T09:00:00Z'),
        }),
        // Unknown kind — silently dropped from totals + byDay slots.
        evt({
          txHash: '0xe',
          eventType: 'Disposition',
          metadata: { kind: 'someday_added_kind' },
          blockTimestamp: new Date('2026-05-02T10:00:00Z'),
        }),
        // Disposition with no metadata — same drop semantics.
        evt({
          txHash: '0xf',
          eventType: 'Disposition',
          metadata: null,
          blockTimestamp: new Date('2026-05-02T11:00:00Z'),
        }),
      ]);

      const out = await repo.dispositionsByKind();

      expect(out.totals).toEqual({ instant: 2, queued: 1, escalatedToQueue: 1 });
      expect(out.byDay).toEqual([
        { day: '2026-05-01', instant: 2, queued: 0, escalatedToQueue: 0 },
        { day: '2026-05-02', instant: 0, queued: 1, escalatedToQueue: 1 },
      ]);
    });

    it('returns zero totals + empty byDay when no Disposition rows exist', async () => {
      await repo.saveMany([evt({ txHash: '0x1', eventType: 'Acquisition' })]);

      const out = await repo.dispositionsByKind();

      expect(out).toEqual({
        totals: { instant: 0, queued: 0, escalatedToQueue: 0 },
        byDay: [],
      });
    });
  });
});
