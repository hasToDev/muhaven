import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { getEnv } from '../../../core/config.js';

export type Db = NodePgDatabase<typeof schema>;

let _pool: Pool | null = null;
let _db: Db | null = null;

function initPoolAndDb(): { pool: Pool; db: Db } {
  if (_pool && _db) return { pool: _pool, db: _db };
  const url = getEnv().DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL is required when DB_PROVIDER is postgres');
  // Pool sizing — `node-postgres` defaults to `max: 10` which is too
  // tight for the Wave 5 oracle marketplace render (one page-view
  // fires ~33 parallel requests across 11 tokens × 3 endpoints; at
  // pool=10, 23 of those queue and P95 latency degrades visibly).
  // 25 is comfortable headroom for the demo-scale single-replica
  // backend; pair with explicit timeouts so a stuck client doesn't
  // wedge a connection forever.
  //
  // Postgres-side: stage + prod run with default `max_connections`
  // (100). 25 × 1 backend replica is well under, with margin for the
  // indexer + nav-worker + fhe-worker that share the cluster.
  _pool = new Pool({
    connectionString: url,
    max: 25,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _db = drizzle(_pool, { schema });
  return { pool: _pool, db: _db };
}

export function getDb(): Db {
  return initPoolAndDb().db;
}

/**
 * Wave 5 Q3 (step 4) — direct `Pool` accessor for the daily yield cron.
 * Postgres advisory locks are session-scoped: `pg_try_advisory_lock`
 * and `pg_advisory_unlock` MUST run on the same `PoolClient`. Drizzle
 * pulls a fresh client per `db.execute(...)` call, so the cron's
 * advisory-lock helpers bypass drizzle and `pool.connect()` directly.
 *
 * Returns the SAME underlying `Pool` as `getDb()` so the lock helpers
 * share connection accounting with the rest of the backend.
 */
export function getPool(): Pool {
  return initPoolAndDb().pool;
}
