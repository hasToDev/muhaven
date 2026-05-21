/**
 * Wave 5 Q3 (step 4 / Q3_PLAN §A) — `YieldDistributionCron`.
 *
 * Daily heartbeat that drives the proportional yield distribution
 * pipeline for every active RWA on the platform. Calls into the
 * shared `runYieldEpoch` runner (shipped step 1+2, commit `a848a98`)
 * with real Postgres-backed `AuditWriter` + per-token
 * `AdvisoryLockHandle` instead of the no-op fallbacks.
 *
 * Lifecycle hierarchy (each layer narrower than the one above):
 *
 *     ┌─────────────────────────────────────────────────────────┐
 *     │ node-cron schedule (default '0 0 * * *' UTC)            │
 *     │                                                         │
 *     │  ┌──────────────────────────────────────────────────┐   │
 *     │  │ safeTick (top-level error firewall, never throws)│   │
 *     │  │                                                  │   │
 *     │  │  ┌────────────────────────────────────────────┐  │   │
 *     │  │  │ tick-level advisory lock                   │  │   │
 *     │  │  │ (cron-vs-cron re-entry guard, INSIDE tick) │  │   │
 *     │  │  │                                            │  │   │
 *     │  │  │  cron_state 23h atomic-UPDATE guard        │  │   │
 *     │  │  │  (restart double-fire guard)               │  │   │
 *     │  │  │                                            │  │   │
 *     │  │  │  for each active token:                    │  │   │
 *     │  │  │    ┌──────────────────────────────────┐    │  │   │
 *     │  │  │    │ per-token advisory lock          │    │  │   │
 *     │  │  │    │ (cron-vs-manual-script guard)    │    │  │   │
 *     │  │  │    │                                  │    │  │   │
 *     │  │  │    │   pre-flight skips →             │    │  │   │
 *     │  │  │    │     no holders / NAV stale /     │    │  │   │
 *     │  │  │    │     mhUSDC float short / etc.    │    │  │   │
 *     │  │  │    │                                  │    │  │   │
 *     │  │  │    │   runYieldEpoch(tokenLock)       │    │  │   │
 *     │  │  │    │   (runner owns lock.release())   │    │  │   │
 *     │  │  │    └──────────────────────────────────┘    │  │   │
 *     │  │  └────────────────────────────────────────────┘  │   │
 *     │  └──────────────────────────────────────────────────┘   │
 *     └─────────────────────────────────────────────────────────┘
 *
 * Key invariants (none of these are defense-in-depth — break one and
 * the cron silently double-fires or leaks money):
 *
 *   I-1  **23h atomic UPDATE.** Q3_PLAN.md `DB H-1` (schema comment
 *        at `cron_state`). Tick guard is `UPDATE cron_state SET
 *        last_fired_at=NOW() WHERE name=$1 AND last_fired_at < NOW()
 *        - INTERVAL '23 hours' RETURNING 1`. Zero rows → already
 *        fired → skip. NEVER refactor to SELECT-then-UPDATE — race
 *        under restart-induced contention double-fires the cron.
 *
 *   I-2  **Two-tier advisory locks.** Q3_PLAN.md `A.2` /
 *        `feedback_pg_for_update_aggregate` companion: tick lock
 *        guards cron-vs-cron; per-token lock guards cron-vs-manual-
 *        script. Both use `pg_try_advisory_lock(hashtextextended(ns,
 *        key))` two-arg form (S2 — int4 collision risk on single-arg
 *        form). Same `PoolClient` for acquire + release (session-
 *        scoped lock) — handled by `PgAdvisoryLockHandle`.
 *
 *   I-3  **Lock ownership crossover at runner boundary.** The cron
 *        acquires the per-token lock; the runner's `RunEpochInput.
 *        tokenLock.release()` runs in the runner's `finally`. Pre-
 *        flight skips inside the cron MUST release the lock too —
 *        we use a `try { ... } finally { await lock.release() }`
 *        belt-and-braces. `release()` is idempotent (the runner's
 *        own finally is a no-op if the cron already released).
 *
 *   I-4  **`tokenAddress` MUST flow to alerts.** Round-2 Security M-4
 *        (step 3 brief). Every `container.notifyYieldCronFailure
 *        .execute({...})` call passes `tokenAddress` so the sanitiser
 *        emits the canonical known-token address rather than redact
 *        every 40-hex string in the error message. Without it,
 *        operator alerts read as `Token: USYC | Error: ZeroRateError
 *        | <body> 0x…addr…` — losing the symbol↔address correlation
 *        the runner embeds in its six error classes.
 *
 *   I-5  **Float pre-flight closes the silent-fail gap.** Runner
 *        header documents the silent-fail-on-fundEpoch known gap:
 *        `MuHavenStable._doTransfer` applies `_silentFailBound` so
 *        an under-funded issuer mhUSDC float silent-fails the pull
 *        while the tx receipt reports `status: 1`. The runner's
 *        `funded_no_audit` poll would then close `success` despite
 *        zero actual transfer. Mitigation: cron decrypts `mhUSDC.
 *        confidentialBalanceOf(issuer)` via permit-based view (the
 *        cron's cofhe client has self-permit for issuerAddr) +
 *        skips the token + alerts WARN if balance < encTotalYield.
 *
 *   I-6  **Dry-run is opt-in production safety, not a dev toggle.**
 *        `YIELD_CRON_DRY_RUN=true` → all on-chain side effects (open
 *        / snapshot / finalize / fund / setOperator) are NO-OPs in
 *        the runner. The cron still fires its tick + iterates
 *        tokens, but the per-tick boot Telegram alert (debounced 6h
 *        via `cron_state['yield-cron-boot-alert']` row, v3.1 S5)
 *        warns operators they're in dry-run mode so prod cutover
 *        isn't accidentally left half-engaged.
 *
 * Deferred (filed as follow-ups, not Q3 blockers):
 *   - per-token YieldSnapshot proxy deploys (Q3_PLAN §A dropped — singleton
 *     structurally safe per `YieldSnapshot.sol:151-160`).
 *   - Sweep for trapped mhUSDC in expired epochs (future "Q3.1 reclaim").
 *   - Multi-operator alert routing (single `OPERATOR_TELEGRAM_CHAT_ID` for v1).
 */
import cron, { type ScheduledTask } from 'node-cron';
import { eq, sql } from 'drizzle-orm';
import { JsonRpcProvider, Wallet, Contract, type Provider } from 'ethers';
import { FheTypes } from '@cofhe/sdk';
import type { Pool } from 'pg';
import type { Address } from 'viem';

/** Inlined from `@muhaven/sdk` — see yield-epoch-runner.ts header for
 *  rationale (backend Dockerfile builds in isolation; workspace
 *  package not reachable). MUST match the runner's constant exactly
 *  or the cron's pre-flight math diverges from the runner's. */
const RATE_SCALE = 1_000_000n;

import { runYieldEpoch, type RunEpochInput } from './yield-epoch-runner.js';
import { createNodeCofheClient } from './node-cofhe-client.js';
import { PgAuditWriter } from '../repository/postgres/pg-audit-writer.js';
import {
  acquireTickLock,
  acquireTokenLock,
} from '../repository/postgres/pg-advisory-lock-handle.js';
import { cronState, rwaTokens } from '../repository/postgres/schema.js';
import type { Db } from '../repository/postgres/db.js';
import type { IRwaTokenRepository } from '../../domain/token-registry/repository/rwa-token.repository.js';
import type { IOracleRepository } from '../../domain/oracle/repository/oracle.repository.js';
import type { NotifyYieldCronFailureUseCase } from '../../application/use-case/operator/notify-yield-cron-failure.use-case.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

const CRON_NAME_TICK = 'yield-distribution';
const CRON_NAME_BOOT_ALERT = 'yield-cron-boot-alert';
const TICK_GUARD_INTERVAL_HOURS = 23;
const BOOT_ALERT_DEBOUNCE_HOURS = 6;
const DEFAULT_CRON_EXPR = '0 0 * * *';
const DEFAULT_TIMEZONE = 'UTC';

/** Six-decimal NAV scale (`oracle_snapshots.nav_dollar` is `numeric(20, 8)`
 *  but the cron multiplies by 1e6 to land in mhUSDC base units). Pulled
 *  to a constant so the ratePerShare math reads symbolically rather
 *  than as a magic number. */
const NAV_USD6_SCALE = 1_000_000n;
const DAYS_PER_YEAR = 365n;

/** Solidity-mirror narrowing bound — see runner B.3 (`yield-epoch-runner.ts`).
 *  We pre-check here too so the cron's per-token skip emits a structured
 *  warn (rather than a runner throw → cron catch path). */
const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

/** Daily-yield-cron-specific error classes used for Telegram-alert
 *  routing. The sanitiser strips err.cause + err.data, so the name is
 *  what operators see in the alert preview. */
export class InsufficientMhusdcFloatError extends Error {
  constructor(symbol: string, tokenAddr: string, balance: bigint, needed: bigint) {
    super(
      `InsufficientMhusdcFloatError(${symbol}=${tokenAddr}): mhUSDC issuer ` +
        `balance ${balance} < encTotalYield ${needed}. Pre-wrap legacy ` +
        `PUSDC → mhUSDC before next tick to clear the warn.`,
    );
    this.name = 'InsufficientMhusdcFloatError';
  }
}
export class StaleNavError extends Error {
  constructor(symbol: string, tokenAddr: string, ageDays: number) {
    super(
      `StaleNavError(${symbol}=${tokenAddr}): latest oracle snapshot is ` +
        `${ageDays.toFixed(1)}d old (> STALE_NAV_HALT_DAYS). Check ` +
        `nav-worker; cron will resume distributions once a fresh snapshot ` +
        `lands.`,
    );
    this.name = 'StaleNavError';
  }
}
export class MissingYieldSnapshotAddressError extends Error {
  constructor(symbol: string, tokenAddr: string) {
    super(
      `MissingYieldSnapshotAddressError(${symbol}=${tokenAddr}): rwa_tokens row ` +
        `has no yield_snapshot_address AND env.YIELD_SNAPSHOT_ADDRESS is unset. ` +
        `Cannot resolve target YieldSnapshot proxy.`,
    );
    this.name = 'MissingYieldSnapshotAddressError';
  }
}

const STABLE_BALANCE_ABI = [
  'function confidentialBalanceOf(address holder) view returns (uint256)',
];

export interface YieldCronConfig {
  rpcUrl: string;
  chainId: number;
  /** EOA whose PK acts as the issuer for fundEpoch. Per Q3_PLAN A.5, this
   *  is the operator-pre-wrapped mhUSDC float holder. */
  privateKey: `0x${string}`;
  /** YieldSnapshot proxy fallback used when a token row has no
   *  `yield_snapshot_address` (legacy seed tokens). */
  defaultYieldSnapshotAddress: Address;
  investorRegistryAddress: Address;
  stableAddress: Address;
  /** Global max-supply cap; per-token overrides via
   *  `rwa_tokens.max_supply_cap_override`. */
  maxSupplyCap: bigint;
  /** NAV-age skip threshold: > this many days → skip token + alert WARN. */
  staleNavHaltDays: number;
  /** node-cron expression; falls back to `'0 0 * * *'` UTC if invalid. */
  cronExpr: string;
  dryRun: boolean;
}

export interface YieldCronDeps {
  pool: Pool;
  db: Db;
  rwaTokenRepo: IRwaTokenRepository;
  oracleRepo: IOracleRepository;
  notifyYieldCronFailure: NotifyYieldCronFailureUseCase;
}

export interface YieldCronTickResult {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export class YieldDistributionCron {
  private readonly logger: Logger;
  private readonly auditWriter: PgAuditWriter;
  private scheduledTask: ScheduledTask | null = null;
  private cofheClient: Awaited<ReturnType<typeof createNodeCofheClient>> | null = null;
  private provider: Provider | null = null;
  private signer: Wallet | null = null;
  private running = false;
  private lastTickAt: Date | null = null;
  private lastResult: YieldCronTickResult | null = null;

  constructor(
    private readonly deps: YieldCronDeps,
    private readonly config: YieldCronConfig,
  ) {
    this.logger = getLogger('YieldDistributionCron');
    this.auditWriter = new PgAuditWriter(deps.db);
  }

  /**
   * Validate the cron expression (fall back to `'0 0 * * *'` on
   * invalid input — explicit warn so operator notices); construct
   * the cofhe client + ethers signer lazily; schedule the node-cron
   * job. Idempotent — re-calling is a no-op when already scheduled.
   */
  async start(): Promise<void> {
    if (this.scheduledTask) {
      this.logger.warn('YieldDistributionCron already running');
      return;
    }
    const expr = cron.validate(this.config.cronExpr)
      ? this.config.cronExpr
      : (() => {
          this.logger.warn(
            { cronExpr: this.config.cronExpr },
            `Invalid cron expression; falling back to "${DEFAULT_CRON_EXPR}"`,
          );
          return DEFAULT_CRON_EXPR;
        })();

    // Bootstrap on-chain clients up front so each tick doesn't pay
    // re-construction cost. The cofhe client also creates a self-
    // permit for the issuer EOA during connect; that permit is the
    // primitive the mhUSDC float pre-flight `decryptForView` relies on.
    this.provider = new JsonRpcProvider(this.config.rpcUrl);
    this.signer = new Wallet(this.config.privateKey, this.provider);
    this.cofheClient = await createNodeCofheClient({
      rpcUrl: this.config.rpcUrl,
      chainId: this.config.chainId,
      privateKey: this.config.privateKey,
    });

    // Seed cron_state rows for the tick guard + boot-alert debounce.
    // ON CONFLICT DO NOTHING so a re-deploy keeps the existing
    // `last_fired_at` (we honor the previous tick's age across
    // container restarts — that's the load-bearing property of the
    // schema-level invariant `DB H-1`).
    //
    // Round-1 Backend-Arch M-3 (2026-05-21): seed the tick row with
    // `NOW() - 25h` so the FIRST scheduled tick after a green-field
    // deploy passes the 23h guard immediately. With the previous
    // `defaultNow()` seed, the first scheduled tick would race the
    // just-inserted row's `NOW()` timestamp + lose, silently
    // delaying the first distribution by 23h.
    //
    // Round-2 Reality M-1 (2026-05-21): also back-date the boot-
    // alert row by 7h. The earlier `defaultNow()` seed contradicted
    // the documented intent — `maybeFireBootAlert`'s 6h debounce
    // rejects rows where `age < 6h`, and a `NOW()`-seeded row has
    // age = 0, so the first-install dry-run boot would silently
    // NOT alert and operator misses the warning until 6h later. The
    // 7h backdate ensures the first boot fires the alert (debounce
    // rolls forward from then).
    const TICK_SEED_BACKDATE_HOURS = 25;
    const BOOT_ALERT_SEED_BACKDATE_HOURS = 7;
    await this.deps.db
      .insert(cronState)
      .values([
        {
          cronName: CRON_NAME_TICK,
          lastFiredAt: new Date(Date.now() - TICK_SEED_BACKDATE_HOURS * 60 * 60 * 1000),
        },
        {
          cronName: CRON_NAME_BOOT_ALERT,
          lastFiredAt: new Date(
            Date.now() - BOOT_ALERT_SEED_BACKDATE_HOURS * 60 * 60 * 1000,
          ),
        },
      ])
      .onConflictDoNothing();

    this.scheduledTask = cron.schedule(expr, () => void this.safeTick(), {
      timezone: DEFAULT_TIMEZONE,
    });
    this.logger.info(
      {
        cronExpr: expr,
        timezone: DEFAULT_TIMEZONE,
        dryRun: this.config.dryRun,
        signer: this.signer.address,
        chainId: this.config.chainId,
        maxSupplyCap: this.config.maxSupplyCap.toString(),
        staleNavHaltDays: this.config.staleNavHaltDays,
      },
      'YieldDistributionCron scheduled',
    );

    // Fire the boot alert ourselves (debounced) so the operator sees
    // "cron is up + in dry-run" on container restart without waiting
    // for the next midnight tick. The 6h `cron_state` row absorbs
    // crash-loops.
    if (this.config.dryRun) {
      await this.maybeFireBootAlert();
    }
  }

  /** Pause the scheduled task. The connected provider + cofhe client
   *  stay alive (cheap to keep, cheap to re-create) — calling
   *  `start()` again resumes from a clean schedule. */
  stop(): void {
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask = null;
      this.logger.info('YieldDistributionCron stopped');
    }
  }

  getStatus() {
    return {
      running: this.scheduledTask !== null,
      polling: this.running,
      signer: this.signer?.address ?? null,
      dryRun: this.config.dryRun,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastResult: this.lastResult,
    };
  }

  /** Top-level error firewall — never throws into node-cron's runtime
   *  (an unhandled rejection in a cron handler is a quiet death;
   *  this catch keeps the schedule running across transient DB
   *  outages). */
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error({ err }, 'YieldDistributionCron tick threw (caught at top level)');
    }
  }

  /**
   * One tick of the cron. Acquires the tick-level advisory lock,
   * applies the 23h atomic-UPDATE guard against `cron_state`, then
   * iterates every active token. Per-token handling lives in
   * `handleToken` for isolation: one token's failure must not stop
   * the rest of the sweep.
   */
  async tick(): Promise<YieldCronTickResult> {
    // Round-1 Code-Reviewer M-1 (2026-05-21): set `running = true`
    // SYNCHRONOUSLY before the first await so two cron firings that
    // arrive in the same microtask tick can't both race past the
    // re-entry check + double-write `lastResult`. The tick advisory
    // lock is a second defence (one wins acquire, the other gets
    // null), but the result-counter race exists between them.
    if (this.running) {
      this.logger.debug('Previous tick still running, skipping');
      return { attempted: 0, succeeded: 0, skipped: 0, failed: 0 };
    }
    this.running = true;
    const result: YieldCronTickResult = { attempted: 0, succeeded: 0, skipped: 0, failed: 0 };
    try {
      const tickLock = await acquireTickLock(this.deps.pool);
      if (!tickLock) {
        this.logger.warn('Tick advisory lock held by another session — skipping tick');
        return result;
      }
      try {
        // I-1: atomic-UPDATE tick guard. Single statement, race-safe.
        // RETURNING `1` lets us distinguish "guard cleared, proceed"
        // (row count = 1) from "another tick won the race in the last
        // 23h" (row count = 0).
        const guardResult = await this.deps.db.execute<{ ok: number }>(sql`
          UPDATE cron_state
          SET last_fired_at = NOW() AT TIME ZONE 'UTC'
          WHERE cron_name = ${CRON_NAME_TICK}
            AND last_fired_at < (NOW() AT TIME ZONE 'UTC') - (${TICK_GUARD_INTERVAL_HOURS}::int * INTERVAL '1 hour')
          RETURNING 1 AS ok
        `);
        // Round-2 DB LOW-2 (2026-05-21): `?? 0` null-coalesce guards
        // against future drizzle/node-pg versions that return `null`
        // rowCount on RETURNING. Current versions (drizzle 0.40 +
        // node-pg 8) return number on UPDATE RETURNING, but the
        // defensive form costs one character + closes the latent gap.
        if ((guardResult.rowCount ?? 0) === 0) {
          this.logger.info('cron_state guard held — already fired in last 23h, skipping');
          return result;
        }

        // Dry-run boot alert (debounced 6h) — fired on every tick
        // start, the cron_state row swallows the repeat firings.
        if (this.config.dryRun) {
          await this.maybeFireBootAlert();
        }

        const tokens = await this.deps.rwaTokenRepo.findByStatus('active');
        if (tokens.length === 0) {
          this.logger.info('No active tokens — tick is a no-op');
          return result;
        }

        // Round-1 Security M-4 (2026-05-21) — multi-token float ledger.
        // Read the issuer's mhUSDC confidential balance ONCE for the
        // sweep; maintain an in-memory `floatRemaining` decremented
        // after each token's `runYieldEpoch` returns success. Without
        // this, every token would see the SAME balance B and pass the
        // pre-flight even when (Σ encTotalYield) > B — silent-failing
        // every token after the first that actually drained the float.
        //
        // Dry-run mode skips the read AND the per-token check entirely
        // (we'd never call fundEpoch, so float accounting is moot).
        let floatRemaining: bigint | null = null;
        if (!this.config.dryRun) {
          floatRemaining = await this.readMhUsdcFloat();
          if (floatRemaining === null) {
            // Read failed — alert already fired inside helper. Skip
            // the whole sweep rather than proceed blind across 11
            // tokens with no float telemetry.
            this.logger.warn(
              'mhUSDC float pre-flight failed at sweep start — skipping entire tick',
            );
            return result;
          }
          this.logger.info(
            { floatRemaining: floatRemaining.toString(), tokenCount: tokens.length },
            'sweep-start mhUSDC float read',
          );
        }
        this.logger.info(
          { count: tokens.length, dryRun: this.config.dryRun },
          `Sweeping ${tokens.length} active token(s)`,
        );
        for (const token of tokens) {
          result.attempted++;
          try {
            const outcome = await this.handleToken(token, {
              get floatRemaining() {
                return floatRemaining;
              },
              consumeFloat(amount: bigint) {
                if (floatRemaining !== null) floatRemaining -= amount;
              },
            });
            if (outcome === 'success') result.succeeded++;
            else if (outcome === 'skipped') result.skipped++;
            else if (outcome === 'failed') result.failed++;
          } catch (err) {
            // handleToken is supposed to swallow its own throws + alert.
            // If something escapes, log + treat as failure but keep
            // going to the next token.
            result.failed++;
            this.logger.error(
              { err, token: token.address, symbol: token.symbol },
              'handleToken escaped — keeping sweep alive',
            );
          }
        }
        return result;
      } finally {
        // Round-1 Code-Reviewer M-3 (2026-05-21): distinguished
        // try/catch around tick-lock release so a thrown release
        // doesn't escape into `safeTick`'s catch with a vague "tick
        // threw" log — the cause matters for triage.
        try {
          await tickLock.release();
        } catch (releaseErr) {
          this.logger.error(
            { err: releaseErr },
            'tickLock.release threw — advisory lock may be leaked until session end',
          );
        }
      }
    } finally {
      this.running = false;
      this.lastTickAt = new Date();
      this.lastResult = result;
    }
  }

  /**
   * Per-token loop body. Acquires the per-token advisory lock; runs
   * the pre-flight skips (no oracle snapshot, NAV stale, missing apy,
   * bounds overflow, mhUSDC float short, missing snapshot proxy);
   * passes the lock to the runner on the happy path. Catches runner
   * throws + routes them to `notifyYieldCronFailure` with `tokenAddress`.
   *
   * Returns the outcome class so the tick's result counters stay
   * accurate.
   */
  private async handleToken(
    token: {
      address: string;
      symbol: string;
      issuerAddress: string;
      yieldSnapshotAddress?: string;
    },
    sweepCtx: {
      readonly floatRemaining: bigint | null;
      consumeFloat(amount: bigint): void;
    },
  ): Promise<'success' | 'skipped' | 'failed'> {
    // Round-1 Backend-Arch H-2 (2026-05-21): null-guard at handleToken
    // entry. If `start()` was never called (test path constructing
    // the cron directly), `signer` / `cofheClient` are null and the
    // runner downstream would throw a confusing NullPointer trace.
    // Explicit refusal here surfaces the misuse loud.
    if (!this.signer || !this.cofheClient) {
      this.logger.error(
        { symbol: token.symbol, token: token.address.toLowerCase() },
        'handleToken called before start() initialised clients — refusing to proceed',
      );
      return 'failed';
    }
    const tokenAddrLower = token.address.toLowerCase();
    const lock = await acquireTokenLock(this.deps.pool, tokenAddrLower);
    if (!lock) {
      this.logger.warn(
        { symbol: token.symbol, token: tokenAddrLower },
        'per-token advisory lock held — skipping (manual script likely running)',
      );
      return 'skipped';
    }

    // Lock ownership: from here through the runner call, the lock is
    // ours OR the runner's. The `finally` block is the belt-and-
    // braces — even if the runner already released, the second call
    // is an idempotent no-op (`PgAdvisoryLockHandle.released` flag).
    try {
      // ── Pre-flight: oracle snapshot freshness ────────────────────
      const snapshot = await this.deps.oracleRepo.findLatestSnapshot(token.symbol);
      if (!snapshot) {
        // Legacy synthetic tokens (TBILL1 / GOLD1) don't appear in
        // oracle_snapshots — skip silently per Q3_PLAN A.3.1.
        // Suppress alert noise; "no oracle catalog membership" is a
        // configuration state, not a runtime failure.
        this.logger.info(
          { symbol: token.symbol, token: tokenAddrLower },
          'no oracle snapshot — skipping (likely legacy synthetic)',
        );
        return 'skipped';
      }
      if (snapshot.apy7Day === null || snapshot.navDollar === null) {
        this.logger.info(
          { symbol: token.symbol, token: tokenAddrLower },
          'apy7Day or navDollar null on latest snapshot — skipping (non-yield-bearing or pre-ingest)',
        );
        return 'skipped';
      }
      const ageDays = (Date.now() - snapshot.snapshotAt.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > this.config.staleNavHaltDays) {
        await this.deps.notifyYieldCronFailure.execute({
          err: new StaleNavError(token.symbol, tokenAddrLower, ageDays),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'warn',
        });
        return 'skipped';
      }

      // ── Compute ratePerShare + encTotalYield + effectiveCap ─────
      // Multiply by `NAV_USD6_SCALE` (1e6) early to land NAV in
      // mhUSDC base units (the on-chain `fundEpoch` expects amounts
      // in 6-decimal stable units); `apy_decimal` is the fractional
      // APY (e.g. `0.0313` for 3.13%). Order of operations chosen so
      // the integer floor on the final divide doesn't drop precision
      // before the multiply.
      const apyDecimal = Number.parseFloat(snapshot.apy7Day) / 100;
      if (!Number.isFinite(apyDecimal) || apyDecimal <= 0) {
        this.logger.warn(
          { symbol: token.symbol, apy7Day: snapshot.apy7Day },
          'apy7Day failed numeric parse or <= 0 — skipping',
        );
        return 'skipped';
      }
      const navDecimal = Number.parseFloat(snapshot.navDollar);
      if (!Number.isFinite(navDecimal) || navDecimal <= 0) {
        this.logger.warn(
          { symbol: token.symbol, navDollar: snapshot.navDollar },
          'navDollar failed numeric parse or <= 0 — skipping',
        );
        return 'skipped';
      }
      const navUsd6 = BigInt(Math.floor(navDecimal * Number(NAV_USD6_SCALE)));
      // `apyDecimal × navUsd6` is bigint-safe via scaled-int: scale
      // apy to int by RATE_SCALE early. Worked example for USYC at
      // 3.13% APY, $1.13 NAV (corrected 2026-05-21 per CR H-1):
      //   apyScaled    = floor(0.0313 × 1_000_000) = 31_300
      //   navUsd6      = floor(1.13   × 1_000_000) = 1_130_000
      //   ratePerShare = floor(31_300 × 1_130_000 / 365)
      //                = floor(35_369_000_000 / 365)
      //                ≈ 96_901_369   (this is `realRate × RATE_SCALE`)
      //
      // UNIT-CONVENTION NOTE (Round-2 Solidity M-3, 2026-05-21):
      // The on-chain claim formula is
      //   `payout = encBalance × ratePerShare / RATE_SCALE`
      // and the YieldSnapshot.sol header (line 190) documents
      // ratePerShare as "PUSDC base units per token base unit × RATE_SCALE".
      // Q3 plan v3's worked example treats `effectiveCap` AND
      // `encBalance` as WHOLE-SHARE counts (no decimals); 100 shares
      // earn $0.00969/day. MuHavenToken.decimals() = 18 in the source
      // — so the runtime behaviour depends on whether seed scripts
      // mint balances in 18-decimal RAW base units or in whole-share
      // counts. Dry-run smoke (Q3_PLAN.md step 5) is the verification
      // gate: in dry-run, every token computes ratePerShare + logs
      // the value; operators eyeball the magnitudes against rwa.xyz
      // reference yields BEFORE flipping YIELD_CRON_DRY_RUN=false.
      // If balances are stored 18-decimal-raw, the current ratePerShare
      // is 1e18 too large — claims would explode astronomically and
      // the uint64-narrowing guard catches it. If they're whole-share,
      // the math matches the plan.
      const apyScaled = BigInt(Math.floor(apyDecimal * Number(RATE_SCALE)));
      if (apyScaled === 0n) {
        // Sub-RATE_SCALE APY — would floor to ratePerShare=0 anyway.
        // Skip with a structured warn (NOT an alert) — operator sees
        // it in logs but no Telegram noise.
        this.logger.warn(
          { symbol: token.symbol, apy7Day: snapshot.apy7Day },
          'apyScaled floored to 0 — would produce zero rate, skipping',
        );
        return 'skipped';
      }
      const ratePerShare = (apyScaled * navUsd6) / DAYS_PER_YEAR;
      if (ratePerShare === 0n) {
        this.logger.warn(
          { symbol: token.symbol, navUsd6: navUsd6.toString(), apyScaled: apyScaled.toString() },
          'ratePerShare floored to 0 — every claim would silent-fail; skipping',
        );
        return 'skipped';
      }
      if (ratePerShare > UINT128_MAX) {
        await this.deps.notifyYieldCronFailure.execute({
          err: new Error(
            `RateOverflowError(${token.symbol}=${tokenAddrLower}): ratePerShare ` +
              `${ratePerShare} > uint128.max. Inputs out of expected envelope.`,
          ),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'error',
        });
        return 'failed';
      }

      // Per-token effective cap; falls back to global. The `rwa_tokens
      // .max_supply_cap_override` column is operator-set via a manual
      // Drizzle UPDATE per Q3_PLAN.md (no UI surface for it today),
      // so reading it on every tick is cheap (single integer column).
      //
      // Round-1 Security M-1 (2026-05-21): clamp override at READ time.
      // The override is set via raw SQL UPDATE — bypasses the zod
      // floor (`min(1n)`) + ceiling (`max(10_000_000_000n)`). If an
      // operator pastes `0` we'd silently produce `encTotalYield = 0n`
      // (no skip fires, runner fundEpochs with 0 yield, claimants
      // get nothing). If they paste a typo'd `10^15` the uint64-
      // narrowing guard below catches it but only after wasted work.
      // Per-tick clamp: reject < 1n or > YIELD_CRON_MAX_SUPPLY_CAP →
      // fall back to global + log warn (operator notices via logs).
      const overrideRaw = await this.readMaxSupplyCapOverride(tokenAddrLower);
      let effectiveCap = this.config.maxSupplyCap;
      if (overrideRaw !== null) {
        if (overrideRaw < 1n || overrideRaw > this.config.maxSupplyCap) {
          this.logger.warn(
            {
              symbol: token.symbol,
              token: tokenAddrLower,
              override: overrideRaw.toString(),
              globalCap: this.config.maxSupplyCap.toString(),
            },
            'max_supply_cap_override out of allowed range [1, YIELD_CRON_MAX_SUPPLY_CAP] — falling back to global',
          );
        } else {
          effectiveCap = overrideRaw;
        }
      }
      const encTotalYield = (effectiveCap * ratePerShare) / RATE_SCALE;
      // Solidity narrowing guard — `YieldSnapshot.fundEpoch` narrows
      // input to `euint64` via `FHE.asEuint64`. Above uint64.max →
      // silent truncation on-chain → claims silent-fail to a wrong
      // (small) value. This guard duplicates the runner's B.3 check
      // so the cron's catch path emits the structured warn instead
      // of the runner throw → catch chain.
      if (encTotalYield > UINT64_MAX) {
        await this.deps.notifyYieldCronFailure.execute({
          err: new Error(
            `EncTotalYieldNarrowingOverflowError(${token.symbol}=${tokenAddrLower}): ` +
              `encTotalYield ${encTotalYield} > uint64.max. Lower MAX_SUPPLY_CAP or ` +
              `set rwa_tokens.max_supply_cap_override for this token.`,
          ),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'error',
        });
        return 'failed';
      }
      // Self-review (2026-05-21): defensive — when override=1 + sub-
      // RATE_SCALE ratePerShare (e.g. 0.001% APY token), the floor
      // divide here can land at 0n even though `ratePerShare > 0n`
      // upstream. Without this guard the cron would call fundEpoch
      // with 0 yield: claims would silent-fail to 0 + waste gas.
      // The ratePerShare > 0n check at line 619 was insufficient
      // because it's the cap×rate product that matters.
      if (encTotalYield === 0n) {
        this.logger.warn(
          {
            symbol: token.symbol,
            token: tokenAddrLower,
            effectiveCap: effectiveCap.toString(),
            ratePerShare: ratePerShare.toString(),
          },
          'encTotalYield floored to 0 — sub-RATE_SCALE rate × tight cap; skipping',
        );
        return 'skipped';
      }

      // ── Resolve YieldSnapshot proxy ──────────────────────────────
      const snapshotAddr = (token.yieldSnapshotAddress ?? this.config.defaultYieldSnapshotAddress) as Address;
      if (!snapshotAddr || snapshotAddr === '0x0000000000000000000000000000000000000000') {
        await this.deps.notifyYieldCronFailure.execute({
          err: new MissingYieldSnapshotAddressError(token.symbol, tokenAddrLower),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'error',
        });
        return 'failed';
      }

      // ── mhUSDC float pre-flight (I-5, multi-token-safe) ──────────
      // Round-1 Security M-4 (2026-05-21): use the SWEEP-START
      // balance read instead of decrypting per token. The ledger is
      // decremented after each successful `runYieldEpoch`, so token
      // N sees the float remaining AFTER tokens 1..N-1's funded
      // commitments. Without this, all 11 tokens would see the same
      // balance B and pass the check, but the issuer can only fund
      // floor(B / max(encTotalYield)) of them.
      //
      // Dry-run paths skip the check entirely: `floatRemaining` is
      // `null` on dry-run + we never call fundEpoch, so accounting
      // is moot.
      if (!this.config.dryRun) {
        const remaining = sweepCtx.floatRemaining;
        if (remaining === null) {
          // Sweep-start read failed — caller already alerted + would
          // have skipped the entire sweep. Defensive only.
          return 'skipped';
        }
        if (remaining < encTotalYield) {
          await this.deps.notifyYieldCronFailure.execute({
            err: new InsufficientMhusdcFloatError(
              token.symbol,
              tokenAddrLower,
              remaining,
              encTotalYield,
            ),
            tokenSymbol: token.symbol,
            tokenAddress: tokenAddrLower,
            severity: 'warn',
          });
          return 'skipped';
        }
      }

      // ── Hand off to runner ───────────────────────────────────────
      // Round-1 Code-Reviewer M-5 (2026-05-21): single cast on
      // `logger` (`as unknown as RunEpochInput['logger']` was double-
      // casting unnecessarily; pino's Logger is structurally
      // compatible with `RunnerLogger` modulo the optional `debug`).
      const input: RunEpochInput = {
        symbol: token.symbol,
        tokenAddr: token.address as Address,
        ratePerShare,
        encTotalYield,
        effectiveMaxSupplyCap: effectiveCap,
        navAtTimeUsd: snapshot.navDollar,
        apyAtTimePercent: snapshot.apy7Day,
        snapshotAddr,
        investorRegistryAddr: this.config.investorRegistryAddress,
        pusdcAddr: this.config.stableAddress,
        signer: this.signer,
        cofheClient: this.cofheClient,
        // Cron-specific tighter blast radius (Q3_PLAN.md A.4):
        // 2-day operator grant + post-fund revoke. Round-2 Solidity
        // H-1 (2026-05-21) flagged this as wider than strictly
        // necessary for the once-per-23h tick — a 1h window would
        // suffice for the happy path. The 2d floor is the safety
        // envelope if the post-fund revoke retry exhausts: tighter
        // window + persistent revoke failure = grant dies in &lt; 1h
        // AND next tick reverts NotOperator until operator re-runs
        // wrap-pusdc-only.ts. The plan v3 trades ~22h of extra
        // grant-window for self-healing under transient revoke
        // failure. Re-evaluate post-mainnet when manual revoke
        // restoration is acceptable.
        operatorGrantSeconds: 2n * 24n * 60n * 60n,
        revokeOperatorAfterFund: true,
        dryRun: this.config.dryRun,
        logger: this.logger as RunEpochInput['logger'],
        audit: this.auditWriter,
        tokenLock: lock,
      };
      const result = await runYieldEpoch(input);
      this.logger.info(
        {
          symbol: token.symbol,
          epochId: result.epochId.toString(),
          status: result.status,
          skipReason: result.skipReason,
          fundTxHash: result.fundTxHash,
        },
        'runYieldEpoch returned',
      );
      if (result.status === 'success') {
        // Round-2 Reality B-1 (2026-05-21): decrement ONLY on fresh
        // fund (`'success'`), NOT on `'resumed_success'`. A resumed-
        // success means the on-chain fundEpoch landed on a PRIOR
        // tick — the mhUSDC drain is already reflected in THIS tick's
        // sweep-start `readMhUsdcFloat()`. Decrementing again here
        // double-counts → subsequent tokens see too-low remaining
        // float → spurious InsufficientMhusdcFloatError skips +
        // operator alert noise claiming float is short when it isn't.
        if (!this.config.dryRun) sweepCtx.consumeFloat(encTotalYield);
        return 'success';
      }
      if (result.status === 'resumed_success') {
        // Prior tick's drain already in sweep-start balance — no
        // ledger update needed (see B-1 rationale above).
        //
        // Round-2 Reality H-2 (2026-05-21) — KNOWN accounting drift:
        // when the runner returns the `funded_no_audit` pending-tx
        // skip (`{ status: 'skipped', skipReason: 'orphaned_audit',
        // resumed: true }`), the pending tx hasn't drained on-chain
        // yet → sweep-start balance is PRE-drain. Subsequent tokens
        // in this sweep may over-commit the float (apparent-available
        // exceeds actual-available-once-pending-confirms). Worst case
        // is one token silent-fails for the value of the still-
        // pending epoch — bounded by 1 in-flight epoch per token per
        // sweep. Acceptable: documented for the operator runbook.
        return 'success';
      }
      if (result.status === 'skipped') return 'skipped';
      // Round-2 Reality H-1 (2026-05-21): `'partial'` is declared in
      // the runner's `RunEpochResult.status` union but no return site
      // currently emits it. If a future runner edit DOES emit it
      // (e.g. snapshot_done but fund-phase deferred), the cron MUST
      // surface that loud — not silently bucket it as success.
      // Treat as failure for counter purposes; the runner's own
      // logging covers the why.
      this.logger.error(
        {
          symbol: token.symbol,
          token: tokenAddrLower,
          status: result.status,
          skipReason: result.skipReason,
        },
        'unexpected runYieldEpoch status — treating as failure',
      );
      return 'failed';
    } catch (err) {
      // Runner threw — route through the operator-alert path with
      // tokenAddress so the sanitiser preserves the canonical address
      // form (I-4). The runner already wrote `failure` to the audit
      // row + released the lock; we only handle the user-facing alert.
      await this.deps.notifyYieldCronFailure.execute({
        err,
        tokenSymbol: token.symbol,
        tokenAddress: tokenAddrLower,
        severity: 'error',
      });
      return 'failed';
    } finally {
      // I-3 belt-and-braces. `release()` is idempotent + never-throws.
      await lock.release();
    }
  }

  /**
   * I-5: decrypt the issuer's mhUSDC confidential balance ONCE per
   * sweep via permit-based view. Returns the decrypted balance as a
   * bigint, or `null` on failure (the caller skips the entire sweep
   * rather than ploughing 11 tokens blind).
   *
   * Round-1 Security M-2 (2026-05-21): wraps the `decryptForView`
   * call in a 60s AbortController timeout. The cofhe coprocessor
   * typically responds in &lt;1s; an unbounded await could wedge the
   * cron loop indefinitely if the coprocessor stalls, blocking
   * subsequent tokens AND the next 24h tick (since `running=true`
   * persists across the hang). Timeout-on-stall → alert ERROR →
   * skip sweep → retry next tick.
   */
  private async readMhUsdcFloat(): Promise<bigint | null> {
    if (!this.signer || !this.cofheClient) {
      this.logger.error(
        'readMhUsdcFloat called before start() initialised clients',
      );
      return null;
    }
    const FLOAT_READ_TIMEOUT_MS = 60_000;
    try {
      const stable = new Contract(this.config.stableAddress, STABLE_BALANCE_ABI, this.signer);
      const handle = (await stable.confidentialBalanceOf(this.signer.address)) as bigint;
      // Promise.race-based timeout — the cofhe-sdk's decryptForView
      // doesn't honour AbortController natively, so the race ensures
      // we surface a timeout error even if the underlying request
      // never resolves. The orphaned in-flight request is garbage
      // collected when the cofhe client disconnects on next start().
      const decryptPromise = this.cofheClient
        .decryptForView(handle, FheTypes.Uint64)
        .withPermit()
        .execute();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `mhUSDC float decryptForView timed out after ${FLOAT_READ_TIMEOUT_MS}ms`,
              ),
            ),
          FLOAT_READ_TIMEOUT_MS,
        ),
      );
      // Round-2 Solidity B-1 (2026-05-21) — `confidentialBalanceOf`
      // returns `euint64` per MuHavenStable.sol:561 (NOT euint128 as
      // the cron's earlier draft assumed). The cofhe coprocessor uses
      // the type tag to select the decryption circuit; passing the
      // wrong tag either rejects (best case) or returns garbled bits
      // (worst case → cron silently over-estimates float + the
      // `_silentFailBound`-protected fundEpoch then drops the pull
      // without revert).
      const balance = (await Promise.race([decryptPromise, timeoutPromise])) as bigint;
      return balance;
    } catch (err) {
      this.logger.error(
        { err },
        'mhUSDC float pre-flight threw — alerting + skipping entire sweep',
      );
      await this.deps.notifyYieldCronFailure.execute({
        err: err instanceof Error ? err : new Error(String(err)),
        tokenSymbol: 'YIELD_CRON_FLOAT_READ',
        severity: 'error',
      });
      return null;
    }
  }

  /**
   * Read `rwa_tokens.max_supply_cap_override` for a given token. The
   * column is operator-set (no UI surface today) and rarely populated,
   * so a per-tick single-row read is the cheapest option. Returns
   * `null` when the override is unset → cron falls back to the global
   * `YIELD_CRON_MAX_SUPPLY_CAP`.
   */
  private async readMaxSupplyCapOverride(tokenAddrLower: string): Promise<bigint | null> {
    const rows = await this.deps.db
      .select({ override: rwaTokens.maxSupplyCapOverride })
      .from(rwaTokens)
      .where(eq(sql`lower(${rwaTokens.address})`, tokenAddrLower))
      .limit(1);
    const v = rows[0]?.override;
    if (!v) return null;
    return BigInt(v);
  }

  /**
   * Fire the dry-run boot Telegram alert when the `cron_state` debounce
   * row has aged past 6h. Single-statement atomic UPDATE so a crash-
   * loop can't multi-fire — same pattern as the main tick guard.
   */
  private async maybeFireBootAlert(): Promise<void> {
    try {
      const debounceResult = await this.deps.db.execute<{ ok: number }>(sql`
        UPDATE cron_state
        SET last_fired_at = NOW() AT TIME ZONE 'UTC'
        WHERE cron_name = ${CRON_NAME_BOOT_ALERT}
          AND last_fired_at < (NOW() AT TIME ZONE 'UTC') - (${BOOT_ALERT_DEBOUNCE_HOURS}::int * INTERVAL '1 hour')
        RETURNING 1 AS ok
      `);
      if ((debounceResult.rowCount ?? 0) === 0) {
        this.logger.debug('boot alert debounced (< 6h since last)');
        return;
      }
      await this.deps.notifyYieldCronFailure.execute({
        err: new Error(
          `YieldDistributionCron booted in DRY-RUN mode. No on-chain ` +
            `side effects will fire until YIELD_CRON_DRY_RUN=false. ` +
            `Cron expression: ${this.config.cronExpr}; issuer: ${this.signer?.address ?? 'unknown'}.`,
        ),
        tokenSymbol: 'YIELD_CRON_BOOT',
        severity: 'info',
      });
    } catch (err) {
      // Boot alert is best-effort — never gate cron lifecycle on it.
      this.logger.warn({ err }, 'boot alert path threw — continuing');
    }
  }
}
