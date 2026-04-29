/**
 * NAV publisher service entry point.
 *
 * 1. Validates env (config.ts throws on missing required keys)
 * 2. Connects to Postgres
 * 3. Verifies chain wiring (signer derived; oracle address parsed)
 * 4. Starts interval-based scheduler
 * 5. Serves /health endpoint with per-token status
 *
 * Crash-loud philosophy: any unhandled startup error exits non-zero so
 * the container restart policy (`unless-stopped`) catches it visibly,
 * rather than silently looping cycle after cycle on bad config.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getConfig } from './config.js';
import { checkDbHealth, closeDb } from './db.js';
import { getChain } from './chain.js';
import {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
} from './scheduler.js';
import { getStatusSnapshot, nearestStaleSec } from './publisher.js';

let ready = false;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function startup(): Promise<void> {
  console.log('[nav-publisher] starting up...');

  // Eagerly read config so missing required keys fail fast (loud).
  const config = getConfig();

  // Init the chain context — also derives signer address from the
  // private key, validating its shape before any cycle runs.
  const { account } = getChain();
  console.log(
    `[nav-publisher] signer=${account.address} chainId=${config.chainId} oracle=${config.oracleAddress}`,
  );

  // Verify DB connection.
  const dbOk = await checkDbHealth();
  if (!dbOk) {
    console.warn('[nav-publisher] cannot reach Postgres yet — retrying in 5s...');
    await new Promise((r) => setTimeout(r, 5_000));
    const retryOk = await checkDbHealth();
    if (!retryOk) {
      console.warn(
        '[nav-publisher] Postgres still unavailable — starting anyway, scheduler will retry per cycle',
      );
    }
  }

  startScheduler(config.publishIntervalMs);
  ready = true;
  console.log('[nav-publisher] ready.');
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
    const sched = getSchedulerStatus();
    const dbHealthy = await checkDbHealth();
    const tokens = getStatusSnapshot();
    const nextStale = nearestStaleSec();

    const errored = tokens.some((t) => t.lastOutcome === 'error');
    const allFresh = tokens.length > 0 && tokens.every((t) => t.onChainIsFresh === true);

    let status: 'ok' | 'degraded';
    if (!ready || !dbHealthy || errored) status = 'degraded';
    else if (tokens.length === 0) status = 'degraded'; // no cycle has run yet
    else if (!allFresh) status = 'degraded';
    else status = 'ok';

    sendJson(res, 200, {
      status,
      ready,
      database: dbHealthy,
      scheduler: {
        running: sched.running,
        cycleInFlight: sched.cycleInFlight,
        lastCycleAt: sched.lastCycleAt,
        lastResult: sched.lastResult,
      },
      signer: getChain().account.address,
      oracle: config.oracleAddress,
      chainId: config.chainId,
      defaultStrategy: config.defaultStrategy,
      nearestStaleSec: nextStale,
      tokens: tokens.map((t) => ({
        token: t.token,
        label: t.label,
        strategy: t.strategy,
        onChainNav: t.onChainNav,
        onChainUpdatedAt: t.onChainUpdatedAt,
        onChainIsFresh: t.onChainIsFresh,
        nextStaleAt: t.nextStaleAt,
        dbLatestFetchedAt: t.dbLatestFetchedAt,
        lastSubmitAt: t.lastSubmitAt,
        lastSubmitTx: t.lastSubmitTx,
        lastOutcome: t.lastOutcome,
        lastError: t.lastError,
      })),
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`NAV publisher running at http://localhost:${port}`);
  console.log('Endpoints:');
  console.log('  GET  /health');
});

startup().catch((err) => {
  console.error('[nav-publisher] startup failed:', err);
  // Exit so the container restart policy surfaces the error rather
  // than silently running an unconfigured loop.
  process.exit(1);
});

function shutdown() {
  console.log('[nav-publisher] shutting down...');
  stopScheduler();
  closeDb()
    .catch((err) => console.warn('[nav-publisher] DB close error (non-fatal):', err))
    .finally(() => {
      server.close();
      process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
