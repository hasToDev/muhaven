/**
 * Wave 5 Q3 step 4 / Q3_PLAN.md §F — operator one-off runner for the
 * daily yield-distribution pipeline.
 *
 * The cron (`backend/src/infrastructure/blockchain/yield-cron.ts`)
 * fires `runYieldEpoch` on a node-cron schedule. This script fires
 * the SAME runner from an interactive shell — for:
 *   - Pre-launch smoke (Q3_PLAN.md halt-before-prod checklist).
 *   - Ad-hoc "operator wants to fire today's distribution off-cycle".
 *   - First-time end-to-end run on prod with a single token before
 *     flipping `YIELD_CRON_ENABLED=true`.
 *
 * Architecture:
 *   - ESM scope (backend's package.json has `"type": "module"`).
 *   - Static imports — NO CJS↔ESM bridge (the step 2c B1-revert trap
 *     that killed the root-CJS adapter idea; see runner header).
 *   - First real consumer of the Postgres-backed `PgAuditWriter` +
 *     `PgAdvisoryLockHandle` shipped in commit-1 of step 4.
 *   - Reuses the cron's pre-flight math (apy × nav × cap math,
 *     uint64-narrowing guard, override clamp, mhUSDC float pre-
 *     flight) by COPYING the same constants + helpers. We
 *     deliberately don't reuse `YieldDistributionCron` itself
 *     because the cron's lifecycle (node-cron schedule, 23h DB
 *     guard, boot alert, per-tick `running` flag) doesn't apply to
 *     a one-shot script run.
 *   - Reads ALL on-chain addresses + the issuer key from
 *     `process.env` (same vars the cron consumes). No filesystem
 *     dependency on `deployments/*.json` — that file isn't in the
 *     backend Docker image, so the prior JSON-reading approach
 *     could ONLY run from the operator dev machine. Reading from
 *     env makes the script work uniformly from BOTH a dev-machine
 *     shell (with backend/.env loaded by tsx) AND inside the
 *     container (`docker compose exec backend pnpm tsx scripts/
 *     run-daily-yield.ts ...`). The which-environment selection is
 *     implicit in which backend container's env you're using.
 *
 * Usage:
 *
 *   # Inside the prod backend container (env auto-loaded):
 *   ssh -i ~/.ssh/id_muhaven_vm muhaven@192.168.1.52 \
 *     'cd /home/muhaven/Project/Fhenix/MuHaven && \
 *      docker compose -f docker-compose.yml -p muhaven exec backend \
 *        pnpm tsx scripts/run-daily-yield.ts --dry-run --token=USYC'
 *
 *   # From operator dev machine (relies on backend/.env values —
 *   # DATABASE_URL must reach the homelab Postgres via SSH tunnel
 *   # or direct VPN, since the homelab Pg only binds 127.0.0.1):
 *   cd backend && pnpm tsx scripts/run-daily-yield.ts --dry-run
 *
 * Required env (read directly from `process.env`; the backend
 * container's env-file or your local backend/.env populates these):
 *   DATABASE_URL                       postgres connection
 *   DB_PROVIDER=postgres               audit writer + advisory locks need real Pg
 *   RPC_URL                            Arb Sepolia RPC endpoint
 *   CHAIN_ID                           421614 (default)
 *   YIELD_CRON_PRIVATE_KEY             issuer EOA (mhUSDC float holder)
 *   STABLE_ADDRESS                     MuHavenStable proxy
 *   YIELD_SNAPSHOT_ADDRESS             YieldSnapshot proxy (default fallback)
 *   INVESTOR_REGISTRY_V35_ADDRESS      InvestorRegistry proxy
 *   YIELD_CRON_MAX_SUPPLY_CAP          global cap (bigint, default 10_000_000)
 *   STALE_NAV_HALT_DAYS                NAV staleness ceiling (default 7)
 *
 * Exit codes:
 *   0  every attempted token succeeded or was skipped (no failures)
 *   1  one or more tokens failed (incl. uint64 overflow, float short,
 *      runner throw, fetch / decrypt failures)
 *   2  config / env error (missing env, bad shape, etc.)
 */
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  type Provider,
} from 'ethers';
import { FheTypes } from '@cofhe/sdk';
import { eq, sql } from 'drizzle-orm';
import type { Address } from 'viem';

import { getDb, getPool } from '../src/infrastructure/repository/postgres/db.js';
import { rwaTokens } from '../src/infrastructure/repository/postgres/schema.js';
import { PgAuditWriter } from '../src/infrastructure/repository/postgres/pg-audit-writer.js';
import { acquireTokenLock } from '../src/infrastructure/repository/postgres/pg-advisory-lock-handle.js';
import { runYieldEpoch, type RunEpochInput } from '../src/infrastructure/blockchain/yield-epoch-runner.js';
import { createNodeCofheClient } from '../src/infrastructure/blockchain/node-cofhe-client.js';
import { PgRwaTokenRepository } from '../src/infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { PgOracleRepository } from '../src/infrastructure/repository/postgres/pg-oracle.repository.js';

// Mirror the cron's constants so the math is byte-identical (any
// divergence between cron-tick yields + script-one-off yields is a
// reconciliation nightmare). The cron's own file is the source of
// truth; this duplication is small + the testing constraints
// (avoiding cron-lifecycle deps) make sharing painful.
//
// `RATE_SCALE` is inlined (NOT imported from `@muhaven/sdk`) for the
// same reason — backend Dockerfile builds in isolation; the workspace
// package isn't reachable from inside the container. See
// yield-epoch-runner.ts header for the full rationale.
const RATE_SCALE = 1_000_000n;
const NAV_USD6_SCALE = 1_000_000n;
const DAYS_PER_YEAR = 365n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

interface CliArgs {
  dryRun: boolean;
  token: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let token: string | null = null;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--token=')) token = a.slice('--token='.length).toUpperCase();
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--env=prod' || a === '--env=staging') {
      // Accept-but-no-op for backward compat with the Q3_PLAN.md
      // halt-before-prod checklist invocation. Environment is now
      // determined by which backend container's env-file is loaded.
      console.warn(
        `[warn] --env=… is no longer load-bearing — environment is implicit in the loaded backend env-file. Ignoring.`,
      );
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return { dryRun, token };
}

function printHelp(): void {
  console.log(`Wave 5 Q3 — daily yield-distribution one-shot.

Usage:
  pnpm tsx scripts/run-daily-yield.ts [--dry-run] [--token=SYMBOL]

Options:
  --dry-run            Skip on-chain side effects + DB audit writes
  --token=SYMBOL       Process only this RWA symbol (default: every active token)
  --help, -h           Show this help and exit

Environment is determined by which backend env-file is loaded — run
inside the prod container for prod, the stage container for stage.
`);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] required env var unset: ${name}`);
    process.exit(2);
  }
  return v;
}

/** Validate + lower-case a 0x-prefixed 40-hex address from env. Exits
 *  loud on bad shape — the runner's downstream checks (e.g.
 *  `YieldSnapshot.pusdc()` match assertion) would also catch it, but a
 *  config-time loud-fail is the right boundary. */
function envAddressOrDie(name: string): Address {
  const v = envOrDie(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.error(`[fatal] env var ${name} must be a 0x-prefixed 20-byte hex address; got "${v}"`);
    process.exit(2);
  }
  return v as Address;
}

interface TokenWork {
  address: string;
  symbol: string;
  yieldSnapshotAddress?: string;
}

async function loadTargetTokens(
  args: CliArgs,
): Promise<TokenWork[]> {
  const db = getDb();
  const repo = new PgRwaTokenRepository(db);
  const tokens = await repo.findByStatus('active');
  if (args.token === null) {
    return tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      yieldSnapshotAddress: t.yieldSnapshotAddress,
    }));
  }
  const match = tokens.find((t) => t.symbol.toUpperCase() === args.token);
  if (!match) {
    console.error(
      `[fatal] no active token with symbol "${args.token}" (case-insensitive). ` +
        `Active symbols: ${tokens.map((t) => t.symbol).join(', ')}`,
    );
    process.exit(2);
  }
  return [
    {
      address: match.address,
      symbol: match.symbol,
      yieldSnapshotAddress: match.yieldSnapshotAddress,
    },
  ];
}

async function readMaxSupplyCapOverride(tokenAddrLower: string): Promise<bigint | null> {
  const db = getDb();
  const rows = await db
    .select({ override: rwaTokens.maxSupplyCapOverride })
    .from(rwaTokens)
    .where(eq(sql`lower(${rwaTokens.address})`, tokenAddrLower))
    .limit(1);
  const v = rows[0]?.override;
  if (!v) return null;
  return BigInt(v);
}

interface SweepAddresses {
  stable: Address;
  yieldSnapshot: Address;
  investorRegistry: Address;
}

interface SweepCtx {
  floatRemaining: bigint | null;
  signer: Wallet;
  cofheClient: Awaited<ReturnType<typeof createNodeCofheClient>>;
  provider: Provider;
  addresses: SweepAddresses;
  maxSupplyCap: bigint;
  staleNavHaltDays: number;
  dryRun: boolean;
  auditWriter: PgAuditWriter;
}

async function readMhUsdcFloat(ctx: SweepCtx): Promise<bigint | null> {
  if (ctx.dryRun) return null;
  const FLOAT_READ_TIMEOUT_MS = 60_000;
  try {
    const stable = new Contract(
      ctx.addresses.stable,
      ['function confidentialBalanceOf(address holder) view returns (uint256)'],
      ctx.signer,
    );
    const handle = (await stable.confidentialBalanceOf(ctx.signer.address)) as bigint;
    const decryptPromise = ctx.cofheClient
      .decryptForView(handle, FheTypes.Uint64)
      .withPermit()
      .execute();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`decryptForView timed out after ${FLOAT_READ_TIMEOUT_MS}ms`),
          ),
        FLOAT_READ_TIMEOUT_MS,
      ),
    );
    return (await Promise.race([decryptPromise, timeoutPromise])) as bigint;
  } catch (err) {
    console.error('[float-read] failed:', err);
    return null;
  }
}

async function processToken(
  token: TokenWork,
  ctx: SweepCtx,
): Promise<'success' | 'skipped' | 'failed'> {
  const tokenAddrLower = token.address.toLowerCase();
  console.log(`\n[${token.symbol}] ===========================`);
  console.log(`[${token.symbol}] address: ${tokenAddrLower}`);

  // Pre-flight: oracle snapshot
  const oracleRepo = new PgOracleRepository(getDb());
  const snapshot = await oracleRepo.findLatestSnapshot(token.symbol);
  if (!snapshot) {
    console.log(`[${token.symbol}] no oracle snapshot — skipping`);
    return 'skipped';
  }
  if (snapshot.apy7Day === null || snapshot.navDollar === null) {
    console.log(`[${token.symbol}] apy7Day or navDollar null — skipping`);
    return 'skipped';
  }
  const ageDays = (Date.now() - snapshot.snapshotAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > ctx.staleNavHaltDays) {
    console.log(
      `[${token.symbol}] NAV stale ${ageDays.toFixed(1)}d > ${ctx.staleNavHaltDays}d — skipping`,
    );
    return 'skipped';
  }
  console.log(
    `[${token.symbol}] apy_7_day=${snapshot.apy7Day}% nav=$${snapshot.navDollar} age=${ageDays.toFixed(1)}d`,
  );

  // Compute ratePerShare + encTotalYield (mirrors yield-cron.ts)
  const apyDecimal = Number.parseFloat(snapshot.apy7Day) / 100;
  const navDecimal = Number.parseFloat(snapshot.navDollar);
  if (!Number.isFinite(apyDecimal) || apyDecimal <= 0) {
    console.log(`[${token.symbol}] apy7Day failed parse — skipping`);
    return 'skipped';
  }
  if (!Number.isFinite(navDecimal) || navDecimal <= 0) {
    console.log(`[${token.symbol}] navDollar failed parse — skipping`);
    return 'skipped';
  }
  const navUsd6 = BigInt(Math.floor(navDecimal * Number(NAV_USD6_SCALE)));
  const apyScaled = BigInt(Math.floor(apyDecimal * Number(RATE_SCALE)));
  if (apyScaled === 0n) {
    console.log(`[${token.symbol}] apyScaled floored to 0 — skipping`);
    return 'skipped';
  }
  const ratePerShare = (apyScaled * navUsd6) / DAYS_PER_YEAR;
  if (ratePerShare === 0n) {
    console.log(`[${token.symbol}] ratePerShare floored to 0 — skipping`);
    return 'skipped';
  }
  if (ratePerShare > UINT128_MAX) {
    console.error(`[${token.symbol}] ratePerShare ${ratePerShare} > uint128.max — FAILED`);
    return 'failed';
  }

  // Per-token cap override (clamped to [1, maxSupplyCap])
  const overrideRaw = await readMaxSupplyCapOverride(tokenAddrLower);
  let effectiveCap = ctx.maxSupplyCap;
  if (overrideRaw !== null) {
    if (overrideRaw < 1n || overrideRaw > ctx.maxSupplyCap) {
      console.log(
        `[${token.symbol}] override ${overrideRaw} out of [1, ${ctx.maxSupplyCap}] — falling back to global`,
      );
    } else {
      effectiveCap = overrideRaw;
    }
  }
  const encTotalYield = (effectiveCap * ratePerShare) / RATE_SCALE;
  if (encTotalYield > UINT64_MAX) {
    console.error(
      `[${token.symbol}] encTotalYield ${encTotalYield} > uint64.max — FAILED`,
    );
    return 'failed';
  }
  if (encTotalYield === 0n) {
    console.log(`[${token.symbol}] encTotalYield floored to 0 — skipping`);
    return 'skipped';
  }
  console.log(
    `[${token.symbol}] ratePerShare=${ratePerShare} effectiveCap=${effectiveCap} encTotalYield=${encTotalYield}`,
  );

  // mhUSDC float pre-flight (uses sweep-start balance — same multi-
  // token-safe ledger as the cron; see yield-cron.ts Sec M-4)
  if (!ctx.dryRun) {
    if (ctx.floatRemaining === null) {
      console.error(`[${token.symbol}] float not read — skipping`);
      return 'skipped';
    }
    if (ctx.floatRemaining < encTotalYield) {
      console.error(
        `[${token.symbol}] float ${ctx.floatRemaining} < encTotalYield ${encTotalYield} — skipping`,
      );
      return 'skipped';
    }
  }

  // Resolve YieldSnapshot proxy
  const snapshotAddr = (token.yieldSnapshotAddress ?? ctx.addresses.yieldSnapshot) as Address;
  if (!snapshotAddr || snapshotAddr === '0x0000000000000000000000000000000000000000') {
    console.error(`[${token.symbol}] yield snapshot address unresolved — FAILED`);
    return 'failed';
  }

  // Acquire per-token advisory lock + hand off to runner
  const lock = await acquireTokenLock(getPool(), tokenAddrLower);
  if (!lock) {
    console.log(`[${token.symbol}] per-token lock held — skipping`);
    return 'skipped';
  }
  try {
    const input: RunEpochInput = {
      symbol: token.symbol,
      tokenAddr: token.address as Address,
      ratePerShare,
      encTotalYield,
      effectiveMaxSupplyCap: effectiveCap,
      navAtTimeUsd: snapshot.navDollar,
      apyAtTimePercent: snapshot.apy7Day,
      snapshotAddr,
      investorRegistryAddr: ctx.addresses.investorRegistry,
      pusdcAddr: ctx.addresses.stable,
      signer: ctx.signer,
      cofheClient: ctx.cofheClient,
      // Script-mode operator grant: same 2-day tighter blast radius as
      // the cron uses (Q3_PLAN.md A.4) — the legacy 365-day grant from
      // scripts/run-yield-epoch.ts is NOT inherited here.
      operatorGrantSeconds: 2n * 24n * 60n * 60n,
      revokeOperatorAfterFund: true,
      dryRun: ctx.dryRun,
      logger: {
        info: (obj, msg) =>
          typeof obj === 'string'
            ? console.log(`[${token.symbol}] ${obj}`)
            : console.log(`[${token.symbol}] ${msg ?? ''}`, obj),
        warn: (obj, msg) =>
          typeof obj === 'string'
            ? console.warn(`[${token.symbol}] ${obj}`)
            : console.warn(`[${token.symbol}] ${msg ?? ''}`, obj),
        error: (obj, msg) =>
          typeof obj === 'string'
            ? console.error(`[${token.symbol}] ${obj}`)
            : console.error(`[${token.symbol}] ${msg ?? ''}`, obj),
      },
      audit: ctx.auditWriter,
      tokenLock: lock,
    };
    const result = await runYieldEpoch(input);
    console.log(
      `[${token.symbol}] runYieldEpoch → status=${result.status} epochId=${result.epochId.toString()}` +
        (result.fundTxHash ? ` tx=${result.fundTxHash}` : '') +
        (result.skipReason ? ` skipReason=${result.skipReason}` : ''),
    );
    if (result.status === 'success' || result.status === 'resumed_success') {
      // Only fresh fund consumes float; resumed_success is a prior-
      // tick drain already reflected in sweep-start balance.
      if (result.status === 'success' && !ctx.dryRun && ctx.floatRemaining !== null) {
        ctx.floatRemaining -= encTotalYield;
      }
      return 'success';
    }
    if (result.status === 'skipped') return 'skipped';
    console.error(`[${token.symbol}] unexpected runner status: ${result.status} — FAILED`);
    return 'failed';
  } catch (err) {
    console.error(`[${token.symbol}] runner threw:`, err);
    return 'failed';
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[run-daily-yield] dryRun=${args.dryRun} token=${args.token ?? '<all active>'}`,
  );

  // Required env
  envOrDie('DATABASE_URL');
  if (process.env.DB_PROVIDER !== 'postgres') {
    console.error('[fatal] DB_PROVIDER must be "postgres" — script requires the audit writer + advisory locks');
    process.exit(2);
  }
  const rpcUrl = envOrDie('RPC_URL');
  const chainId = Number(process.env.CHAIN_ID ?? '421614');
  const privateKey = envOrDie('YIELD_CRON_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('[fatal] YIELD_CRON_PRIVATE_KEY must be 0x-prefixed 32-byte hex');
    process.exit(2);
  }
  const maxSupplyCap = BigInt(process.env.YIELD_CRON_MAX_SUPPLY_CAP ?? '10000000');
  if (maxSupplyCap < 1n || maxSupplyCap > 10_000_000_000n) {
    console.error('[fatal] YIELD_CRON_MAX_SUPPLY_CAP out of [1, 10_000_000_000]');
    process.exit(2);
  }
  const staleNavHaltDays = Number(process.env.STALE_NAV_HALT_DAYS ?? '7');

  // Addresses — env-driven (matches cron's wiring; works inside the
  // backend Docker container without bundling deployments JSON).
  const addresses: SweepAddresses = {
    stable: envAddressOrDie('STABLE_ADDRESS'),
    yieldSnapshot: envAddressOrDie('YIELD_SNAPSHOT_ADDRESS'),
    investorRegistry: envAddressOrDie('INVESTOR_REGISTRY_V35_ADDRESS'),
  };
  console.log(
    `[addresses] STABLE=${addresses.stable} ` +
      `INVESTOR_REGISTRY=${addresses.investorRegistry} ` +
      `YIELD_SNAPSHOT=${addresses.yieldSnapshot}`,
  );

  // Connect ethers + cofhe client (matches cron's wiring)
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  console.log(`[signer] address=${signer.address}`);
  const cofheClient = await createNodeCofheClient({
    rpcUrl,
    chainId,
    privateKey: privateKey as `0x${string}`,
  });

  const auditWriter = new PgAuditWriter(getDb());

  const ctx: SweepCtx = {
    floatRemaining: null,
    signer,
    cofheClient,
    provider,
    addresses,
    maxSupplyCap,
    staleNavHaltDays,
    dryRun: args.dryRun,
    auditWriter,
  };

  // Sweep-start mhUSDC float read (skipped in dry-run)
  if (!args.dryRun) {
    ctx.floatRemaining = await readMhUsdcFloat(ctx);
    if (ctx.floatRemaining === null) {
      console.error('[fatal] mhUSDC float read failed — aborting sweep');
      process.exit(1);
    }
    console.log(`[float] issuer mhUSDC balance = ${ctx.floatRemaining} base units`);
  }

  // Load tokens to process
  const targets = await loadTargetTokens(args);
  console.log(`[sweep] ${targets.length} token(s) to process: ${targets.map((t) => t.symbol).join(', ')}`);

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const token of targets) {
    const outcome = await processToken(token, ctx);
    if (outcome === 'success') succeeded++;
    else if (outcome === 'skipped') skipped++;
    else failed++;
  }

  console.log(
    `\n[summary] attempted=${targets.length} succeeded=${succeeded} skipped=${skipped} failed=${failed}` +
      (args.dryRun ? ' (DRY-RUN — no on-chain side effects)' : ''),
  );
  if (ctx.floatRemaining !== null) {
    console.log(`[float] remaining mhUSDC = ${ctx.floatRemaining} base units`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[fatal] uncaught:', err);
  process.exit(1);
});
