/**
 * Real-Postgres integration test for the device-code state machine.
 *
 * Wave 4 P10 §"P3 deferred testing" — the in-memory repository tests in
 * `application/use-case/auth/__tests__/device-flow.test.ts` cover the
 * state machine logic, but the Drizzle-declared partial unique index
 * `agent_device_codes_user_code_pending_idx` (UNIQUE (userCode) WHERE
 * status='pending') only matters when Postgres enforces it. A regression
 * in the predicate (e.g. someone widening it to UNIQUE (userCode)
 * unconditionally, or removing the WHERE clause) would silently pass
 * the in-memory suite while breaking the device-flow once a code is
 * consumed/denied/expired.
 *
 * The whole suite gates on `INTEGRATION_PG_URL` — when unset the suite
 * skips so `pnpm test` stays green for contributors without a
 * Postgres. CI sets the env var (see `.github/workflows/ci.yml`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { PgAgentDeviceCodeRepository } from '../pg-agent-device-code.repository.js';
import { agentDeviceCodes } from '../schema.js';
import { DeviceCodeStatus } from '../../../../domain/auth/model/agent-device-code.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;

// describe.skipIf when PG isn't available — keeps `pnpm test` green for
// contributors without a Postgres on `INTEGRATION_PG_URL`.
const describeIfPg = PG_URL ? describe : describe.skip;

const meta = { processName: 'integration-test', hostname: 'ci', os: 'linux' };

function dc(seed: string): string {
  // Deterministic 64-hex device code derived from a label so test
  // failures point at the offending row.
  return seed.padEnd(64, '0').slice(0, 64);
}

function uc(seed: string): string {
  // Deterministic XXXX-XXXX user code from a label. Use the Crockford
  // alphabet (no O/I/0/1/L) so the strings are realistic.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alpha[(seed.charCodeAt(i % seed.length) + i) % alpha.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

describeIfPg('PgAgentDeviceCodeRepository (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgAgentDeviceCodeRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgAgentDeviceCodeRepository(db);

    // Sanity-probe the schema. If the table is missing, fail loud
    // instead of letting the assertions fall through with cryptic
    // "relation does not exist" errors mid-test.
    await db.execute(sql`SELECT 1 FROM ${agentDeviceCodes} LIMIT 0`).catch((err) => {
      throw new Error(
        `agent_device_codes table missing — run \`pnpm --filter @muhaven/backend db:push --force\` against ${PG_URL} before running integration tests.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ${agentDeviceCodes}`);
  });

  describe('issue + lookup', () => {
    it('inserts a pending row + roundtrips fields', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const now = new Date();
      const inserted = await repo.issue({
        deviceCode: dc('a1'),
        userCode: uc('a1'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      expect(inserted.status).toBe(DeviceCodeStatus.Pending);
      expect(inserted.deviceCode).toBe(dc('a1'));
      expect(inserted.userCode).toBe(uc('a1'));
      expect(inserted.requesterMetadata).toEqual(meta);
      expect(inserted.expiresAt.getTime()).toBe(expiresAt.getTime());

      const byDevice = await repo.findByDeviceCode(dc('a1'));
      expect(byDevice?.userCode).toBe(uc('a1'));
      const byUser = await repo.findByUserCode(uc('a1'));
      expect(byUser?.deviceCode).toBe(dc('a1'));
    });

    it('throws PG 23505 on duplicate pending userCode (partial unique index fires)', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('b1'),
        userCode: uc('b'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await expect(
        repo.issue({
          deviceCode: dc('b2'),
          userCode: uc('b'),
          requesterMetadata: meta,
          expiresAt,
          now,
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('partial-unique index DOES allow a fresh pending after the prior row is consumed', async () => {
      // This is the load-bearing assertion: the index `WHERE status='pending'`
      // must permit a new pending row once the prior one is no longer pending.
      // A regression to UNIQUE (userCode) unconditionally would 23505 here.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('c1'),
        userCode: uc('c'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.authorize({
        userCode: uc('c'),
        userId: 'u1',
        jwt: 'jwt-c1',
        scope: ['mcp.read.*'],
        now,
      });
      await repo.consume(dc('c1'), now);

      // Fresh issue with the same userCode should succeed because the
      // prior row is `consumed`, not `pending`.
      const fresh = await repo.issue({
        deviceCode: dc('c2'),
        userCode: uc('c'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      expect(fresh.deviceCode).toBe(dc('c2'));
      expect(fresh.status).toBe(DeviceCodeStatus.Pending);
    });

    it('partial-unique index DOES allow a fresh pending after the prior row is denied', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('d1'),
        userCode: uc('d'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.deny({ userCode: uc('d'), userId: 'u1', reason: 'wrong device', now });

      const fresh = await repo.issue({
        deviceCode: dc('d2'),
        userCode: uc('d'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      expect(fresh.deviceCode).toBe(dc('d2'));
      expect(fresh.status).toBe(DeviceCodeStatus.Pending);
    });

    it('partial-unique index DOES allow a fresh pending after the prior row is swept-expired', async () => {
      const now = new Date();
      // Insert with an already-past expiresAt so sweepExpired flips it.
      const expiredAt = new Date(now.getTime() - 60_000);
      await repo.issue({
        deviceCode: dc('e1'),
        userCode: uc('e'),
        requesterMetadata: meta,
        expiresAt: expiredAt,
        now,
      });
      const swept = await repo.sweepExpired(now);
      expect(swept).toBe(1);

      const fresh = await repo.issue({
        deviceCode: dc('e2'),
        userCode: uc('e'),
        requesterMetadata: meta,
        expiresAt: new Date(now.getTime() + 60_000),
        now,
      });
      expect(fresh.deviceCode).toBe(dc('e2'));
    });
  });

  describe('authorize → consume happy path', () => {
    it('flips pending → authorized → consumed atomically', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('f1'),
        userCode: uc('f'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });

      const authorized = await repo.authorize({
        userCode: uc('f'),
        userId: 'u1',
        jwt: 'jwt-f1',
        scope: ['mcp.read.*', 'mcp.propose.*'],
        now,
      });
      expect(authorized?.status).toBe(DeviceCodeStatus.Authorized);
      expect(authorized?.userId).toBe('u1');
      expect(authorized?.scope).toEqual(['mcp.read.*', 'mcp.propose.*']);
      expect(authorized?.jwt).toBe('jwt-f1');

      const consumed = await repo.consume(dc('f1'), now);
      expect(consumed?.jwt).toBe('jwt-f1');
      expect(consumed?.scope).toEqual(['mcp.read.*', 'mcp.propose.*']);

      // After consume the JWT column MUST be cleared. A subsequent
      // findByDeviceCode that still returned the JWT would be a leak.
      const afterConsume = await repo.findByDeviceCode(dc('f1'));
      expect(afterConsume?.status).toBe(DeviceCodeStatus.Consumed);
      expect(afterConsume?.jwt).toBeNull();
    });

    it('consume on already-consumed row returns null (single-use enforced)', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('g1'),
        userCode: uc('g'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.authorize({
        userCode: uc('g'),
        userId: 'u1',
        jwt: 'jwt-g1',
        scope: ['mcp.read.*'],
        now,
      });
      const first = await repo.consume(dc('g1'), now);
      expect(first?.jwt).toBe('jwt-g1');

      const second = await repo.consume(dc('g1'), now);
      expect(second).toBeNull();
    });

    it('authorize on expired row returns null (server-side expiry guard fires)', async () => {
      const now = new Date();
      // Insert with expiresAt in the past so the WHERE expires_at > now
      // predicate filters it out without sweepExpired being called.
      const past = new Date(now.getTime() - 60_000);
      await repo.issue({
        deviceCode: dc('h1'),
        userCode: uc('h'),
        requesterMetadata: meta,
        expiresAt: past,
        now,
      });
      const result = await repo.authorize({
        userCode: uc('h'),
        userId: 'u1',
        jwt: 'jwt-h1',
        scope: ['mcp.read.*'],
        now,
      });
      expect(result).toBeNull();
    });
  });

  describe('deny path', () => {
    it('flips pending → denied + records reason', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('i1'),
        userCode: uc('i'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      const denied = await repo.deny({
        userCode: uc('i'),
        userId: 'u1',
        reason: 'wrong device',
        now,
      });
      expect(denied?.status).toBe(DeviceCodeStatus.Denied);
      expect(denied?.userId).toBe('u1');
      expect(denied?.denyReason).toBe('wrong device');
    });

    it('deny on already-denied row returns null (no double-deny)', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('j1'),
        userCode: uc('j'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.deny({ userCode: uc('j'), userId: 'u1', now });
      const second = await repo.deny({ userCode: uc('j'), userId: 'u1', now });
      expect(second).toBeNull();
    });

    it('deny on already-authorized row returns null (terminal state respected)', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('k1'),
        userCode: uc('k'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.authorize({
        userCode: uc('k'),
        userId: 'u1',
        jwt: 'jwt-k1',
        scope: ['mcp.read.*'],
        now,
      });
      const denied = await repo.deny({ userCode: uc('k'), userId: 'u1', now });
      expect(denied).toBeNull();
    });
  });

  describe('sweepExpired', () => {
    it('flips pending past expiry → expired and clears jwt column', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60_000);
      await repo.issue({
        deviceCode: dc('l1'),
        userCode: uc('l'),
        requesterMetadata: meta,
        expiresAt: past,
        now: past,
      });
      const swept = await repo.sweepExpired(now);
      expect(swept).toBe(1);
      const after = await repo.findByDeviceCode(dc('l1'));
      expect(after?.status).toBe(DeviceCodeStatus.Expired);
      expect(after?.jwt).toBeNull();
    });

    it('flips authorized past expiry → expired and CLEARS the JWT (auth grant must not survive)', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 1_000);
      await repo.issue({
        deviceCode: dc('m1'),
        userCode: uc('m'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.authorize({
        userCode: uc('m'),
        userId: 'u1',
        jwt: 'jwt-m-leaked-if-not-cleared',
        scope: ['mcp.read.*'],
        now,
      });

      // Advance clock past expiresAt and sweep.
      const future = new Date(expiresAt.getTime() + 1_000);
      const swept = await repo.sweepExpired(future);
      expect(swept).toBe(1);
      const after = await repo.findByDeviceCode(dc('m1'));
      expect(after?.status).toBe(DeviceCodeStatus.Expired);
      // Critical leak guard — sweepExpired MUST clear jwt:null.
      expect(after?.jwt).toBeNull();
    });

    it('does NOT touch denied / consumed / expired rows', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);

      // denied row, expired clock — should remain denied
      await repo.issue({
        deviceCode: dc('n1'),
        userCode: uc('n1'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.deny({ userCode: uc('n1'), userId: 'u1', now });

      // consumed row, expired clock — should remain consumed
      await repo.issue({
        deviceCode: dc('n2'),
        userCode: uc('n2'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      await repo.authorize({
        userCode: uc('n2'),
        userId: 'u1',
        jwt: 'jwt-n2',
        scope: ['mcp.read.*'],
        now,
      });
      await repo.consume(dc('n2'), now);

      const future = new Date(now.getTime() + 1_000_000);
      await repo.sweepExpired(future);

      const denied = await repo.findByDeviceCode(dc('n1'));
      expect(denied?.status).toBe(DeviceCodeStatus.Denied);
      const consumed = await repo.findByDeviceCode(dc('n2'));
      expect(consumed?.status).toBe(DeviceCodeStatus.Consumed);
      // Both are terminal — sweepExpired returns 0 incremental flips
      // because no in-flight rows remain.
    });

    it('returns 0 when nothing to sweep', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('o1'),
        userCode: uc('o'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      const swept = await repo.sweepExpired(now);
      expect(swept).toBe(0);
    });
  });

  describe('userId FK onDelete: set null', () => {
    it('row survives a hypothetical user delete with userId set to null', async () => {
      // We don't have a user row to FK against here (the test only
      // exercises the device-code table), but the schema declares
      // `onDelete: 'set null'` so we sanity-check that null is a
      // valid user_id state. A regression from `set null` → `cascade`
      // would silently drop audit-relevant rows when an account is
      // deleted.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await repo.issue({
        deviceCode: dc('p1'),
        userCode: uc('p'),
        requesterMetadata: meta,
        expiresAt,
        now,
      });
      // Direct UPDATE to mimic the post-cascade state.
      await db.execute(sql`UPDATE agent_device_codes SET user_id = NULL WHERE device_code = ${dc('p1')}`);
      const after = await repo.findByDeviceCode(dc('p1'));
      expect(after?.userId).toBeNull();
    });
  });
});
