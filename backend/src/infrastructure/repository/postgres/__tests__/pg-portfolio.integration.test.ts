/**
 * Real-Postgres integration test for `PgPortfolioRepository`.
 *
 * Pins the case-normalization invariant: save() + findByUserAndToken()
 * must dedupe regardless of EIP-55-checksum vs lowercase input. Without
 * the lowercase-at-the-boundary rule, a save() with checksum-cased
 * address followed by save() with the same address in lowercase lands
 * TWO rows in `portfolios` — the unique index on (user_id, token_address)
 * is BYTE-EXACT in Postgres so it doesn't catch the case skew. /portfolio
 * then renders TBILL1 twice. Surfaced 2026-05-17 (memory rule
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
import { randomUUID } from 'node:crypto';
import * as schema from '../schema.js';
import { PgPortfolioRepository } from '../pg-portfolio.repository.js';
import { portfolios, users } from '../schema.js';
import { Portfolio } from '../../../../domain/portfolio/model/portfolio.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

// Realistic TBILL1 deployment address (from staging deploys). The
// distinction between checksum + lowercase is what drives the bug —
// pick a hex that has at least one letter ≥ 10 so the cases visibly
// differ.
const TBILL_CHECKSUMMED = '0x8D773C8b3Ea15Eef2E2F1E6f43Ee8d52c7e57b0D';
const TBILL_LOWER = TBILL_CHECKSUMMED.toLowerCase();
const GOLD_CHECKSUMMED = '0x80327c5D46c2c4C517B5f021f69cA7667f30b270';
const GOLD_LOWER = GOLD_CHECKSUMMED.toLowerCase();

async function insertTestUser(
  db: NodePgDatabase<typeof schema>,
): Promise<string> {
  // Insert a row minimal enough to satisfy the FK from portfolios.user_id
  // → users.id. NOT NULL fields without defaults: walletAddress +
  // walletProvider. Others default (role=investor, issuerStatus=
  // unregistered, createdAt=now()).
  const id = randomUUID();
  await db.insert(users).values({
    id,
    walletAddress: `0x${id.replace(/-/g, '').slice(0, 40)}`,
    walletProvider: 'zerodev',
  });
  return id;
}

describeIfPg('PgPortfolioRepository · case-normalized writes + reads (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgPortfolioRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgPortfolioRepository(db);

    await db.execute(sql`SELECT 1 FROM ${portfolios} LIMIT 0`).catch((err) => {
      throw new Error(
        `portfolios table missing — run \`pnpm db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Order matters: portfolios FK → users.
    await db.execute(sql`TRUNCATE TABLE ${portfolios}`);
    await db.execute(sql`TRUNCATE TABLE ${users} CASCADE`);
  });

  it('stores the address lowercased regardless of input case', async () => {
    const userId = await insertTestUser(db);
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_CHECKSUMMED,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );

    const stored = await db.query.portfolios.findFirst({
      where: sql`${portfolios.userId} = ${userId}`,
    });
    expect(stored?.tokenAddress).toBe(TBILL_LOWER);
  });

  it('save twice with different cases produces ONE row (no dup)', async () => {
    // The original bug: TradePage wrote checksum, AgentPage post-buy wrote
    // lowercase, both landed because the unique index on (user_id,
    // token_address) was byte-exact AND findByUserAndToken's case-exact
    // lookup missed the prior row.
    const userId = await insertTestUser(db);
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_CHECKSUMMED,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_LOWER,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );

    const all = await repo.findByUserId(userId);
    expect(all).toHaveLength(1);
    expect(all[0].tokenAddress).toBe(TBILL_LOWER);
  });

  it('findByUserAndToken returns the row regardless of input case', async () => {
    const userId = await insertTestUser(db);
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_LOWER, // stored lowercase
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );

    // Query with checksum → must still find the row.
    const byChecksum = await repo.findByUserAndToken(userId, TBILL_CHECKSUMMED);
    expect(byChecksum).not.toBeNull();
    expect(byChecksum?.tokenSymbol).toBe('TBILL1');

    // Query with lowercase → must find it too (back-compat with
    // legacy callers that already lowercase).
    const byLower = await repo.findByUserAndToken(userId, TBILL_LOWER);
    expect(byLower).not.toBeNull();

    // Query with the UPPERCASE form too — defensive, since a malformed
    // input from an older client shouldn't bypass the lookup.
    const byUpper = await repo.findByUserAndToken(userId, TBILL_CHECKSUMMED.toUpperCase());
    expect(byUpper).not.toBeNull();
  });

  it('findByUserAndToken returns null for an unknown address', async () => {
    const userId = await insertTestUser(db);
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_LOWER,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );
    const miss = await repo.findByUserAndToken(userId, GOLD_LOWER);
    expect(miss).toBeNull();
  });

  it('save updates tokenSymbol + lastSyncedAt on conflict (case-insensitive)', async () => {
    const userId = await insertTestUser(db);
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-05-17T00:00:00Z');
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_CHECKSUMMED,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: t0,
      }),
    );
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_LOWER,
        tokenSymbol: 'TBILL1-renamed',
        lastSyncedAt: t1,
      }),
    );

    const found = await repo.findByUserAndToken(userId, TBILL_CHECKSUMMED);
    expect(found?.tokenSymbol).toBe('TBILL1-renamed');
    expect(found?.lastSyncedAt?.toISOString()).toBe(t1.toISOString());
  });

  it('two different tokens for the same user both persist', async () => {
    const userId = await insertTestUser(db);
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: TBILL_CHECKSUMMED,
        tokenSymbol: 'TBILL1',
        lastSyncedAt: new Date(),
      }),
    );
    await repo.save(
      new Portfolio({
        id: randomUUID(),
        userId,
        tokenAddress: GOLD_CHECKSUMMED,
        tokenSymbol: 'GOLD1',
        lastSyncedAt: new Date(),
      }),
    );

    const all = await repo.findByUserId(userId);
    expect(all).toHaveLength(2);
    const addrs = all.map((p) => p.tokenAddress).sort();
    expect(addrs).toEqual([GOLD_LOWER, TBILL_LOWER].sort());
  });
});
