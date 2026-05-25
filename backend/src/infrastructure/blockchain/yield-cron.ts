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
 *        the runner. The cron still fires its tick + iterates tokens
 *        + sends a daily heartbeat (debounced 23h via
 *        `cron_state['yield-distribution-heartbeat']` row); the
 *        heartbeat body carries `(DRY-RUN)` so the operator never
 *        loses the "is the cron alive?" signal when flipping live
 *        (2026-05-22 — replaced the pre-existing dry-run-gated
 *        `yield-cron-boot-alert` per operator feedback).
 *
 *   I-7  **`cron_state` rows are owned by the cron — never UPDATE by
 *        hand.** The 23h atomic-UPDATE debounce semantics on
 *        `yield-distribution` + `yield-distribution-heartbeat` rows
 *        are load-bearing: a manual UPDATE to either row's
 *        `last_fired_at` either silently skips the next tick
 *        (advancing the timestamp) or double-fires (rolling it
 *        back). Operator-facing surfaces for manual recovery should
 *        document this; one-shot ops scripts MUST use the same
 *        atomic-UPDATE-with-23h-guard pattern as the cron itself
 *        (DevOps L-2, 2026-05-22).
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
/**
 * cron_state row that gates the daily Telegram heartbeat. One ping per
 * UTC day with a per-tick summary (succeeded / per-reason-skipped /
 * failed counts + dry-run flag). Replaces the pre-2026-05-22
 * `yield-cron-boot-alert` row (Q2 deferred item #1 + operator-feedback:
 * the old boot-alert was DRY-RUN-gated → flipping
 * YIELD_CRON_DRY_RUN=false would silence ALL observability, which is
 * the opposite of what the operator wants for a daily liveness signal).
 *
 * The legacy `yield-cron-boot-alert` row stays in the table after this
 * change — drizzle's declarative push doesn't run data migrations and
 * a dangling row costs nothing. The new heartbeat row is seeded
 * alongside the tick row in `start()`.
 */
const CRON_NAME_HEARTBEAT = 'yield-distribution-heartbeat';
const TICK_GUARD_INTERVAL_HOURS = 23;
/**
 * Heartbeat debounce: 23h matches the tick guard so each midnight UTC
 * tick fires AT MOST one heartbeat (modulo node-cron skew + container
 * restart). Pin to 23h (not 24h) so a tick that fires a few minutes
 * "late" on day N+1 still clears the debounce — same rationale as
 * TICK_GUARD_INTERVAL_HOURS.
 */
const HEARTBEAT_DEBOUNCE_HOURS = 23;
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
/**
 * FU-1 (Wave 5 W2) — the snapshot-funding runner couldn't decrypt the
 * on-chain `encTotalSupply` for sizing (decryptForView timeout / cofhe
 * coprocessor not ready). The runner skips the token WITHOUT funding;
 * the cron raises this so the operator sees the transient. Self-healing:
 * the next tick resumes the finalized-but-unfunded epoch and re-decrypts
 * (encTotalSupply is immutable post-finalize), so a one-tick lag is the
 * worst case. Persistent firing ⇒ investigate the coprocessor / RPC.
 */
export class SnapshotSupplyDecryptError extends Error {
  /**
   * @param persistent true when the skip is for a RESUMED epoch (finalized
   *   on a PRIOR tick). A fresh-finalize decrypt-fail is likely transient
   *   same-tick ACL-propagation lag and self-heals next tick; a resumed one
   *   means the ACL has had ≥1 full tick to propagate and STILL can't be
   *   decrypted — that's structural (un-indexable handle / coprocessor /
   *   RPC), NOT lag, and yield for this token is now STALLED.
   */
  constructor(symbol: string, tokenAddr: string, persistent = false) {
    super(
      persistent
        ? `SnapshotSupplyDecryptError(${symbol}=${tokenAddr}): PERSISTENT — the ` +
            `epoch finalized on a prior tick and encTotalSupply STILL can't be ` +
            `decrypted. This is NOT transient lag; yield for this token is ` +
            `STALLED. Investigate the cofhe coprocessor / RPC, or roll back ` +
            `(YIELD_CRON_SNAPSHOT_FUNDING=false → legacy cap-based funding).`
        : `SnapshotSupplyDecryptError(${symbol}=${tokenAddr}): could not decrypt ` +
            `on-chain encTotalSupply to size the epoch — funding skipped this ` +
            `tick. Likely transient (supply is immutable post-finalize); should ` +
            `self-heal next tick. If it repeats, it's structural — investigate.`,
    );
    this.name = 'SnapshotSupplyDecryptError';
  }
}
/**
 * FU-1 (Wave 5 W2) — snapshot-funding only. The snapshotted supply
 * exceeded `YIELD_CRON_MAX_SUPPLY_CAP`, so the epoch was funded at the
 * CAP CEILING — LESS than the total claimable. Late claimants will
 * silent-fail their claim. This is the cap's intended bound, but it's
 * money-affecting, so the operator must see it: raise the cap. A clamp
 * that fires EVERY tick also flags a decimal-scale mismatch (the on-chain
 * supply lives in a larger unit than the cap envelope assumes — see the
 * UNIT-CONVENTION NOTE in handleToken). WARN, not error — the epoch DID
 * fund (partially); nothing crashed.
 */
export class SnapshotSupplyExceedsCapError extends Error {
  constructor(symbol: string, tokenAddr: string, fundedAmount: bigint, cap: bigint) {
    super(
      `SnapshotSupplyExceedsCapError(${symbol}=${tokenAddr}): snapshot supply ` +
        `exceeded the cap ${cap} — funded the cap ceiling (${fundedAmount} base ` +
        `units), which is BELOW the claimable total. Late claimants will ` +
        `silent-fail. Raise YIELD_CRON_MAX_SUPPLY_CAP (or verify the on-chain ` +
        `supply decimal scale if this fires every tick).`,
    );
    this.name = 'SnapshotSupplyExceedsCapError';
  }
}

/**
 * Daily-heartbeat payload class — named so the operator's Telegram
 * reads `Info: YieldCronHeartbeat` (post-2026-05-22 severity-aware
 * header in operator-alert-transport.ts) instead of `Error: Error` of
 * a raw `new Error(...)`. Not thrown anywhere; only constructed in
 * `maybeFireDailyHeartbeat` to give the sanitiser a meaningful
 * `err.name`.
 *
 * Replaces the pre-2026-05-22 `YieldCronBootAlert` class. The boot
 * alert was DRY-RUN-gated (only fired when YIELD_CRON_DRY_RUN=true),
 * which meant flipping to live mode silenced ALL observability.
 * Heartbeat fires unconditionally; the dry-run state is carried in
 * the message body as `(DRY-RUN)` suffix instead.
 */
export class YieldCronHeartbeat extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YieldCronHeartbeat';
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
  /** FU-1 (Wave 5 W2) — when true, fund each epoch to the ACTUAL
   *  snapshotted supply (`min(decryptedSupply, effectiveCap) × ratePerShare
   *  / RATE_SCALE`) instead of the cleartext cap. The cap stays a safety
   *  ceiling. The runner does the supply decrypt + float check + ledger
   *  decrement post-finalize (the amount isn't known until then); the
   *  cron's own float pre-flight + post-runner consume run only in the
   *  static (cap-based) fallback. `YIELD_CRON_SNAPSHOT_FUNDING`, default
   *  true. */
  snapshotBasedFunding: boolean;
}

export interface YieldCronDeps {
  pool: Pool;
  db: Db;
  rwaTokenRepo: IRwaTokenRepository;
  oracleRepo: IOracleRepository;
  notifyYieldCronFailure: NotifyYieldCronFailureUseCase;
}

/**
 * Per-skip-reason bucket. Operator-facing — the heartbeat body
 * enumerates these so a glance at Telegram tells the operator WHY a
 * token was skipped without log-diving.
 *
 * Buckets (declared narrow to defeat string-typo proliferation):
 *  - `no_holders` — InvestorRegistry.holderCountFor returned 0 (most
 *    common today; the 7 yield-bearing RWAs all sit at holderCount=0
 *    pre-launch).
 *  - `missing_nav` — oracle snapshot's apy7Day or navDollar is null
 *    (non-yield-bearing token like NVDAon / MUon / STRCx / TSLAx).
 *  - `stale_nav` — NAV age > staleNavHaltDays (fires WARN alert).
 *  - `no_oracle_snapshot` — token has no row in oracle_snapshots
 *    (legacy TBILL1/GOLD1 synthetics; correct to skip silently).
 *  - `lock_busy` — per-token advisory lock held (operator running a
 *    manual script in parallel).
 *  - `parse_error` — apy/nav numeric parse failed OR ≤ 0 (true data
 *    error: oracle delivered something that isn't a positive
 *    decimal).
 *  - `zero_yield` — math floored to 0 even though parse succeeded —
 *    `apyScaled === 0n`, `ratePerShare === 0n`, or
 *    `encTotalYield === 0n`. Operationally distinct from
 *    `parse_error` because the remediation differs: parse_error =
 *    fix the oracle / data ingest; zero_yield = raise the per-token
 *    `max_supply_cap_override` OR accept that the token's rate is
 *    too small to distribute at the current cap (Code-Reviewer H-2,
 *    2026-05-22).
 *  - `pending_fund` — runner's `orphaned_audit` skip (the prior
 *    tick funded on-chain but the audit row write didn't land
 *    before the runner crashed; this tick's pre-resume completes
 *    the audit but doesn't refund). EXPECTED catch-up state, not
 *    anomalous (Code-Reviewer H-1, 2026-05-22).
 *  - `float_short` — issuer mhUSDC float insufficient for the
 *    computed encTotalYield (fires WARN alert). Maps from BOTH the
 *    cron's own pre-flight AND the runner's `insufficient_mhusdc_float`
 *    skip (Code-Reviewer H-1, 2026-05-22).
 *  - `dry_run` — runner returned `skipped: dry_run` (cron is in
 *    dry-run mode).
 *  - `supply_decrypt` — FU-1 snapshot-funding only: the runner could
 *    not decrypt the on-chain `encTotalSupply` to size the epoch
 *    (decryptForView timeout / coprocessor not ready). Fires an ERROR
 *    alert; self-heals next tick (supply is immutable post-finalize).
 *    Maps from the runner's `supply_decrypt_failed` skip.
 *  - `other` — fallback bucket; an unexpected runner-side skip
 *    reason that doesn't map to the above. Surfaces as a warn in the
 *    log so future drift can be promoted to a named bucket.
 */
export type YieldCronSkipReason =
  | 'no_holders'
  | 'missing_nav'
  | 'stale_nav'
  | 'no_oracle_snapshot'
  | 'lock_busy'
  | 'parse_error'
  | 'zero_yield'
  | 'pending_fund'
  | 'float_short'
  | 'dry_run'
  | 'supply_decrypt'
  | 'other';

const ALL_SKIP_REASONS: readonly YieldCronSkipReason[] = [
  'no_holders',
  'missing_nav',
  'stale_nav',
  'no_oracle_snapshot',
  'lock_busy',
  'parse_error',
  'zero_yield',
  'pending_fund',
  'float_short',
  'dry_run',
  'supply_decrypt',
  'other',
];

export interface YieldCronTickResult {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** Per-skip-reason counts. Sum across all keys equals `skipped`.
   *  Surfaced in the daily Telegram heartbeat body. */
  skipReasons: Record<YieldCronSkipReason, number>;
}

function emptySkipReasons(): Record<YieldCronSkipReason, number> {
  const out = {} as Record<YieldCronSkipReason, number>;
  for (const r of ALL_SKIP_REASONS) out[r] = 0;
  return out;
}

/**
 * Per-token handler outcome. Discriminated on `kind` so the tick
 * aggregator can bucket per-reason skip counts for the daily heartbeat.
 * Failed and success outcomes carry no extra data — failures already
 * fire their own Telegram alert via `notifyYieldCronFailure`, and the
 * success count is read from `result.succeeded`.
 */
type HandleTokenOutcome =
  | { kind: 'success' }
  | { kind: 'failed' }
  | { kind: 'skipped'; reason: YieldCronSkipReason };

/**
 * Bucket a runner-reported `skipReason` string into the cron's
 * operator-facing skip enum. The runner's `RunEpochSkipReason` union
 * is `'no_holders' | 'insufficient_mhusdc_float' | 'orphaned_audit' |
 * 'dry_run'` (see `yield-epoch-runner.ts`).
 *
 * Mapping (Code-Reviewer H-1, 2026-05-22):
 *  - `no_holders` → `no_holders` (operator's most common heartbeat row)
 *  - `dry_run` → `dry_run`
 *  - `insufficient_mhusdc_float` → `float_short` (peer of the cron's
 *    own pre-flight `float_short` skip — same root cause, same
 *    remediation; pre-fix this collapsed into `other` and hid the
 *    signal)
 *  - `orphaned_audit` → `pending_fund` (the funded-but-no-audit
 *    catch-up state; EXPECTED in prod after a runner crash mid-fund
 *    + restart, NOT anomalous — pre-fix this hid as `other`)
 *  - anything else → `other` (true unknown — surfaces as a warn in
 *    log + non-zero `other` count in heartbeat tells operator to
 *    audit a future runner refactor)
 */
function bucketRunnerSkipReason(reason: string | undefined): YieldCronSkipReason {
  switch (reason) {
    case 'dry_run':
      return 'dry_run';
    case 'no_holders':
      return 'no_holders';
    case 'insufficient_mhusdc_float':
      return 'float_short';
    case 'orphaned_audit':
      return 'pending_fund';
    // FU-1 (Wave 5 W2) — snapshot-funding runner skips:
    case 'supply_decrypt_failed':
      return 'supply_decrypt';
    case 'zero_snapshot_yield':
      // Same operator remediation as the cap-based zero (tiny supply ×
      // sub-scale rate); reuse the existing log-only bucket.
      return 'zero_yield';
    default:
      return 'other';
  }
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

    // Seed cron_state rows for the tick guard + heartbeat debounce.
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
    // The heartbeat row uses the same 25h back-date so the first
    // scheduled tick after a green-field deploy fires the heartbeat
    // immediately. Replaces the pre-2026-05-22 `yield-cron-boot-alert`
    // seed (which was 7h backdated for a 6h debounce) — heartbeat is
    // 23h debounced, so 25h matches the tick row's pattern exactly.
    const TICK_SEED_BACKDATE_HOURS = 25;
    await this.deps.db
      .insert(cronState)
      .values([
        {
          cronName: CRON_NAME_TICK,
          lastFiredAt: new Date(Date.now() - TICK_SEED_BACKDATE_HOURS * 60 * 60 * 1000),
        },
        {
          cronName: CRON_NAME_HEARTBEAT,
          lastFiredAt: new Date(Date.now() - TICK_SEED_BACKDATE_HOURS * 60 * 60 * 1000),
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
        snapshotBasedFunding: this.config.snapshotBasedFunding,
        signer: this.signer.address,
        chainId: this.config.chainId,
        maxSupplyCap: this.config.maxSupplyCap.toString(),
        staleNavHaltDays: this.config.staleNavHaltDays,
      },
      'YieldDistributionCron scheduled',
    );
    // No start-time Telegram alert. Pre-2026-05-22 this fired a
    // `YieldCronBootAlert` (dry-run only). That message has been
    // replaced by the unconditional daily heartbeat that fires from
    // INSIDE the tick (`tick()` → `maybeFireDailyHeartbeat(result)`),
    // so every UTC day operator sees one ping with sweep summary +
    // dry-run state — far higher signal than a per-restart "cron is
    // in dry-run" reminder. Container restarts are visible in docker
    // logs + `getStatus()` for diagnostic purposes; no Telegram noise
    // on every restart.
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
      return {
        attempted: 0,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        skipReasons: emptySkipReasons(),
      };
    }
    this.running = true;
    const result: YieldCronTickResult = {
      attempted: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      skipReasons: emptySkipReasons(),
    };
    // Tick-guard-cleared flag — set true after the 23h cron_state
    // UPDATE clears. The heartbeat call sits in the `finally` of the
    // tick-lock try so EVERY post-guard-cleared exit path fires it
    // (Backend-Architect H-2 + self-spotted concern, 2026-05-22):
    // pre-fix, the heartbeat was placed AFTER the for-loop, so the
    // early-return paths for "no active tokens" and "float-preflight
    // failed" silently consumed the day's heartbeat slot. Now any
    // exit AFTER the 23h guard clears (sweep-completed, no-active-
    // tokens, float-preflight-failed, mid-sweep early-return) fires
    // the heartbeat exactly once.
    //
    // Cases that intentionally do NOT fire:
    //   - tickLock null (some other process holds the lock — that
    //     process will fire its own heartbeat).
    //   - 23h tick-guard not cleared (another tick already fired
    //     within the last 23h; heartbeat row debounce will also
    //     reject so a double-fire here would be a no-op anyway, but
    //     the explicit gate avoids the wasted SELECT).
    let tickGuardCleared = false;
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
        tickGuardCleared = true;

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
        // Sweep float ledger — shape matches the runner's `floatLedger`
        // interface so `handleToken` forwards it straight through. In
        // snapshot-funding mode the RUNNER reads `remaining` + calls
        // `consume()` post-finalize (the amount isn't known until then);
        // in the static fallback the cron drives both itself.
        const floatLedger = {
          get remaining(): bigint | null {
            return floatRemaining;
          },
          consume(amount: bigint): void {
            if (floatRemaining !== null) floatRemaining -= amount;
          },
        };
        for (const token of tokens) {
          result.attempted++;
          try {
            const outcome = await this.handleToken(token, floatLedger);
            if (outcome.kind === 'success') result.succeeded++;
            else if (outcome.kind === 'skipped') {
              result.skipped++;
              result.skipReasons[outcome.reason]++;
            } else if (outcome.kind === 'failed') result.failed++;
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
        // Heartbeat fires from the outer `finally` (see
        // `tickGuardCleared` flag declaration above), so every
        // post-guard-cleared exit path is covered — including the
        // for-loop natural completion that lands here.
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
      // Heartbeat: fires from the outer `finally` so every exit path
      // that cleared the tick guard sends one Telegram ping per UTC
      // day (cron_state row debounce gives the deduplication). The
      // `maybeFireDailyHeartbeat` helper is self-protecting (its own
      // try/catch swallows errors so the outer `finally` never
      // re-throws). Skipped when tick guard didn't clear (another
      // tick already won the day) OR tickLock was held (other process
      // owns the heartbeat for this day).
      if (tickGuardCleared) {
        await this.maybeFireDailyHeartbeat(result);
      }
    }
  }

  /**
   * Per-token loop body. Acquires the per-token advisory lock; runs
   * the pre-flight skips (no oracle snapshot, NAV stale, missing apy,
   * bounds overflow, mhUSDC float short, missing snapshot proxy);
   * passes the lock to the runner on the happy path. Catches runner
   * throws + routes them to `notifyYieldCronFailure` with `tokenAddress`.
   *
   * Returns a discriminated outcome so the tick can both update its
   * 3-counter result AND aggregate per-skip-reason counts for the
   * daily heartbeat body (2026-05-22 — was a string union pre that).
   */
  private async handleToken(
    token: {
      address: string;
      symbol: string;
      issuerAddress: string;
      yieldSnapshotAddress?: string;
    },
    floatLedger: {
      readonly remaining: bigint | null;
      consume(amount: bigint): void;
    },
  ): Promise<HandleTokenOutcome> {
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
      return { kind: 'failed' };
    }
    const tokenAddrLower = token.address.toLowerCase();
    const lock = await acquireTokenLock(this.deps.pool, tokenAddrLower);
    if (!lock) {
      this.logger.warn(
        { symbol: token.symbol, token: tokenAddrLower },
        'per-token advisory lock held — skipping (manual script likely running)',
      );
      return { kind: 'skipped', reason: 'lock_busy' };
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
        return { kind: 'skipped', reason: 'no_oracle_snapshot' };
      }
      if (snapshot.apy7Day === null || snapshot.navDollar === null) {
        this.logger.info(
          { symbol: token.symbol, token: tokenAddrLower },
          'apy7Day or navDollar null on latest snapshot — skipping (non-yield-bearing or pre-ingest)',
        );
        return { kind: 'skipped', reason: 'missing_nav' };
      }
      const ageDays = (Date.now() - snapshot.snapshotAt.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > this.config.staleNavHaltDays) {
        await this.deps.notifyYieldCronFailure.execute({
          err: new StaleNavError(token.symbol, tokenAddrLower, ageDays),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'warn',
        });
        return { kind: 'skipped', reason: 'stale_nav' };
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
        return { kind: 'skipped', reason: 'parse_error' };
      }
      const navDecimal = Number.parseFloat(snapshot.navDollar);
      if (!Number.isFinite(navDecimal) || navDecimal <= 0) {
        this.logger.warn(
          { symbol: token.symbol, navDollar: snapshot.navDollar },
          'navDollar failed numeric parse or <= 0 — skipping',
        );
        return { kind: 'skipped', reason: 'parse_error' };
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
        return { kind: 'skipped', reason: 'zero_yield' };
      }
      const ratePerShare = (apyScaled * navUsd6) / DAYS_PER_YEAR;
      if (ratePerShare === 0n) {
        this.logger.warn(
          { symbol: token.symbol, navUsd6: navUsd6.toString(), apyScaled: apyScaled.toString() },
          'ratePerShare floored to 0 — every claim would silent-fail; skipping',
        );
        return { kind: 'skipped', reason: 'zero_yield' };
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
        return { kind: 'failed' };
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
      // Cap-based estimate. In SNAPSHOT mode this is only the audit-insert
      // estimate (the runner re-stamps the actual at snapshot_done); in
      // STATIC mode it's the funded amount.
      const encTotalYield = (effectiveCap * ratePerShare) / RATE_SCALE;
      // Solidity narrowing guard — `YieldSnapshot.fundEpoch` narrows
      // input to `euint64` via `FHE.asEuint64`. Above uint64.max →
      // silent truncation on-chain → claims silent-fail to a wrong
      // (small) value. This guard duplicates the runner's B.3 check
      // so the cron's catch path emits the structured warn instead
      // of the runner throw → catch chain.
      //
      // FU-1 (Wave 5 W2): SKIP this pre-fail in snapshot mode. There the
      // cap is just a CEILING — the funded amount is `min(supply, cap) ×
      // rate`, which is ≤ the cap-based estimate. Failing the token on a
      // large-cap estimate would defeat FU-1's "raise the cap, stop
      // tuning" benefit (a $10B ceiling with a tiny real supply would
      // spuriously fail here). The runner does the AUTHORITATIVE uint64
      // guard on the actual sized amount instead.
      if (!this.config.snapshotBasedFunding && encTotalYield > UINT64_MAX) {
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
        return { kind: 'failed' };
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
        return { kind: 'skipped', reason: 'zero_yield' };
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
        return { kind: 'failed' };
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
      //
      // FU-1 (Wave 5 W2): in SNAPSHOT-funding mode this check moves
      // INTO the runner — the amount to compare against
      // (`min(decryptedSupply, cap) × rate`) isn't known until after
      // openEpoch→snapshot→finalize, which happens inside the runner.
      // The cron forwards `floatLedger` so the runner reads the same
      // sweep-start balance + decrements it. This pre-flight + the
      // post-runner `consumeFloat` below run ONLY in the static
      // (cap-based) fallback.
      if (!this.config.snapshotBasedFunding && !this.config.dryRun) {
        const remaining = floatLedger.remaining;
        if (remaining === null) {
          // Sweep-start read failed — caller already alerted + would
          // have skipped the entire sweep. Defensive only.
          return { kind: 'skipped', reason: 'float_short' };
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
          return { kind: 'skipped', reason: 'float_short' };
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
        // FU-1 (Wave 5 W2): snapshot-based fund sizing. When on, the
        // runner decrypts the on-chain encTotalSupply post-finalize and
        // funds `min(supply, effectiveCap) × rate` instead of the
        // cap-based `encTotalYield` above (which becomes the audit-row
        // estimate). The runner also owns the float check + ledger
        // decrement in this mode (see the gated pre-flight above).
        snapshotBasedFunding: this.config.snapshotBasedFunding,
        floatLedger,
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
      // FU-1 (Wave 5 W2): the runner funded at the CAP ceiling because the
      // snapshot supply exceeded the cap — funded LESS than claimable, so
      // late claimants silent-fail. WARN the operator (raise the cap; or, if
      // it fires every tick, the on-chain supply decimal scale is off). Set
      // only on a funded success/resumed_success.
      if (result.clampedToCapCeiling) {
        await this.deps.notifyYieldCronFailure.execute({
          err: new SnapshotSupplyExceedsCapError(
            token.symbol,
            tokenAddrLower,
            result.computedYield ?? 0n,
            effectiveCap,
          ),
          tokenSymbol: token.symbol,
          tokenAddress: tokenAddrLower,
          severity: 'warn',
        });
      }
      if (result.status === 'success') {
        // Round-2 Reality B-1 (2026-05-21): decrement ONLY on fresh
        // fund (`'success'`), NOT on `'resumed_success'`. A resumed-
        // success means the on-chain fundEpoch landed on a PRIOR
        // tick — the mhUSDC drain is already reflected in THIS tick's
        // sweep-start `readMhUsdcFloat()`. Decrementing again here
        // double-counts → subsequent tokens see too-low remaining
        // float → spurious InsufficientMhusdcFloatError skips +
        // operator alert noise claiming float is short when it isn't.
        //
        // FU-1 (Wave 5 W2): in snapshot-funding mode the RUNNER already
        // decremented the ledger by the amount it actually funded
        // (`result.computedYield`) — decrementing here too would
        // double-count. So this static-path decrement is gated off in
        // snapshot mode. (Snapshot mode also uses the actual funded
        // amount, not the cap-based `encTotalYield` estimate.)
        if (!this.config.snapshotBasedFunding && !this.config.dryRun) {
          floatLedger.consume(encTotalYield);
        }
        return { kind: 'success' };
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
        return { kind: 'success' };
      }
      if (result.status === 'skipped') {
        // FU-1 (Wave 5 W2): the snapshot-funding runner owns two skips
        // that warrant an operator alert (the cap-based path fired
        // these from the cron's own pre-flight). Fire them here, then
        // bucket as usual. `zero_snapshot_yield` stays log-only (mirrors
        // the cap-based `zero_yield` skip — no Telegram noise).
        if (result.skipReason === 'insufficient_mhusdc_float') {
          await this.deps.notifyYieldCronFailure.execute({
            err: new InsufficientMhusdcFloatError(
              token.symbol,
              tokenAddrLower,
              // `floatRemaining`/`computedYield` are set by the runner on
              // this skip; `?? 0n` is a defensive floor for the alert copy.
              result.floatRemaining ?? 0n,
              result.computedYield ?? 0n,
            ),
            tokenSymbol: token.symbol,
            tokenAddress: tokenAddrLower,
            severity: 'warn',
          });
        } else if (result.skipReason === 'supply_decrypt_failed') {
          // `result.resumed === true` ⇒ the epoch finalized on a PRIOR tick
          // and still can't be decrypted → persistent (structural), not
          // same-tick lag. Word the alert so the operator triages it as
          // "halt + roll back" rather than "wait it out" (Reality Checker
          // GAP-1 tail risk, FU-1 review round 2).
          await this.deps.notifyYieldCronFailure.execute({
            err: new SnapshotSupplyDecryptError(
              token.symbol,
              tokenAddrLower,
              result.resumed === true,
            ),
            tokenSymbol: token.symbol,
            tokenAddress: tokenAddrLower,
            severity: 'error',
          });
        }
        return {
          kind: 'skipped',
          reason: bucketRunnerSkipReason(result.skipReason),
        };
      }
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
      return { kind: 'failed' };
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
      return { kind: 'failed' };
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
    // Cleared in the finally so the 60s timer doesn't dangle on the
    // success path (FU-1 review M-3, 2026-05-25 — same fix applied to the
    // runner's encTotalSupply decrypt).
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
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
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                `mhUSDC float decryptForView timed out after ${FLOAT_READ_TIMEOUT_MS}ms`,
              ),
            ),
          FLOAT_READ_TIMEOUT_MS,
        );
      });
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
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
   * Fire the daily Telegram heartbeat at the end of a tick. Dedup'd
   * via `cron_state.yield-distribution-heartbeat` row (23h debounce
   * via single-statement atomic UPDATE — same pattern as the main
   * tick guard, prevents a crash-loop tick from multi-firing the
   * heartbeat across multiple restarts in one day).
   *
   * Replaces the pre-2026-05-22 dry-run-gated `maybeFireBootAlert`.
   * The heartbeat fires UNCONDITIONALLY (dry-run or live); dry-run
   * state is carried in the body as a `(DRY-RUN)` suffix so the
   * operator's "is the cron alive?" signal survives the flip to live
   * mode (operator feedback 2026-05-22: "I wouldn't want to lose
   * receiving the message").
   *
   * The body enumerates the sweep result (succeeded / per-reason-
   * skipped / failed counts) so a glance at Telegram tells the
   * operator both "cron is alive" AND "here's what it did", without
   * SSHing to the homelab for log triage. Per-reason skip buckets
   * make anomalies (e.g. `no_holders` dropping while `parse_error`
   * spikes) operator-visible without log-diving.
   *
   * **Order-of-operations (Backend-Architect H-1, 2026-05-22 review):**
   * notify FIRST, UPDATE the debounce row only on success. The
   * pre-fix order (UPDATE then notify) silent-skipped the next 23h
   * window on any transport throw — debounce row already advanced
   * but operator never got the ping. The reverse order accepts the
   * inverse failure mode (notify succeeds but UPDATE fails → next
   * tick fires a duplicate ping); that's strictly less bad than a
   * silent day, and the per-tick-guard 23h debounce gives at most
   * one duplicate.
   */
  private async maybeFireDailyHeartbeat(result: YieldCronTickResult): Promise<void> {
    try {
      // Step 1 — claim eligibility WITHOUT consuming the debounce row.
      // Read-only SELECT against the current state.
      const eligibility = await this.deps.db.execute<{ eligible: boolean }>(sql`
        SELECT (last_fired_at < (NOW() AT TIME ZONE 'UTC') - (${HEARTBEAT_DEBOUNCE_HOURS}::int * INTERVAL '1 hour'))
               AS eligible
        FROM cron_state
        WHERE cron_name = ${CRON_NAME_HEARTBEAT}
      `);
      const eligible = eligibility.rows?.[0]?.eligible === true;
      if (!eligible) {
        this.logger.debug('heartbeat debounced (< 23h since last)');
        return;
      }
      // Step 2 — emit Telegram FIRST. If this throws, we never
      // advance the debounce row, so the next tick retries.
      const body = composeHeartbeatBody(result, this.config.dryRun);
      // Pass signer address as `tokenAddress` so the sanitiser
      // preserves it in the body's known-token allowlist instead of
      // redacting it (Round-1 Security M-5 sentinel-preservation
      // path). The signer EOA isn't strictly a "token" but the
      // sanitiser's allowlist keys on tokenAddress regardless.
      await this.deps.notifyYieldCronFailure.execute({
        err: new YieldCronHeartbeat(body),
        tokenSymbol: 'YIELD_CRON_HEARTBEAT',
        ...(this.signer?.address
          ? { tokenAddress: this.signer.address.toLowerCase() }
          : {}),
        severity: 'info',
      });
      // Step 3 — notify succeeded, advance the debounce row. Atomic
      // UPDATE with the 23h guard still in the WHERE clause so a
      // concurrent restart-induced tick that already advanced the
      // row doesn't get clobbered (idempotent: row stays at the
      // most-recent fire time either way).
      await this.deps.db.execute(sql`
        UPDATE cron_state
        SET last_fired_at = NOW() AT TIME ZONE 'UTC'
        WHERE cron_name = ${CRON_NAME_HEARTBEAT}
          AND last_fired_at < (NOW() AT TIME ZONE 'UTC') - (${HEARTBEAT_DEBOUNCE_HOURS}::int * INTERVAL '1 hour')
      `);
    } catch (err) {
      // Heartbeat is best-effort — never gate cron lifecycle on it.
      // On a notify throw we INTENTIONALLY do NOT advance the row
      // (the UPDATE in step 3 didn't run). Next tick retries.
      this.logger.warn({ err }, 'heartbeat path threw — continuing');
    }
  }
}

/**
 * Render the Telegram-visible heartbeat body from a tick result.
 *
 * Format:
 *   "yield-distribution OK 2026-05-22 (DRY-RUN): 11 swept · 7 no_holders ·
 *    4 missing_nav · 0 distributed · 0 failed. Cron 0 0 * * *."
 *
 * - Only non-zero skip-reason buckets are emitted (keeps the body
 *   under the 1024-char sanitiser cap and reduces visual noise).
 * - When `result.attempted === 0` (no active tokens), the body
 *   reads "no active tokens" instead of "0 swept" — operator's
 *   first-read should be unambiguous.
 * - Dry-run state carried as `(DRY-RUN)` suffix in the date prefix.
 *
 * Pure function (no `this`); hoisted to module scope for testability.
 */
export function composeHeartbeatBody(
  result: YieldCronTickResult,
  dryRun: boolean,
): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dryRunSuffix = dryRun ? ' (DRY-RUN)' : '';
  if (result.attempted === 0) {
    return `yield-distribution OK ${dateStr}${dryRunSuffix}: no active tokens — tick was a no-op.`;
  }
  const parts: string[] = [`${result.attempted} swept`];
  for (const reason of ALL_SKIP_REASONS) {
    const count = result.skipReasons[reason];
    if (count > 0) parts.push(`${count} ${reason}`);
  }
  parts.push(`${result.succeeded} distributed`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  return `yield-distribution OK ${dateStr}${dryRunSuffix}: ${parts.join(' · ')}.`;
}
