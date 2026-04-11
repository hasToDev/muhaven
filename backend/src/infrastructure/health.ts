import { getEnv } from '../core/config.js';
import { getDb } from './repository/postgres/db.js';
import { sql } from 'drizzle-orm';

interface DependencyStatus {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  postgres: DependencyStatus;
  fheWorker: DependencyStatus;
  navWorker: DependencyStatus;
}

async function checkPostgres(): Promise<DependencyStatus> {
  const env = getEnv();
  if (env.DB_PROVIDER !== 'postgres') {
    return { healthy: true, latencyMs: 0 };
  }

  const start = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

async function checkService(url: string): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { healthy: res.ok, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

export async function getHealthStatus(): Promise<HealthResponse> {
  const env = getEnv();

  const [postgres, fheWorker, navWorker] = await Promise.all([
    checkPostgres(),
    checkService(`${env.FHE_WORKER_URL}/health/ready`),
    checkService(`${env.NAV_WORKER_URL}/health`),
  ]);

  const allHealthy = postgres.healthy && fheWorker.healthy && navWorker.healthy;

  return {
    status: allHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    postgres,
    fheWorker,
    navWorker,
  };
}
