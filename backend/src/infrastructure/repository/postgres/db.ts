import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { getEnv } from '../../../core/config.js';

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | null = null;

export function getDb(): Db {
  if (!_db) {
    const url = getEnv().DATABASE_URL;
    if (!url)
      throw new Error('DATABASE_URL is required when DB_PROVIDER is postgres');
    const pool = new Pool({ connectionString: url });
    _db = drizzle(pool, { schema });
  }
  return _db;
}
