import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHealthStatus } from './infrastructure/health.js';
import { getEnv } from './core/config.js';
import {
  BlockchainEventPoller,
  CheckoutSettlementIndexer,
  NavWriterCron,
  PermissionInstalledIndexer,
  TaxEventIndexer,
  ValidatorEnableWatchdog,
  YieldDistributionCron,
} from './infrastructure/blockchain/index.js';
import { MarkScopedSessionValidatorEnabledUseCase } from './application/use-case/agent/policy/mark-scoped-session-validator-enabled.use-case.js';
import { getDb, getPool } from './infrastructure/repository/postgres/db.js';
import { ensurePgcryptoExtension } from './infrastructure/repository/postgres/pgcrypto.js';
import { SettleFromEventUseCase } from './application/use-case/checkout/settle-from-event.use-case.js';
import { TokenRegistryHandler } from './infrastructure/blockchain/token-registry-handler.js';
import { ProcessEscrowEventUseCase } from './application/use-case/webhook/process-escrow-event.use-case.js';
import { container } from './infrastructure/container.js';
import {
  OnChainRiskParamsAdapter,
  PolicyEngineCron,
  StubRiskParamsAdapter,
  type IRiskParamsAdapter,
} from './infrastructure/agent/index.js';
import { FheWorkerClient } from './infrastructure/fhe/fhe-worker.client.js';
import { GetPolicyStateUseCase } from './application/use-case/agent/policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from './application/use-case/agent/policy/append-audit-event.use-case.js';
import { PauseAgentUseCase } from './application/use-case/agent/policy/pause-agent.use-case.js';
import { PolicyEngineTickUseCase } from './application/use-case/agent/policy/policy-engine-tick.use-case.js';
import type { Address } from 'viem';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const API_DIR = join(__dirname, '..', 'api');

interface Route {
  pattern: RegExp;
  paramNames: string[];
  filePath: string;
  displayPath: string;
}

function scanRoutes(dir: string, base = ''): Route[] {
  const routes: Route[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      routes.push(...scanRoutes(fullPath, `${base}/${entry}`));
      continue;
    }

    if (!entry.endsWith('.ts')) continue;

    const routePath = entry === 'index.ts' ? base || '/' : `${base}/${entry.replace('.ts', '')}`;

    const paramNames: string[] = [];
    const patternStr = routePath
      .split('/')
      .map((seg) => {
        const match = seg.match(/^\[(.+)]$/);
        if (match) {
          paramNames.push(match[1]);
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');

    routes.push({
      pattern: new RegExp(`^/api${patternStr}$`),
      paramNames,
      filePath: fullPath,
      displayPath: `/api${routePath}`,
    });
  }

  return routes;
}

function sortRoutes(routes: Route[]): Route[] {
  return routes.sort((a, b) => {
    const aSegments = a.displayPath.split('/').length;
    const bSegments = b.displayPath.split('/').length;
    if (bSegments !== aSegments) return bSegments - aSegments;
    return a.paramNames.length - b.paramNames.length;
  });
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve(undefined);
        return;
      }
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      } else {
        resolve(raw);
      }
    });
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function createVercelResponse(res: ServerResponse): any {
  let statusCode = 200;

  const vercelRes: any = res;

  vercelRes.status = (code: number) => {
    statusCode = code;
    res.statusCode = code;
    return vercelRes;
  };

  vercelRes.json = (body: unknown) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
    return vercelRes;
  };

  vercelRes.send = (body: unknown) => {
    res.statusCode = statusCode;
    if (typeof body === 'object' && body !== null) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    } else {
      res.end(body == null ? '' : String(body));
    }
    return vercelRes;
  };

  vercelRes.redirect = (statusOrUrl: string | number, url?: string) => {
    if (typeof statusOrUrl === 'string') {
      res.statusCode = 302;
      res.setHeader('Location', statusOrUrl);
    } else {
      res.statusCode = statusOrUrl;
      res.setHeader('Location', url!);
    }
    res.end();
    return vercelRes;
  };

  return vercelRes;
}

async function main() {
  const routes = sortRoutes(scanRoutes(API_DIR));
  const port = Number(process.env.PORT) || 3000;

  // Wave 5 Option D · Commit 2 — bootstrap pgcrypto BEFORE the HTTP
  // listener opens. If we run `CREATE EXTENSION` after `server.listen`,
  // a request that lands during the ~50-500ms window between listen
  // and extension-create hits the encrypted-write path while
  // `pgp_sym_encrypt` is undefined → `42883 function does not exist`
  // → 500. Multi-agent review BE Arch H-1 absorbed.
  //
  // The bootstrap is idempotent (`IF NOT EXISTS`) and fast — a
  // ~10ms penalty on cold boot is cheaper than the race-induced
  // first-mint failure.
  const bootEnv = getEnv();
  if (bootEnv.DB_PROVIDER === 'postgres' && bootEnv.OPTION_D_C2_ENCRYPTION_KEY) {
    try {
      await ensurePgcryptoExtension((q) => getDb().execute(q));
      console.log('[pgcrypto] CREATE EXTENSION IF NOT EXISTS pgcrypto — OK');
    } catch (err) {
      console.warn(
        '[pgcrypto] CREATE EXTENSION failed — Scoped session install-material writes will throw; reads return 503. ' +
          'Operator must run `bash scripts/sql/install-pgcrypto-homelab.sh` (or grant CREATEDB/superuser to the muhaven role).',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const server = createServer(async (rawReq: IncomingMessage, rawRes: ServerResponse) => {
    const parsed = new URL(rawReq.url ?? '/', `http://localhost:${port}`);
    const pathname = parsed.pathname;
    const searchParams = parsed.searchParams;

    // Health check — not file-routed because all api/ routes gain /api prefix
    if (pathname === '/health') {
      try {
        const health = await getHealthStatus();
        rawRes.statusCode = health.status === 'ok' ? 200 : 503;
        rawRes.setHeader('Content-Type', 'application/json');
        rawRes.end(JSON.stringify(health));
      } catch {
        rawRes.statusCode = 503;
        rawRes.setHeader('Content-Type', 'application/json');
        rawRes.end(JSON.stringify({ status: 'degraded', timestamp: new Date().toISOString() }));
      }
      return;
    }

    const matched = routes.find((r) => r.pattern.test(pathname));

    if (!matched) {
      rawRes.statusCode = 404;
      rawRes.setHeader('Content-Type', 'application/json');
      rawRes.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const paramValues = pathname.match(matched.pattern)!.slice(1);
    const pathParams: Record<string, string> = {};
    matched.paramNames.forEach((name, i) => {
      pathParams[name] = paramValues[i];
    });

    const query: Record<string, string | string[]> = { ...pathParams };
    for (const [key, value] of searchParams) {
      const existing = query[key];
      if (existing !== undefined) {
        query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        query[key] = value;
      }
    }

    const body = await parseBody(rawReq);
    const cookies = parseCookies(rawReq.headers.cookie);

    const req: any = rawReq;
    req.query = query;
    req.cookies = cookies;
    req.body = body;

    const res = createVercelResponse(rawRes);

    try {
      // Convert Windows absolute path → file:// URL. Node's ESM loader (and
      // tsx's load hook) reject `D:\path\to\file.ts` with
      // ERR_UNSUPPORTED_ESM_URL_SCHEME because it parses `D:` as the URL
      // protocol. POSIX paths (`/path/to/file.ts`) round-trip through
      // pathToFileURL unchanged, so this is safe on every platform.
      const mod = await import(pathToFileURL(matched.filePath).href);
      const handler = mod.default;
      if (typeof handler !== 'function') {
        rawRes.statusCode = 500;
        rawRes.end(JSON.stringify({ error: `No default export in ${matched.displayPath}` }));
        return;
      }
      await handler(req, res);
    } catch (err) {
      console.error(`[ERROR] ${rawReq.method} ${pathname}`, err);
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('Content-Type', 'application/json');
        rawRes.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(port, () => {
    console.log(`\nBackend running at http://localhost:${port}\n`);
    console.log('Routes:');
    for (const route of routes) {
      console.log(`  ${route.displayPath}`);
    }
    console.log('');
  });

  // `env` already resolved as `bootEnv` above — reuse to keep the
  // schema parse single-shot. Schema validation (including the
  // cross-secret superRefine for OPTION_D_C2_ENCRYPTION_KEY +
  // BROKER_CALLBACK_SERVICE_SECRET) fires at the first getEnv() call.
  const env = bootEnv;
  const backgroundShutdown: Array<() => void> = [];

  // Start Wave 3.5 NAV writer cron if enabled. Only runs when all four
  // pieces are in place: enable flag + RPC + oracle address + writer key.
  // Otherwise we log the missing slot and stay idle so dev environments
  // don't burn LINK from a half-configured cron.
  if (env.NAV_CRON_ENABLED) {
    const missing: string[] = [];
    if (!env.RPC_URL) missing.push('RPC_URL');
    if (!env.ORACLE_ADDRESS) missing.push('ORACLE_ADDRESS');
    if (!env.NAV_CRON_PRIVATE_KEY) missing.push('NAV_CRON_PRIVATE_KEY');
    // Shape-check the key BEFORE handing it to viem. A placeholder like
    // "<<FILL_*>>" or any non-hex string would otherwise crash the boot
    // inside privateKeyToAccount.
    if (
      env.NAV_CRON_PRIVATE_KEY &&
      !/^0x[0-9a-fA-F]{64}$/.test(env.NAV_CRON_PRIVATE_KEY)
    ) {
      missing.push('NAV_CRON_PRIVATE_KEY (set but not a 0x-prefixed 32-byte hex)');
    }
    if (missing.length > 0) {
      console.warn(`[nav-cron] enabled but missing ${missing.join(', ')} — skipping`);
    } else {
      const cron = new NavWriterCron(container.rwaTokenRepo, {
        rpcUrl: env.RPC_URL!,
        oracleAddress: env.ORACLE_ADDRESS! as Address,
        navWriterPrivateKey: env.NAV_CRON_PRIVATE_KEY! as `0x${string}`,
        intervalMs: env.NAV_CRON_INTERVAL_MS,
      });
      cron.start(env.NAV_CRON_INTERVAL_MS);
      backgroundShutdown.push(() => cron.stop());
      console.log(`[nav-cron] Started (interval: ${env.NAV_CRON_INTERVAL_MS}ms)`);
    }
  }

  // Wave 5 Q3 (step 4) — daily yield-distribution cron. Opt-in
  // (default `YIELD_CRON_ENABLED=false`). Requires:
  //   - RPC_URL                             (chain calls)
  //   - YIELD_CRON_PRIVATE_KEY              (issuer EOA, mhUSDC float)
  //   - YIELD_SNAPSHOT_ADDRESS              (fallback proxy)
  //   - INVESTOR_REGISTRY_V35_ADDRESS       (holder enumeration)
  //   - STABLE_ADDRESS                      (mhUSDC float pre-flight)
  //   - DB_PROVIDER=postgres                (advisory locks + audit)
  // Any missing → log + skip. Step 5 of the rollout flips DRY_RUN=true
  // for a 24h smoke before going live.
  if (env.YIELD_CRON_ENABLED) {
    const missing: string[] = [];
    if (!env.RPC_URL) missing.push('RPC_URL');
    if (!env.YIELD_CRON_PRIVATE_KEY) missing.push('YIELD_CRON_PRIVATE_KEY');
    if (
      env.YIELD_CRON_PRIVATE_KEY &&
      !/^0x[0-9a-fA-F]{64}$/.test(env.YIELD_CRON_PRIVATE_KEY)
    ) {
      missing.push('YIELD_CRON_PRIVATE_KEY (set but not a 0x-prefixed 32-byte hex)');
    }
    if (!env.YIELD_SNAPSHOT_ADDRESS) missing.push('YIELD_SNAPSHOT_ADDRESS');
    if (!env.INVESTOR_REGISTRY_V35_ADDRESS) missing.push('INVESTOR_REGISTRY_V35_ADDRESS');
    if (!env.STABLE_ADDRESS) missing.push('STABLE_ADDRESS');
    if (env.DB_PROVIDER !== 'postgres')
      missing.push('DB_PROVIDER=postgres (yield cron requires the Postgres audit writer + advisory locks)');
    if (missing.length > 0) {
      console.warn(`[yield-cron] enabled but missing ${missing.join(', ')} — skipping`);
    } else {
      try {
        const cron = new YieldDistributionCron(
          {
            pool: getPool(),
            db: getDb(),
            rwaTokenRepo: container.rwaTokenRepo,
            oracleRepo: container.oracleRepo,
            notifyYieldCronFailure: container.notifyYieldCronFailure,
          },
          {
            rpcUrl: env.RPC_URL!,
            chainId: env.CHAIN_ID,
            privateKey: env.YIELD_CRON_PRIVATE_KEY! as `0x${string}`,
            defaultYieldSnapshotAddress: env.YIELD_SNAPSHOT_ADDRESS! as Address,
            investorRegistryAddress: env.INVESTOR_REGISTRY_V35_ADDRESS! as Address,
            stableAddress: env.STABLE_ADDRESS! as Address,
            maxSupplyCap: env.YIELD_CRON_MAX_SUPPLY_CAP,
            staleNavHaltDays: env.STALE_NAV_HALT_DAYS,
            cronExpr: env.YIELD_CRON_CRON_EXPR,
            dryRun: env.YIELD_CRON_DRY_RUN,
          },
        );
        await cron.start();
        backgroundShutdown.push(() => cron.stop());
        console.log(
          `[yield-cron] Started (expr: "${env.YIELD_CRON_CRON_EXPR}", dryRun: ${env.YIELD_CRON_DRY_RUN}, maxSupplyCap: ${env.YIELD_CRON_MAX_SUPPLY_CAP})`,
        );
      } catch (err) {
        // Round-1 Security H-2 (2026-05-21): scrub private-key-shape
        // patterns from the boot-error log. `new Wallet(badKey, ...)`
        // can produce viem stack traces that quote the key value
        // depending on the failure mode; the rest of the cron's
        // alert path uses the sanitiser, so the boot-fail path
        // should too. We can't import the operator-alert sanitiser
        // here (it's an application-layer use-case + would import
        // pino + DB ahead of init), so inline a minimal redactor.
        const redacted =
          err instanceof Error
            ? `${err.name}: ${err.message.replace(/0x[0-9a-fA-F]{64}/g, '0x…redacted')}`
            : 'unknown';
        console.warn('[yield-cron] start threw — staying idle:', redacted);
      }
    }
  }

  // Start tax-event indexer if enabled. Independent of nav-cron and the
  // legacy escrow poller — operators can enable each in isolation.
  if (env.TAX_EVENT_POLLER_ENABLED) {
    if (!env.RPC_URL) {
      console.warn('[tax-events] enabled but RPC_URL missing — skipping');
    } else {
      const queueAddrs = parseAddressList(env.REDEMPTION_QUEUE_ADDRESSES_JSON);
      const snapshotAddrs = parseAddressList(env.YIELD_SNAPSHOT_ADDRESSES_JSON);
      const tokenAddrs = parseAddressList(env.MUHAVEN_TOKEN_ADDRESSES_JSON);
      const treasuryAddrs = parseAddressList(env.TREASURY_ADDRESSES_JSON);
      const hasStable = !!env.STABLE_ADDRESS;
      if (
        !env.SUBSCRIPTION_ADDRESS &&
        queueAddrs.length === 0 &&
        snapshotAddrs.length === 0 &&
        !hasStable &&
        tokenAddrs.length === 0
      ) {
        console.warn(
          '[tax-events] enabled but no SUBSCRIPTION_ADDRESS / REDEMPTION_QUEUE_ADDRESSES_JSON / YIELD_SNAPSHOT_ADDRESSES_JSON / STABLE_ADDRESS / MUHAVEN_TOKEN_ADDRESSES_JSON configured — skipping',
        );
      } else {
        // Phase 9.A · Option Z follow-up — protocol-filter set: mint /
        // burn (from/to == 0x0) is caught at insert time, but Transfer
        // events where one leg is a queue / subscription / treasury
        // contract are also indexed-irrelevant and filtered here. Each
        // existing env var feeds the same Set so a future onboarding
        // round just needs to pass the new contract address through one
        // of the JSON-list vars.
        const protocolFilter: Address[] = [];
        if (env.SUBSCRIPTION_ADDRESS) {
          protocolFilter.push(env.SUBSCRIPTION_ADDRESS as Address);
        }
        protocolFilter.push(...queueAddrs);
        protocolFilter.push(...snapshotAddrs);
        protocolFilter.push(...treasuryAddrs);

        // Phase 9.A · Expansion (F1) — `TokenRegistry.IssuerUpdated`
        // subscription. Replaces the operator runbook step
        // `pnpm seed:sync-issuers` after a `transfer-issuer.ts` rotation.
        // The registry leg only fires when BOTH the address and the
        // handler are present; an unset `TOKEN_REGISTRY_ADDRESS` leaves
        // the existing 5-event feed unchanged.
        const registryAddr = env.TOKEN_REGISTRY_ADDRESS as Address | undefined;
        const registryHandler = registryAddr
          ? new TokenRegistryHandler(container.rwaTokenRepo)
          : undefined;

        const indexer = new TaxEventIndexer(
          container.taxEventRepo,
          {
            rpcUrl: env.RPC_URL,
            subscriptionAddress: env.SUBSCRIPTION_ADDRESS as Address | undefined,
            redemptionQueueAddresses: queueAddrs,
            yieldSnapshotAddresses: snapshotAddrs,
            // Phase 9.A · Option Z — adds MuHavenStable Wrap/Unwrap to the
            // feed. Pre-upgrade staging deployments without the post-Option-Z
            // impl are still supported via the topic filter (no matching
            // events → no rows).
            muHavenStableAddress: env.STABLE_ADDRESS as Address | undefined,
            // Phase 9.A · Option Z follow-up — adds MuHavenToken Transfer to
            // the feed. Pre-upgrade tokens (Transfer's old 2-arg signature)
            // are invisible because their topic0 differs from the broadened
            // 3-arg signature; no back-index of historical transfers.
            muHavenTokenAddresses: tokenAddrs,
            protocolFilterAddresses: protocolFilter,
            oracleAddress: env.ORACLE_ADDRESS as Address | undefined,
            tokenRegistryAddress: registryAddr,
            intervalMs: env.TAX_EVENT_POLLER_INTERVAL_MS,
          },
          undefined,
          registryHandler,
        );
        indexer.start(env.TAX_EVENT_POLLER_INTERVAL_MS);
        backgroundShutdown.push(() => indexer.stop());
        console.log(`[tax-events] Started (interval: ${env.TAX_EVENT_POLLER_INTERVAL_MS}ms)`);
      }
    }
  }

  // Wave 5 Option D · Commit 3 — PermissionInstalled chain indexer.
  // AUTHORITATIVE source-of-truth for `agent_scoped_sessions.enable_status`
  // flips from `'pending'` to `'enabled'`. Re-uses `RPC_URL`; no
  // address allowlist (event is emitted by every kernel that owns
  // its own permission validator).
  if (env.PERMISSION_INSTALLED_POLLER_ENABLED) {
    if (!env.RPC_URL) {
      console.warn('[permission-installed] enabled but RPC_URL missing — skipping');
    } else {
      const markEnabled = new MarkScopedSessionValidatorEnabledUseCase(
        container.scopedSessionRepo,
        container.appendAuditEvent,
      );
      const indexer = new PermissionInstalledIndexer(
        container.scopedSessionRepo,
        markEnabled,
        {
          rpcUrl: env.RPC_URL,
          intervalMs: env.PERMISSION_INSTALLED_POLLER_INTERVAL_MS,
          confirmations: env.PERMISSION_INSTALLED_POLLER_CONFIRMATIONS,
        },
      );
      indexer.start(env.PERMISSION_INSTALLED_POLLER_INTERVAL_MS);
      backgroundShutdown.push(() => indexer.stop());
      console.log(
        `[permission-installed] Started (interval: ${env.PERMISSION_INSTALLED_POLLER_INTERVAL_MS}ms)`,
      );
    }
  }

  // Wave 5 Option D · Commit 3 — validator-install watchdog. Flips
  // pending rows older than the configured threshold to `'failed'`
  // and fires a Telegram operator alert per flipped row.
  if (env.VALIDATOR_ENABLE_WATCHDOG_ENABLED) {
    const watchdog = new ValidatorEnableWatchdog(
      container.scopedSessionRepo,
      container.operatorAlertTransport,
      container.appendAuditEvent,
      {
        staleThresholdSec: env.VALIDATOR_ENABLE_WATCHDOG_STALE_SEC,
        batchLimit: env.VALIDATOR_ENABLE_WATCHDOG_BATCH_LIMIT,
      },
    );
    watchdog.start(env.VALIDATOR_ENABLE_WATCHDOG_INTERVAL_MS);
    backgroundShutdown.push(() => watchdog.stop());
    console.log(
      `[validator-enable-watchdog] Started (interval: ${env.VALIDATOR_ENABLE_WATCHDOG_INTERVAL_MS}ms, stale: ${env.VALIDATOR_ENABLE_WATCHDOG_STALE_SEC}s)`,
    );
  }

  // Wave 5 P4 — checkout settlement indexer. Watches
  // `MuHavenSubscription.Purchased` events and flips matching
  // checkout sessions from `purchased → settled` so the buyer page
  // + issuer dashboard reflect on-chain settlement automatically.
  // Independent of every other indexer toggle.
  if (env.CHECKOUT_SETTLEMENT_POLLER_ENABLED) {
    if (!env.RPC_URL) {
      console.warn('[checkout-settlement] enabled but RPC_URL missing — skipping');
    } else if (!env.SUBSCRIPTION_ADDRESS) {
      console.warn(
        '[checkout-settlement] enabled but SUBSCRIPTION_ADDRESS missing — skipping',
      );
    } else {
      const settleUseCase = new SettleFromEventUseCase(
        container.checkoutSessionRepo,
        container.checkoutSseChannel,
        container.webhookDispatcher,
      );
      const indexer = new CheckoutSettlementIndexer(
        container.checkoutSessionRepo,
        settleUseCase,
        {
          rpcUrl: env.RPC_URL,
          subscriptionAddress: env.SUBSCRIPTION_ADDRESS as Address,
          intervalMs: env.CHECKOUT_SETTLEMENT_POLLER_INTERVAL_MS,
        },
      );
      indexer.start(env.CHECKOUT_SETTLEMENT_POLLER_INTERVAL_MS);
      backgroundShutdown.push(() => indexer.stop());
      console.log(
        `[checkout-settlement] Started (interval: ${env.CHECKOUT_SETTLEMENT_POLLER_INTERVAL_MS}ms, subscription: ${env.SUBSCRIPTION_ADDRESS})`,
      );
    }
  }

  // Start Wave 3 blockchain event poller if enabled
  if (!env.BLOCK_POLLER_ENABLED) {
    // Phase 9.A · Option C / Option Z (2026-05-XX) — Wave 3 yield + escrow
    // paths officially retired post-`earlybot` merge. The legacy poller
    // can stay env-gated for any future Wave 3 forensic re-poll, but on a
    // Wave-3.5-only stack `/activity` reads tax_events exclusively.
    console.log('[poller] Wave 3 BLOCK_POLLER disabled per Phase 9.A Option C');
  } else {
    // REINEIRA_ESCROW_ADDRESS is retained as the env var name for backwards
    // compatibility with existing homelab configs — semantically it now points
    // at MuHavenEscrow (Phase 19B/19D switched escrow implementations).
    const escrowAddress = env.REINEIRA_ESCROW_ADDRESS;
    const distributorAddress = env.YIELD_DISTRIBUTOR_ADDRESS;
    const registryAddress = env.INVESTOR_REGISTRY_ADDRESS;
    const rpcUrl = env.RPC_URL;

    if (!escrowAddress || !distributorAddress || !registryAddress || !rpcUrl) {
      console.warn('[poller] BLOCK_POLLER_ENABLED but missing REINEIRA_ESCROW_ADDRESS, YIELD_DISTRIBUTOR_ADDRESS, INVESTOR_REGISTRY_ADDRESS, or RPC_URL — skipping');
    } else {
      const useCase = new ProcessEscrowEventUseCase(
        container.escrowRepo,
        container.escrowEventRepo,
        container.yieldRecordRepo,
        container.userRepo,
      );

      const poller = new BlockchainEventPoller(useCase, {
        rpcUrl,
        escrowAddress: escrowAddress as `0x${string}`,
        yieldDistributorAddress: distributorAddress as `0x${string}`,
        investorRegistryAddress: registryAddress as `0x${string}`,
        intervalMs: env.BLOCK_POLLER_INTERVAL_MS,
      });

      poller.start(env.BLOCK_POLLER_INTERVAL_MS);
      backgroundShutdown.push(() => poller.stop());

      console.log(`[poller] Event poller started (interval: ${env.BLOCK_POLLER_INTERVAL_MS}ms)`);
    }
  }

  // Wave 4 P1 — agent policy engine cron (Tier=PolicyBound users only).
  // P6 adds the `onchain` adapter wiring; defaults to `stub` for dev.
  if (env.AGENT_POLICY_CRON_ENABLED) {
    const getPolicyState = new GetPolicyStateUseCase(container.agentStateRepo);
    const appendAudit = new AppendAuditEventUseCase(container.agentAuditRepo);
    const pauseAgent = new PauseAgentUseCase(container.agentStateRepo, getPolicyState, appendAudit);

    let adapter: IRiskParamsAdapter;
    if (env.RISK_PARAMS_ADAPTER === 'onchain') {
      const rpcUrl = env.RPC_URL;
      const riskParamsAddress = env.RISK_PARAMS_ADDRESS;
      const agentPrivateKey = env.AGENT_POLICY_PRIVATE_KEY;
      if (!rpcUrl || !riskParamsAddress || !agentPrivateKey) {
        console.warn(
          '[agent-policy] RISK_PARAMS_ADAPTER=onchain requires RPC_URL + RISK_PARAMS_ADDRESS + AGENT_POLICY_PRIVATE_KEY; falling back to stub',
        );
        adapter = new StubRiskParamsAdapter();
      } else {
        adapter = new OnChainRiskParamsAdapter(
          {
            rpcUrl,
            riskParamsAddress: riskParamsAddress as `0x${string}`,
            agentPrivateKey: agentPrivateKey as `0x${string}`,
          },
          new FheWorkerClient(),
        );
        console.log('[agent-policy] OnChainRiskParamsAdapter wired');
      }
    } else {
      adapter = new StubRiskParamsAdapter();
    }

    const tick = new PolicyEngineTickUseCase(
      container.agentStateRepo,
      container.agentCronStateRepo,
      adapter,
      pauseAgent,
      appendAudit,
    );
    const cron = new PolicyEngineCron(tick, { intervalMs: env.AGENT_POLICY_CRON_INTERVAL_MS });
    cron.start();
    backgroundShutdown.push(() => cron.stop());
    console.log(`[agent-policy] Started (interval: ${env.AGENT_POLICY_CRON_INTERVAL_MS}ms)`);
  }

  if (backgroundShutdown.length > 0) {
    const shutdown = () => {
      for (const stop of backgroundShutdown) {
        try {
          stop();
        } catch (err) {
          console.warn('[shutdown] background cleanup error:', err);
        }
      }
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

/**
 * Parse a JSON array of addresses from an env var. Invalid entries are
 * filtered silently — the operator's intent is "add what works, ignore
 * what doesn't" rather than crash on a single typo.
 */
function parseAddressList(raw: string | undefined): Address[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
    );
  } catch {
    return [];
  }
}

main();
