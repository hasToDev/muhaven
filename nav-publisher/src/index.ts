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
import { getConfig, applyDiscoveredTokens } from './config.js';
import { checkDbHealth, closeDb } from './db.js';
import { getChain, discoverActiveTokens } from './chain.js';
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
    `[nav-publisher] signer=${account.address} chainId=${config.chainId} oracle=${config.oracleAddress} registry=${config.tokenRegistryAddress}`,
  );

  // Design A (2026-05-17): discover active tokens from TokenRegistry
  // unless NAV_PUBLISH_TOKENS override is set. Logs which roster source
  // won so the operator can sanity-check at boot.
  //
  // Skipped entirely in override mode (NAV_PUBLISH_TOKENS set) — the
  // registry address may not even be configured in that case (existing
  // prod operators don't have to touch their .env).
  if (config.tokens.length === 0) {
    try {
      const discovered = await discoverActiveTokens();
      const { applied } = applyDiscoveredTokens(discovered);
      console.log(
        `[nav-publisher] discovered ${applied} active tokens from TokenRegistry: ${discovered
          .map((t) => t.symbol ?? t.address.slice(0, 10))
          .join(', ')}`,
      );
    } catch (err) {
      // Bootstrap-time discovery failures shouldn't crash the service —
      // a transient RPC blip would otherwise turn into a restart loop.
      // Cycle-time errors are handled per-token by the publisher.
      console.error(
        '[nav-publisher] TokenRegistry enumeration FAILED at startup. Publisher will start with empty roster — set NAV_PUBLISH_TOKENS env to recover.',
        err,
      );
    }
  } else {
    console.log(
      `[nav-publisher] NAV_PUBLISH_TOKENS override in effect (${config.tokens.length} tokens). Skipping TokenRegistry enumeration.`,
    );
  }
  if (config.tokens.length === 0) {
    console.warn(
      '[nav-publisher] roster is empty — no tokens will be published this cycle. Check TOKEN_REGISTRY_ADDRESS + RPC connectivity.',
    );
  }

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

    // Skip tokens with strategy='skip' from the aggregate health calc —
    // we explicitly opted out of managing them, so their freshness is
    // not our concern. Same for `error` (we don't reach the chain on
    // skipped tokens, so 'error' is unreachable, but be defensive).
    const managed = tokens.filter((t) => t.strategy !== 'skip');
    const errored = managed.some((t) => t.lastOutcome === 'error');
    const allFresh = managed.length > 0 && managed.every((t) => t.onChainIsFresh === true);

    let status: 'ok' | 'degraded';
    if (!ready || !dbHealthy || errored) status = 'degraded';
    else if (tokens.length === 0) status = 'degraded'; // no cycle has run yet
    else if (managed.length === 0) status = 'ok'; // every token explicitly skipped — operator's choice
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
