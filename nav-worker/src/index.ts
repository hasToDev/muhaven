/**
 * NAV Worker entry point.
 *
 * 1. Connects to Postgres
 * 2. Runs backfill (if token_nav_history is empty for any token)
 * 3. Runs immediate fetch cycle
 * 4. Starts interval-based scheduler
 * 5. Serves /health endpoint
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getConfig } from './config.js';
import { checkDbHealth, closeDb } from './db.js';
import { runBackfill } from './backfill.js';
import { startScheduler, stopScheduler, getSchedulerStatus } from './scheduler.js';

let ready = false;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function startup(): Promise<void> {
  console.log('[nav-worker] Starting up...');

  // Verify DB connection
  const dbOk = await checkDbHealth();
  if (!dbOk) {
    console.error('[nav-worker] Cannot connect to Postgres — retrying in 5s...');
    await new Promise((r) => setTimeout(r, 5_000));
    const retryOk = await checkDbHealth();
    if (!retryOk) {
      console.error('[nav-worker] Postgres still unavailable — starting anyway, scheduler will retry');
    }
  }

  // Backfill historical data for tokens with no history
  try {
    await runBackfill();
  } catch (err) {
    console.error('[nav-worker] Backfill failed (non-fatal):', err);
  }

  // Start the fetch scheduler
  const config = getConfig();
  startScheduler(config.fetchIntervalMs);

  ready = true;
  console.log('[nav-worker] Ready.');
}

const config = getConfig();
const port = config.port;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    const scheduler = getSchedulerStatus();
    const dbHealthy = await checkDbHealth();

    sendJson(res, 200, {
      status: ready && dbHealthy ? 'ok' : 'degraded',
      ready,
      database: dbHealthy,
      scheduler: {
        running: scheduler.running,
        lastFetchAt: scheduler.lastFetchAt,
        lastResult: scheduler.lastResult,
      },
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`NAV worker running at http://localhost:${port}`);
  console.log('Endpoints:');
  console.log('  GET  /health');
});

// Start background initialization
startup().catch((err) => {
  console.error('[nav-worker] Startup failed:', err);
});

// Graceful shutdown
function shutdown() {
  console.log('[nav-worker] Shutting down...');
  stopScheduler();
  closeDb()
    .catch((err) => console.warn('[nav-worker] DB close error (non-fatal):', err))
    .finally(() => {
      server.close();
      process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
