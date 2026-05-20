import { describe, it, expect, vi } from 'vitest';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import {
  acquireAdvisoryLock,
  acquireTickLock,
  acquireTokenLock,
  ADVISORY_LOCK_NAMESPACE,
  PgAdvisoryLockHandle,
  YIELD_CRON_TICK_KEY,
} from '../pg-advisory-lock-handle.js';
import type { Pool, PoolClient } from 'pg';

function makeMockClient(): {
  client: PoolClient;
  queryMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
} {
  const queryMock = vi.fn();
  const releaseMock = vi.fn();
  const client = {
    query: queryMock,
    release: releaseMock,
  } as unknown as PoolClient;
  return { client, queryMock, releaseMock };
}

function makeMockPool(client: PoolClient): {
  pool: Pool;
  connectMock: ReturnType<typeof vi.fn>;
} {
  const connectMock = vi.fn().mockResolvedValue(client);
  const pool = { connect: connectMock } as unknown as Pool;
  return { pool, connectMock };
}

describe('acquireAdvisoryLock', () => {
  it('returns a handle when pg_try_advisory_lock returns true', async () => {
    const { client, queryMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] });
    const { pool } = makeMockPool(client);

    const handle = await acquireAdvisoryLock(pool, 'ns', 'k');
    expect(handle).toBeInstanceOf(PgAdvisoryLockHandle);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock(hashtextextended($1, $2))'),
      ['ns', 'k'],
    );
  });

  it('returns null + releases the client when the lock is contended', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] });
    const { pool } = makeMockPool(client);

    const handle = await acquireAdvisoryLock(pool, 'ns', 'k');
    expect(handle).toBeNull();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('returns null + releases when pg returns malformed response (defensive)', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { pool } = makeMockPool(client);

    const handle = await acquireAdvisoryLock(pool, 'ns', 'k');
    expect(handle).toBeNull();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('re-throws + releases client when the acquire query throws', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockRejectedValueOnce(new Error('connection_refused'));
    const { pool } = makeMockPool(client);

    await expect(acquireAdvisoryLock(pool, 'ns', 'k')).rejects.toThrow('connection_refused');
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});

describe('PgAdvisoryLockHandle.release', () => {
  it('runs pg_advisory_unlock + returns client to pool', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const handle = new PgAdvisoryLockHandle({ client, namespace: 'ns', key: 'k' });

    await handle.release();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock(hashtextextended($1, $2))'),
      ['ns', 'k'],
    );
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('is idempotent — second release is a structured no-op', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const handle = new PgAdvisoryLockHandle({ client, namespace: 'ns', key: 'k' });

    await handle.release();
    await handle.release();
    await handle.release();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when pg_advisory_unlock returns false (orphan reclaim case)', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: false }] });
    const handle = new PgAdvisoryLockHandle({ client, namespace: 'ns', key: 'k' });

    await expect(handle.release()).resolves.toBeUndefined();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('never throws when the unlock query rejects — still returns client', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockRejectedValueOnce(new Error('connection_lost'));
    const handle = new PgAdvisoryLockHandle({ client, namespace: 'ns', key: 'k' });

    await expect(handle.release()).resolves.toBeUndefined();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('never throws when client.release() itself throws (pool reaper handles it)', async () => {
    const { client, queryMock, releaseMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    releaseMock.mockImplementationOnce(() => {
      throw new Error('client_in_undefined_state');
    });
    const handle = new PgAdvisoryLockHandle({ client, namespace: 'ns', key: 'k' });

    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe('namespace helpers', () => {
  it('acquireTickLock uses the fixed tick namespace + key', async () => {
    const { client, queryMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] });
    const { pool } = makeMockPool(client);

    await acquireTickLock(pool);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      ADVISORY_LOCK_NAMESPACE.yieldCronTick,
      YIELD_CRON_TICK_KEY,
    ]);
  });

  it('acquireTokenLock lower-cases the address at the boundary', async () => {
    const { client, queryMock } = makeMockClient();
    queryMock.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] });
    const { pool } = makeMockPool(client);

    await acquireTokenLock(pool, '0xAbCdEf0000000000000000000000000000000001');
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      ADVISORY_LOCK_NAMESPACE.yieldTokenEpoch,
      '0xabcdef0000000000000000000000000000000001',
    ]);
  });
});
