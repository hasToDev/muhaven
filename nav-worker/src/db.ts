/**
 * Database connection — singleton Pool + Drizzle instance.
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { getConfig } from './config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (db) return db;

  const config = getConfig();
  pool = new Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema });

  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    const d = getDb();
    await d.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
