/**
 * Real-Postgres integration test for the scoped-session mirror table
 * (Wave 5 Path D Slice 2 Commit 2.A).
 *
 * Gates Drizzle-declared CHECK constraints + the partial active index +
 * jsonb round-trip — none of these survive a mocked-driver test.
 * Per memory `[[feedback_sql_bugs_need_real_pg_integration_test]]`
 * codified after the Q3 step 4 advisory-lock SQL syntax bug (which 5
 * reviewers + 11 mocked unit tests missed but a single real-Pg test
 * would have caught).
 *
 * Gates on `INTEGRATION_PG_URL` / `DATABASE_URL`. CI sets the env;
 * developer machines without Postgres run vitest's `describe.skip`
 * fallback so `pnpm test` stays green.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { PgScopedSessionRepository } from '../pg-scoped-session.repository.js';
import { agentScopedSessions, agentUserState, users } from '../schema.js';
import { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';

const PG_URL = process.env.INTEGRATION_PG_URL ?? process.env.DATABASE_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const NOW = new Date('2026-05-22T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

// User IDs are namespaced to this test suite. Vitest runs integration
// test files in parallel against a shared CI Pg instance; the sibling
// `pg-agent-device-code.integration.test.ts` also inserts a `'u1'`
// users row. Without namespacing, both suites race on the same PK and
// the loser 23505s — which is exactly what failed CI on commit 9cbef56.
// Per-suite namespacing keeps each test's users-table footprint disjoint.
const U1 = 'scoped-session-u1';
const U2 = 'scoped-session-u2';

function makeSession(overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {}): ScopedSession {
  return new ScopedSession({
    sessionId: 'session-base-001',
    userId: U1,
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0xaaaa000000000000000000000000000000000001',
    permissionId: null,
    targetContracts: ['0xbbbb000000000000000000000000000000000002'],
    selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1000000' }],
    maxPerOpUsd6: 100_000_000n,
    totalSpentUsd6: 0n,
    validUntilSec: NOW_SEC + 4 * 3600,
    mintedAtSec: NOW_SEC,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    ...overrides,
  });
}

describeIfPg('PgScopedSessionRepository (real postgres)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PgScopedSessionRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool, { schema });
    repo = new PgScopedSessionRepository(db);
    await db.execute(sql`SELECT 1 FROM ${agentScopedSessions} LIMIT 0`).catch((err) => {
      throw new Error(
        `agent_scoped_sessions missing — run \`bash scripts/db-push-homelab.sh <env>\` or local \`pnpm db:push\` against ${PG_URL} first.\n${err}`,
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // CI runs integration test files in PARALLEL against a shared Pg
    // instance. `TRUNCATE users CASCADE` from this suite would race
    // with the sibling `pg-agent-device-code` suite (also resets users),
    // wiping each other's rows mid-test. Targeted DELETE that only
    // touches this suite's footprint is concurrency-safe — each suite
    // owns its own user namespace and resets only its own rows.
    //
    // FK CASCADE behavior: `agent_scoped_sessions.user_id` is
    // `onDelete: 'set null'`, so DELETE FROM users nulls the userId in
    // any stranded scoped-session rows but doesn't cascade-delete them.
    // We explicitly delete child rows first via the per-suite namespace
    // (sessionId pattern is fully suite-local). `agent_user_state`
    // uses NO ACTION by default — its rows must be deleted explicitly
    // before the users delete can succeed.
    await db.execute(
      sql`DELETE FROM ${agentScopedSessions} WHERE user_id IN (${U1}, ${U2}) OR user_id IS NULL`,
    );
    await db.execute(
      sql`DELETE FROM ${agentUserState} WHERE user_id IN (${U1}, ${U2})`,
    );
    await db.execute(sql`DELETE FROM ${users} WHERE id IN (${U1}, ${U2})`);
    // Wallet addresses chosen in the `0x...01xx` range to stay disjoint
    // from the device-code suite's `0x...0001`/`0x...0002` reservations.
    // Both are also UNIQUE constraints — parallel suites that pick
    // overlapping wallet addresses would 23505 each other on insert.
    await db.insert(users).values([
      {
        id: U1,
        walletAddress: '0x0000000000000000000000000000000000000101',
        walletProvider: 'zerodev',
        role: 'investor',
      },
      {
        id: U2,
        walletAddress: '0x0000000000000000000000000000000000000102',
        walletProvider: 'zerodev',
        role: 'investor',
      },
    ]);
  });

  describe('create + findById', () => {
    it('roundtrips an active session', async () => {
      const session = makeSession();
      await repo.create(session);
      const loaded = await repo.findById(session.sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded?.sessionId).toBe(session.sessionId);
      expect(loaded?.signerAddress).toBe(session.signerAddress);
      expect(loaded?.maxPerOpUsd6).toBe(100_000_000n);
      expect(loaded?.totalSpentUsd6).toBe(0n);
      expect(loaded?.validUntilSec).toBe(session.validUntilSec);
      expect(loaded?.targetContracts).toEqual(session.targetContracts);
      expect(loaded?.selectorCaps).toEqual(session.selectorCaps);
      expect(loaded?.status).toBe(ScopedSessionStatus.Active);
    });

    it('persists optional consent hashes', async () => {
      const session = makeSession({
        consentActionHash: '0x' + 'a'.repeat(64) as `0x${string}`,
        consentTextSha256: '0x' + 'b'.repeat(64) as `0x${string}`,
      });
      await repo.create(session);
      const loaded = await repo.findById(session.sessionId);
      expect(loaded?.consentActionHash).toBe('0x' + 'a'.repeat(64));
      expect(loaded?.consentTextSha256).toBe('0x' + 'b'.repeat(64));
    });

    it('persists optional permissionId when present', async () => {
      const session = makeSession({ permissionId: '0xdeadbeef' });
      await repo.create(session);
      const loaded = await repo.findById(session.sessionId);
      expect(loaded?.permissionId).toBe('0xdeadbeef');
    });

    it('returns null on findById for unknown id', async () => {
      expect(await repo.findById('session-unknown')).toBeNull();
    });

    it('throws PG 23505 (unique violation) on duplicate sessionId', async () => {
      const session = makeSession();
      await repo.create(session);
      await expect(repo.create(makeSession())).rejects.toMatchObject({
        code: '23505',
      });
    });

    // CHECK constraint coverage — these prove the schema's last-line-of-
    // defense fires when the wire/use-case layers are bypassed. Per memory
    // `feedback_sql_bugs_need_real_pg_integration_test`. The cases below
    // table-drive every CHECK clause so a future drift in any constraint
    // (or accidental drop during a schema edit) is caught by ≥1 failing
    // case.
    const CHECK_VIOLATION_CASES: Array<{
      label: string;
      override: Partial<Parameters<typeof db.insert<typeof agentScopedSessions>>[0]['$inferInsert']>;
    }> = [
      // session_id_chk — character-class branch (disallowed char)
      { label: 'malformed session_id (space)', override: { sessionId: 'has spaces' } },
      // session_id_chk — length-bound branch (>128 chars per regex `{1,128}`).
      // Catches a future fat-finger where the bound is widened.
      {
        label: 'session_id exceeds 128 chars',
        override: { sessionId: 'a'.repeat(129) },
      },
      // signer_address_chk — uppercase (lowercased-only)
      {
        label: 'uppercase signer_address',
        override: { signerAddress: '0xAAAA000000000000000000000000000000000001' },
      },
      // permission_id_chk — wrong byte length
      { label: 'short permission_id', override: { permissionId: '0xdead' } },
      // consent_action_hash_chk — wrong length
      {
        label: 'short consent_action_hash',
        override: { consentActionHash: '0xdeadbeef' },
      },
      // consent_text_sha256_chk — uppercase hex
      {
        label: 'uppercase consent_text_sha256',
        override: {
          consentTextSha256: '0x' + 'A'.repeat(64),
        },
      },
      // max_per_op_usd6_chk — negative
      { label: 'negative max_per_op_usd6', override: { maxPerOpUsd6: '-1' } },
      // total_spent_usd6_chk — negative
      { label: 'negative total_spent_usd6', override: { totalSpentUsd6: '-1' } },
      // valid_until_sec_chk — zero
      { label: 'zero valid_until_sec', override: { validUntilSec: 0 } },
      // minted_at_sec_chk — zero
      { label: 'zero minted_at_sec', override: { mintedAtSec: 0 } },
    ];

    it.each(CHECK_VIOLATION_CASES)(
      'CHECK constraint rejects $label with Pg 23514',
      async ({ override }) => {
        // Bypass the repo's create + go straight to raw insert so the
        // CHECK is the only gate. Repo's create is type-safe; this
        // proves the last-line-of-defense in the DB schema.
        await expect(
          db.insert(agentScopedSessions).values({
            sessionId: `session-check-${Math.random().toString(36).slice(2, 10)}`,
            userId: U1,
            surface: 'mcp',
            status: 'active',
            signerAddress: '0xaaaa000000000000000000000000000000000001',
            permissionId: null,
            targetContracts: ['0xbbbb000000000000000000000000000000000002'],
            selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1000000' }],
            maxPerOpUsd6: '100',
            totalSpentUsd6: '0',
            validUntilSec: 2_000_000_000,
            mintedAtSec: 1_000_000_000,
            consentActionHash: null,
            consentTextSha256: null,
            mintedAt: NOW,
            revokedAt: null,
            expiredAt: null,
            ...override,
          }),
        ).rejects.toMatchObject({ code: '23514' });
      },
    );
  });

  describe('findLatestActive', () => {
    it('returns the row matching (user, surface, status=active, validUntil > now)', async () => {
      await repo.create(makeSession());
      const result = await repo.findLatestActive(U1, Surface.MCP, NOW_SEC);
      expect(result?.sessionId).toBe('session-base-001');
    });

    it('returns null when validUntilSec <= nowSec (server-side filter)', async () => {
      await repo.create(makeSession({ validUntilSec: NOW_SEC }));
      expect(await repo.findLatestActive(U1, Surface.MCP, NOW_SEC)).toBeNull();
    });

    it('returns null when status != active', async () => {
      await repo.create(
        makeSession({ status: ScopedSessionStatus.Revoked, revokedAt: NOW }),
      );
      expect(await repo.findLatestActive(U1, Surface.MCP, NOW_SEC)).toBeNull();
    });

    it('does not cross users', async () => {
      await repo.create(makeSession({ userId: U2 }));
      expect(await repo.findLatestActive(U1, Surface.MCP, NOW_SEC)).toBeNull();
    });

    it('does not cross surfaces', async () => {
      await repo.create(makeSession({ surface: Surface.HavenBot }));
      expect(await repo.findLatestActive(U1, Surface.MCP, NOW_SEC)).toBeNull();
    });

    it('partial UNIQUE index rejects a SECOND active row for (user, surface) with Pg 23505', async () => {
      // Per CR-H1 (round 1) + Reality-check round 2 (fresh CR HIGH-1):
      // the UNIQUE columns MUST cover only `(user_id, surface)` under
      // the `WHERE status='active'` partial predicate. If the unique
      // tuple included `valid_until_sec` or `minted_at`, two racing
      // mints with even slightly-different timestamps would BOTH land
      // (the 4-tuple miss-match defeats uniqueness). Vary timestamps
      // BETWEEN the two creates so the test exercises the real race
      // shape, not a trivial fixture-collision identity case.
      await repo.create(
        makeSession({
          sessionId: 'session-first',
          validUntilSec: NOW_SEC + 3600,
          mintedAt: NOW,
        }),
      );
      await expect(
        repo.create(
          makeSession({
            sessionId: 'session-second',
            validUntilSec: NOW_SEC + 7200, // distinct expiry
            mintedAt: new Date(NOW.getTime() + 500), // distinct mintedAt
          }),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('partial UNIQUE does NOT block a fresh mint after the prior is revoked', async () => {
      // The partial predicate is `WHERE status='active'`. Once the
      // prior row flips to 'revoked', the partial index drops it and
      // a new (userId, surface, status='active') row is acceptable.
      // Same load-bearing semantic as the agent_device_codes
      // partial-unique pattern (mirror precedent).
      await repo.create(makeSession({ sessionId: 'session-first' }));
      await repo.revoke('session-first', NOW);
      await expect(
        repo.create(makeSession({ sessionId: 'session-fresh' })),
      ).resolves.toBeUndefined();
    });

    it('partial UNIQUE permits parallel rows across distinct surfaces (same user)', async () => {
      // Sanity: the uniqueness is over (user_id, surface) — havenbot and
      // mcp are distinct surfaces, so both can hold an active row.
      await repo.create(
        makeSession({ sessionId: 'session-mcp', surface: Surface.MCP }),
      );
      await expect(
        repo.create(
          makeSession({ sessionId: 'session-havenbot', surface: Surface.HavenBot }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('happy path — flips active → revoked + sets revokedAt', async () => {
      await repo.create(makeSession());
      const result = await repo.revoke('session-base-001', NOW);
      expect(result?.status).toBe(ScopedSessionStatus.Revoked);
      expect(result?.revokedAt).toEqual(NOW);
      // Persistence
      const reloaded = await repo.findById('session-base-001');
      expect(reloaded?.status).toBe(ScopedSessionStatus.Revoked);
    });

    it('returns null when sessionId does not exist', async () => {
      expect(await repo.revoke('session-unknown', NOW)).toBeNull();
    });

    it('returns null on double-revoke (terminal row resistant via WHERE)', async () => {
      await repo.create(makeSession());
      await repo.revoke('session-base-001', NOW);
      expect(await repo.revoke('session-base-001', NOW)).toBeNull();
    });

    it('races against another revoke — exactly one returns the row, the other returns null', async () => {
      await repo.create(makeSession());
      const [a, b] = await Promise.all([
        repo.revoke('session-base-001', NOW),
        repo.revoke('session-base-001', NOW),
      ]);
      const successes = [a, b].filter((v) => v !== null);
      expect(successes).toHaveLength(1);
    });
  });

  describe('markExpired', () => {
    it('bulk-flips active rows whose validUntilSec <= beforeSec', async () => {
      // Two active rows would collide under the partial UNIQUE if same
      // (user, surface) — spread across surfaces to stay within the
      // mirror's "one active per (user, surface)" invariant while
      // exercising the cron's bulk-flip path.
      await repo.create(
        makeSession({
          sessionId: 'session-past',
          surface: Surface.MCP,
          validUntilSec: NOW_SEC - 10,
        }),
      );
      await repo.create(
        makeSession({
          sessionId: 'session-current',
          surface: Surface.HavenBot,
          validUntilSec: NOW_SEC + 3600,
        }),
      );
      const flipped = await repo.markExpired(NOW_SEC, NOW);
      expect(flipped).toBe(1);
      expect((await repo.findById('session-past'))?.status).toBe(
        ScopedSessionStatus.Expired,
      );
      expect((await repo.findById('session-current'))?.status).toBe(
        ScopedSessionStatus.Active,
      );
    });

    it('does NOT flip revoked rows (they are already terminal)', async () => {
      await repo.create(
        makeSession({
          status: ScopedSessionStatus.Revoked,
          revokedAt: NOW,
          validUntilSec: NOW_SEC - 10,
        }),
      );
      const flipped = await repo.markExpired(NOW_SEC, NOW);
      expect(flipped).toBe(0);
      const row = await repo.findById('session-base-001');
      expect(row?.status).toBe(ScopedSessionStatus.Revoked);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Wave 5 Option D · Commit 2 — pgcrypto encrypt-at-rest + install-
  // material lifecycle. These cover the only contract that can't be
  // exercised against the memory repo: the bytea/encryption round-trip,
  // the partial-index lookup, the lockstep CHECK, and the size
  // CHECK constraints.
  // ────────────────────────────────────────────────────────────────────

  describe('Option D · C2 install material — pgcrypto + lifecycle', () => {
    const ENABLE_DATA = `0x${'cd'.repeat(64)}`;
    // 256-hex floor (Option D · C2 SecEng H-3 downgrade defense).
    const ENABLE_SIG = `0x${'ab'.repeat(128)}`;
    const VALIDATOR_NONCE = 42;

    beforeAll(async () => {
      // CI self-sufficiency (fix: this block was red on the
      // `backend vitest (real postgres)` CI job since C2 — invisible
      // locally because the suite is `describe.skip` without a real PG).
      // The CI job sets only DATABASE_URL/INTEGRATION_PG_URL, so:
      //   (a) `getEnv()` — reached via `requireEncryptionKey()` on the
      //       pgcrypto write path — needs a JWT_SECRET to satisfy its
      //       schema (the encryption key alone isn't enough); and
      //   (b) the fresh test DB has no `pgcrypto` extension, so
      //       `pgp_sym_encrypt` doesn't exist.
      // Set both here so the integration suite provisions its own
      // prerequisites. `??=` avoids clobbering a JWT_SECRET the CI job
      // may set in future.
      process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
      // Test-suite encryption key. Distinct from any operator-facing
      // secret pattern so a future cross-secret regression in this
      // suite can't accidentally collide with a real prod env. The
      // 'f'.repeat(64) pattern doesn't collide with any of the
      // other operator secret slots either (they're 32-byte random
      // hex per ops convention).
      process.env.OPTION_D_C2_ENCRYPTION_KEY = 'f'.repeat(64);
      // Invalidate the env-singleton so the new key is observed by
      // subsequent `requireEncryptionKey()` calls. Multi-agent
      // review Codex M-5 absorbed (test-cache leak path).
      const { resetEnvCacheForTesting } = await import('../../../../core/config.js');
      resetEnvCacheForTesting();
      // pgcrypto is a TRUSTED extension on PG13+ — the DB owner (the CI
      // `muhaven` user owns `muhaven_test`) can create it without
      // superuser. Idempotent; runs before the "ensures pgcrypto is
      // loaded" prerequisite test below.
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    });

    it('ensures pgcrypto is loaded (test prerequisite)', async () => {
      // If pgcrypto isn't installed we should fail loud here with a
      // clear remediation message, not later inside an opaque SQL error.
      const result = await db.execute(
        sql`SELECT octet_length(pgp_sym_encrypt('ping', 'k')) > 0 AS ok`,
      );
      const rows = (result as unknown as { rows: Array<{ ok: boolean }> }).rows;
      expect(rows[0]?.ok).toBe(true);
    });

    it('encrypts enable_data + enable_sig at rest (raw bytea ≠ cleartext)', async () => {
      const session = makeSession({
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: VALIDATOR_NONCE,
      });
      await repo.create(session, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: VALIDATOR_NONCE,
      });

      // Raw SELECT bypassing repo decryption — the column MUST contain
      // pgcrypto-wrapped bytes, not the cleartext hex string. If a
      // future refactor accidentally writes cleartext, this test
      // captures the regression at the bytea boundary.
      const raw = await db.execute(sql`
        SELECT
          enable_data,
          enable_sig,
          octet_length(enable_data) AS data_size,
          octet_length(enable_sig) AS sig_size
        FROM agent_scoped_sessions
        WHERE session_id = ${session.sessionId}
      `);
      const rawRows = (raw as unknown as {
        rows: Array<{ enable_data: Buffer; enable_sig: Buffer; data_size: number; sig_size: number }>;
      }).rows;
      const row = rawRows[0]!;
      expect(row.enable_data).toBeInstanceOf(Buffer);
      expect(row.enable_sig).toBeInstanceOf(Buffer);
      // Bytes must NOT contain the cleartext hex (`cdcdcd...`).
      expect(row.enable_data.toString('utf8')).not.toContain('cdcdcd');
      expect(row.enable_sig.toString('utf8')).not.toContain('ababab');
      // Encrypted blob has a small overhead but stays under our CHECK
      // size ceilings (8192 / 4096 bytes).
      expect(row.data_size).toBeGreaterThan(0);
      expect(row.data_size).toBeLessThanOrEqual(8192);
      expect(row.sig_size).toBeGreaterThan(0);
      expect(row.sig_size).toBeLessThanOrEqual(4096);
    });

    it('decrypts back to cleartext via findInstallMaterialById', async () => {
      const session = makeSession({
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: VALIDATOR_NONCE,
      });
      await repo.create(session, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: VALIDATOR_NONCE,
      });

      const material = await repo.findInstallMaterialById(session.sessionId, U1);
      expect(material).not.toBeNull();
      expect(material?.enableData).toBe(ENABLE_DATA);
      expect(material?.enableSig).toBe(ENABLE_SIG);
      expect(material?.validatorNonce).toBe(VALIDATOR_NONCE);
      expect(material?.enableStatus).toBe('pending');
    });

    it('returns null from findInstallMaterialById on user mismatch (defense-in-depth ownership)', async () => {
      const session = makeSession({
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: VALIDATOR_NONCE,
      });
      await repo.create(session, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: VALIDATOR_NONCE,
      });
      // Other user owns nothing in this row.
      expect(await repo.findInstallMaterialById(session.sessionId, U2)).toBeNull();
    });

    it('default findById + findLatestActive do NOT carry enableData / enableSig (least-exposure read)', async () => {
      const session = makeSession({
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: VALIDATOR_NONCE,
      });
      await repo.create(session, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: VALIDATOR_NONCE,
      });
      const byId = await repo.findById(session.sessionId);
      expect(byId).not.toBeNull();
      // Public ScopedSession model has no enableData/enableSig fields.
      // Verify the lifecycle fields ARE on the model + the redacted
      // ones are NOT (structural check via in operator).
      expect(byId?.enableStatus).toBe('pending');
      expect(byId?.validatorNonce).toBe(VALIDATOR_NONCE);
      expect(byId && 'enableData' in (byId as object)).toBe(false);
      expect(byId && 'enableSig' in (byId as object)).toBe(false);

      const latest = await repo.findLatestActive(U1, Surface.MCP, NOW_SEC);
      expect(latest?.enableStatus).toBe('pending');
      expect(latest?.validatorNonce).toBe(VALIDATOR_NONCE);
    });

    it('accepts a mint WITHOUT install material — enable_status stays NULL (back-compat)', async () => {
      const session = makeSession();
      await repo.create(session);
      const loaded = await repo.findById(session.sessionId);
      expect(loaded?.enableStatus).toBeNull();
      expect(loaded?.validatorNonce).toBeNull();
    });

    it('validator_nonce CHECK rejects values > uint32 max', async () => {
      // Raw INSERT bypassing the use-case so the CHECK is the last line.
      await expect(
        db.insert(agentScopedSessions).values({
          sessionId: 'session-nonce-fail',
          userId: U1,
          surface: Surface.MCP,
          status: ScopedSessionStatus.Active,
          signerAddress: '0xaaaa000000000000000000000000000000000001',
          targetContracts: ['0xbbbb000000000000000000000000000000000002'],
          selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1' }],
          maxPerOpUsd6: '0',
          totalSpentUsd6: '0',
          validUntilSec: NOW_SEC + 3600,
          mintedAtSec: NOW_SEC,
          validatorNonce: 4_294_967_296, // uint32 max + 1
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('lockstep CHECK rejects (validator_enabled_at != NULL && enable_status != enabled)', async () => {
      // Hand-INSERT a row where validatorEnabledAt is non-null but
      // enable_status is 'pending' — the CHECK must reject. C3's
      // chain-indexer flip path won't hit this because it UPDATEs both
      // columns together; this test gates the schema invariant.
      await expect(
        db.insert(agentScopedSessions).values({
          sessionId: 'session-lockstep-fail',
          userId: U1,
          surface: Surface.MCP,
          status: ScopedSessionStatus.Active,
          signerAddress: '0xaaaa000000000000000000000000000000000001',
          targetContracts: ['0xbbbb000000000000000000000000000000000002'],
          selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1' }],
          maxPerOpUsd6: '0',
          totalSpentUsd6: '0',
          validUntilSec: NOW_SEC + 3600,
          mintedAtSec: NOW_SEC,
          enableStatus: 'pending',
          validatorEnabledAt: NOW,
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('validator_enabled_tx_hash CHECK rejects non-hex / uppercase / wrong-length values', async () => {
      // Spread across separate rows so each violation is independent.
      const cases: Array<{ label: string; txHash: string }> = [
        { label: 'uppercase hex', txHash: '0x' + 'A'.repeat(64) },
        { label: 'too short', txHash: '0xdeadbeef' },
        { label: 'missing 0x', txHash: 'a'.repeat(64) },
      ];
      let i = 0;
      for (const c of cases) {
        i += 1;
        await expect(
          db.insert(agentScopedSessions).values({
            sessionId: `session-txhash-fail-${i}`,
            userId: U1,
            surface: Surface.MCP,
            status: ScopedSessionStatus.Active,
            signerAddress: '0xaaaa000000000000000000000000000000000001',
            targetContracts: ['0xbbbb000000000000000000000000000000000002'],
            selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1' }],
            maxPerOpUsd6: '0',
            totalSpentUsd6: '0',
            validUntilSec: NOW_SEC + 3600,
            mintedAtSec: NOW_SEC,
            // For the "enabled" path the lockstep CHECK requires
            // validator_enabled_at non-null AND enable_status='enabled',
            // so the txhash CHECK is the only relevant failure path.
            enableStatus: 'enabled',
            validatorEnabledAt: NOW,
            validatorEnabledTxHash: c.txHash,
          }),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('partial pending-enable index returns ONLY rows where enable_status=pending AND status=active', async () => {
      // Insert two rows: one pending+active, one pending+revoked. The
      // partial index gates on BOTH predicates; an EXPLAIN over the
      // pending-active SELECT must use the index (we don't assert plan
      // shape here — just that the query returns the expected row set).
      const sessionPendingActive = makeSession({
        sessionId: 'session-pending-active',
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: 1,
      });
      await repo.create(sessionPendingActive, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: 1,
      });
      const sessionRevoked = makeSession({
        sessionId: 'session-pending-revoked',
        surface: Surface.HavenBot,
        permissionId: '0xdeadbeef',
        enableStatus: 'pending',
        validatorNonce: 2,
      });
      await repo.create(sessionRevoked, {
        enableData: ENABLE_DATA as `0x${string}`,
        enableSig: ENABLE_SIG as `0x${string}`,
        validatorNonce: 2,
      });
      await repo.revoke('session-pending-revoked', NOW);

      // Raw query mimicking the C3 chain-indexer's "find pending rows
      // older than threshold" predicate.
      const rows = await db.execute(sql`
        SELECT session_id
        FROM agent_scoped_sessions
        WHERE enable_status = 'pending' AND status = 'active'
        ORDER BY session_id
      `);
      const sessionIds = (rows as unknown as {
        rows: Array<{ session_id: string }>;
      }).rows.map((r) => r.session_id);
      expect(sessionIds).toEqual(['session-pending-active']);
    });
  });

  describe('FK lifecycle (onDelete: SET NULL)', () => {
    it('deleting the user nulls scoped_session.user_id; the row survives for audit-replay', async () => {
      // GDPR-style user deletion. Per DBO-H4 fix, FK is
      // `onDelete: 'set null'` so audit-replay survives. Verifies:
      //   1. Row survives `DELETE FROM users` (no FK violation block).
      //   2. user_id flips to NULL in the surviving row.
      //   3. findLatestActive no longer surfaces the orphaned row (the
      //      `eq(user_id, $)` predicate excludes NULL).
      await repo.create(makeSession({ sessionId: 'session-orphaned' }));
      await db.execute(sql`DELETE FROM ${users} WHERE id = ${U1}`);
      const orphaned = await repo.findById('session-orphaned');
      expect(orphaned).not.toBeNull();
      expect(orphaned!.userId).toBeNull();
      expect(orphaned!.maxPerOpUsd6).toBe(100_000_000n);
      // Active lookup excludes orphans
      const active = await repo.findLatestActive(U1, Surface.MCP, NOW_SEC);
      expect(active).toBeNull();
    });
  });
});
