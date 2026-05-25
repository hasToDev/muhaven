/**
 * Wave 5 Q3 (v3.1 B.1–B.3) — Shared yield-epoch runner.
 *
 * Extracts the openEpoch → snapshotBatch → finalizeSnapshot → fundEpoch
 * pipeline from `scripts/run-yield-epoch.ts` into a pure function that
 * both the operator-one-off scripts AND the future `YieldDistributionCron`
 * call into. Stays self-contained on purpose:
 *
 *   - Zero relative imports into other backend modules — `RunnerLogger`
 *     is the only injected service (cron passes pino, scripts can pass
 *     a console-shim). This keeps the module re-importable from both
 *     the backend (ESM) and root scripts (CJS / hardhat) without
 *     dragging the whole backend bootstrap chain.
 *   - ethers + `@cofhe/sdk` for on-chain calls; viem's `Address` for
 *     the type-only address brand. The caller constructs the cofhe
 *     client (`createNodeCofheClient` for cron, `createCofheClient(hre,
 *     signer)` for hardhat scripts) and passes it in — the runner is
 *     agnostic to which path produced it.
 *   - `AuditWriter` + `AdvisoryLockHandle` are DI'd. Script use injects
 *     `NoOpAuditWriter` + `NoOpAdvisoryLockHandle`. The cron injects
 *     real Postgres-backed implementations from a later Wave 5 Q3
 *     commit.
 *
 * Invariants enforced HERE (not at the caller):
 *
 *   B.3.1  `ratePerShare === 0n`      → throw `ZeroRateError` BEFORE
 *                                       openEpoch. Every claim would
 *                                       silent-fail to zero.
 *   B.3.2  `ratePerShare > uint128.max` → throw `RateOverflowError`.
 *   B.3.3  `ratePerShare × cap / RATE_SCALE > 2^127`
 *                                       → throw `EncTotalYieldOverflowError`.
 *   A.3.1c `holderCount × 100 > effectiveCap` → return `{ status:
 *                                       'skipped', skipReason: 'cap_vs_supply' }`
 *                                       (Solidity Engineer footgun guard;
 *                                       100× slack absorbs mid-epoch buys).
 *   A.3.5  Empty supply (`holderCount == 0`) → return `{ status:
 *                                       'skipped', skipReason: 'no_holders' }`.
 *                                       NOT a throw — the cron should
 *                                       sweep all tokens then continue.
 *   v3.1 A3 lock ownership — `tokenLock.release()` is called in the
 *                                       `finally` block of `runYieldEpoch`.
 *                                       Caller acquires; runner owns the
 *                                       release contract.
 *
 * Lifecycle (audit row transitions):
 *
 *   pre-openEpoch    : audit.insertInProgress({ status='in_progress' })
 *   post-finalize    : audit.updateStatus(epoch, 'snapshot_done')
 *   post-fundEpoch tx submission, before wait :
 *                      audit.updateStatus(epoch, 'funded_no_audit',
 *                                         { fundEpochTxHash })
 *                      ← this is the "crashed-mid-recover" anchor
 *   post-success     : audit.updateStatus(epoch, 'success',
 *                                         { finishedAt })
 *   on caught throw  : audit.updateStatus(epoch, 'failure',
 *                                         { errorClass, errorMessage })
 *                      then re-throw so caller logs/alerts.
 *
 * KNOWN GAP — silent-fail mhUSDC shortfall on fundEpoch (documented
 *   for the next-commit cron + operator runbook). `MuHavenStable._
 *   doTransfer` applies `_silentFailBound`, so an under-funded issuer
 *   mhUSDC float causes `fundEpoch`'s pull to silent-fail to zero
 *   while the tx receipt reports `status: 1`. The runner's
 *   `funded_no_audit` poll would then close `success`, but conservation
 *   is broken: subsequent claims silent-fail via FHE.sub underflow.
 *
 *   Mitigation in scope of THIS commit: none — Solidity review H-1
 *   (2026-05-20). The runner does not currently verify post-fund
 *   `mhUSDC.confidentialBalanceOf(snapshotAddr)` against the
 *   `encTotalYield` it just submitted. The legacy `scripts/run-yield-
 *   epoch.ts` mitigates operationally by ALWAYS preflight-wrapping
 *   `totalYield` legacy PUSDC → mhUSDC before fundEpoch.
 *
 *   Mitigation in scope of the next commit (cron):
 *     1. Pre-flight assert `mhUSDC.balanceOf(issuer) >= encTotalYield`
 *        before calling fundEpoch — return `skip:
 *        insufficient_mhusdc_float` + Telegram alert (Q3 plan A.5).
 *     2. Permanent operator-pre-wrapped mhUSDC float, not per-run wrap.
 *   Proper structural fix (post-Q3) is `PHASE8_FIX_B_DRAFT.md` — make
 *   fundEpoch loud-revert on shortfall.
 *
 * Resume path (only if `audit.findLatestUnresolved` returns a row):
 *   - The on-chain `currentEpoch[token]` MUST equal the audit row's
 *     epochId. If they diverge, throw `OrphanedAuditError` (cron alerts
 *     + skips token; script bails loud).
 *   - If `Epoch.funded == true` on-chain, the runner additionally
 *     verifies `Epoch.ratePerShare === auditRow.ratePerShare` before
 *     closing `success` — guards against an EOA-compromise window
 *     where someone funded outside the audit-led pipeline with a
 *     different rate (Security review H-1, 2026-05-20).
 *     Mismatch → `RateMismatchOnResumeError` → catch writes `failure`.
 *   - If `auditRow.status === 'funded_no_audit'`, the runner does NOT
 *     re-call `fundEpoch`. It polls the stored `fundEpochTxHash`
 *     receipt: confirmed → close `success`; reverted → throw + close
 *     `failure`; not yet mined → skip this tick, retry next (Code
 *     Review H-1, 2026-05-20).
 *   - The runner uses the audit row's stored `ratePerShare` +
 *     `encTotalYieldUsd6` rather than the inputs — this is the v3.1
 *     idempotency guarantee. Caller's inputs become a recompute sanity
 *     check, not the source of truth.
 */
import { Contract, Interface, ZeroAddress, type ContractRunner } from 'ethers';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import type { Address } from 'viem';

/** Inlined from `@muhaven/sdk` (1e6, mirrors `YieldSnapshot.RATE_SCALE`).
 *  The runner intentionally avoids the workspace-package import: the
 *  backend Dockerfile builds in isolation (no monorepo hoisting), and
 *  `packages/sdk/` is not in `pnpm-workspace.yaml`'s import scope, so
 *  resolving `@muhaven/sdk` from inside the container fails. The
 *  constant is a single bigint — inlining is the lowest-friction
 *  alternative to vendoring the whole sdk into backend deps. */
const RATE_SCALE = 1_000_000n;

/** Lower-cased EVM address. The runner enforces lower-casing at the
 *  audit-write boundary so `tax_events` / `yield_distributions` joins
 *  stay sargable per [[feedback_address_case_at_repo_boundary]]. */
export type LowerAddress = string;

export interface RunnerLogger {
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
  debug?: (obj: object | string, msg?: string) => void;
}

/** Audit row shape the runner reads back during resume detection. */
export interface AuditRow {
  tokenAddress: LowerAddress;
  epochId: bigint;
  ratePerShare: bigint;
  encTotalYieldUsd6: bigint;
  status: AuditStatus;
  /** Set once `updateStatus(... 'funded_no_audit', { fundEpochTxHash })`
   *  has fired. The `funded_no_audit` resume branch uses this to poll
   *  the original tx receipt instead of re-calling `fundEpoch` (Code
   *  Review H-1, 2026-05-20). */
  fundEpochTxHash?: string | null;
}

export type AuditStatus =
  | 'in_progress'
  | 'snapshot_done'
  | 'funded_no_audit'
  | 'success'
  | 'failure';

export interface AuditWriter {
  /** Pre-openEpoch insert: status='in_progress' with the computed math
   *  snapshotted. `tokenAddress` MUST be lower-cased at the write
   *  boundary (the unique constraint relies on this). */
  insertInProgress(row: {
    tokenAddress: LowerAddress;
    epochId: bigint;
    ratePerShare: bigint;
    encTotalYieldUsd6: bigint;
    navAtTimeUsd: string;
    apyAtTimePercent: string;
  }): Promise<void>;

  /** Stage transition. `fields` are merged into the row. */
  updateStatus(
    epochId: bigint,
    tokenAddress: LowerAddress,
    status: AuditStatus,
    fields?: {
      fundEpochTxHash?: string;
      finishedAt?: Date;
      lastResumedAt?: Date;
      errorClass?: string;
      errorMessage?: string;
      /** FU-1 (Wave 5 W2) — overwrite the stored fund amount with the
       *  snapshot-sized ACTUAL once it's computed post-finalize. The
       *  `insertInProgress` write stamps the cap-based ESTIMATE (the
       *  actual supply isn't known until after the snapshot phase); the
       *  runner re-stamps the real `min(supply, cap) × rate / RATE_SCALE`
       *  at the `snapshot_done` transition so the audit trail records
       *  what was actually funded, not the ceiling estimate. */
      encTotalYieldUsd6?: bigint;
    },
  ): Promise<void>;

  /** Latest non-terminal row for a token (status not in
   *  {'success', 'failure'}). Returns null if no resume needed. */
  findLatestUnresolved(tokenAddress: LowerAddress): Promise<AuditRow | null>;
}

/** Token-scoped advisory lock acquired by the caller; the runner OWNS
 *  the `release()` contract in a `finally` block. v3.1 A3. */
export interface AdvisoryLockHandle {
  release(): Promise<void>;
}

export interface RunEpochInput {
  symbol: string;
  tokenAddr: Address;
  /** Per-share daily yield, scaled by RATE_SCALE. */
  ratePerShare: bigint;
  /** mhUSDC committed to the snapshot proxy (base units * 1e6). */
  encTotalYield: bigint;
  /** Per-token effective max supply cap (override ?? global).
   *
   *  Static path: carried for the audit-row trail only — documents what
   *  cap was used to compute `encTotalYield` (`cap × ratePerShare /
   *  RATE_SCALE`).
   *
   *  Snapshot-funding path (FU-1, Wave 5 W2): this is the SAFETY CEILING
   *  for the snapshot-sized amount — the runner funds `min(decryptedSupply,
   *  effectiveMaxSupplyCap) × ratePerShare / RATE_SCALE`. REQUIRED when
   *  `snapshotBasedFunding` is true (the runner throws if it's unset). */
  effectiveMaxSupplyCap?: bigint;

  /** FU-1 (Wave 5 W2) — snapshot-based fund sizing. When true, the runner
   *  IGNORES the static `encTotalYield` input as the fund amount; instead,
   *  post-`finalizeSnapshot` (pre-`fundEpoch`) it decrypts the on-chain
   *  `getEpoch(epochId).encTotalSupply` (issuer-ACL granted in
   *  `finalizeSnapshot`, YieldSnapshot.sol:485) and funds `min(
   *  decryptedSupply, effectiveMaxSupplyCap) × ratePerShare / RATE_SCALE`.
   *  This funds exactly the claimable total per ADR-038 (encTotalSupply ==
   *  sum of snapshot balances), auto-adapting to holders without cap
   *  tuning; the cap stays a ceiling that bounds float exposure.
   *
   *  Requires `effectiveMaxSupplyCap`; requires a `floatLedger` when
   *  `!dryRun`. Decrypt failure → skip (`supply_decrypt_failed`); the
   *  runner NEVER funds blind. `ratePerShare` (cleartext) + per-claim math
   *  are unchanged. Cron + `run-daily-yield` pass true; the legacy hardhat
   *  `run-yield-epoch.ts` does not use this runner so is unaffected. */
  snapshotBasedFunding?: boolean;

  /** FU-1 (Wave 5 W2) — sweep-level issuer mhUSDC float ledger. Read ONCE
   *  at sweep start by the caller; the runner checks `remaining >=
   *  computedAmount` (pre-fund) and calls `consume(computedAmount)` after a
   *  fresh `fundEpoch` settles. Decrement happens HERE (not in the caller)
   *  because snapshot funding only knows the amount post-decrypt, inside
   *  the runner. Required when `snapshotBasedFunding && !dryRun`; a `null`
   *  `remaining` in live mode makes the runner refuse to fund (skips
   *  `insufficient_mhusdc_float`) rather than fund blind. */
  floatLedger?: {
    readonly remaining: bigint | null;
    consume(amount: bigint): void;
  };
  /** Oracle snapshot at the time the rate was computed; written to the
   *  audit row for post-hoc reconcile. Pass empty strings if unknown
   *  (script path may not have these). */
  navAtTimeUsd: string;
  apyAtTimePercent: string;

  /** Contract addresses. */
  snapshotAddr: Address;
  investorRegistryAddr: Address;
  /** Whatever `YieldSnapshot.pusdc()` returns — legacy PUSDC or the
   *  Phase 7.5 wrapper. Read by the caller; passed in so the runner
   *  does not re-resolve. */
  pusdcAddr: Address;

  /** ethers signer (hardhat-style or new ethers.Wallet). The signer's
   *  `address` is the issuer EOA. */
  signer: ContractRunner & { address?: string };
  /** CoFHE node-mode client; constructed via `createNodeCofheClient`
   *  (cron) or `createCofheClient(hre, signer)` (hardhat script). */
  cofheClient: any;

  /** ms; default `365 * 24 * 60 * 60` for script (legacy behavior),
   *  `2 * 24 * 60 * 60` for cron (v3.1 A.4 — tighter blast radius). */
  operatorGrantSeconds?: bigint;
  /** Snapshot batch size; default 50 per existing script. */
  snapshotBatchSize?: number;

  dryRun: boolean;
  logger: RunnerLogger;
  audit: AuditWriter;
  tokenLock: AdvisoryLockHandle;

  /** Whether to revoke `mhUSDC.setOperator(snapshotProxy, 0)` after
   *  fundEpoch. Cron passes true (tighten blast radius); legacy script
   *  passes false (preserves pre-Q3 behavior). v3.1 S6 (cron path only). */
  revokeOperatorAfterFund?: boolean;
}

export type RunEpochSkipReason =
  | 'no_holders'
  | 'insufficient_mhusdc_float'
  | 'orphaned_audit'
  | 'dry_run'
  // FU-1 (Wave 5 W2) — snapshot-funding skips:
  | 'supply_decrypt_failed' // encTotalSupply decryptForView timed out / failed → retry next tick
  | 'zero_snapshot_yield'; // min(supply, cap) × rate floored to 0 → funding 0 would silent-fail claims

export interface RunEpochResult {
  epochId: bigint;
  fundTxHash?: string;
  status: 'success' | 'skipped' | 'resumed_success' | 'partial';
  skipReason?: RunEpochSkipReason;
  resumed: boolean;
  /** FU-1 — the snapshot-sized amount the runner computed (and funded,
   *  on a fresh `success`/`resumed_success`). Also present on the
   *  `insufficient_mhusdc_float` + `zero_snapshot_yield` skips so the
   *  caller can build the operator alert + audit log without re-deriving. */
  computedYield?: bigint;
  /** FU-1 — issuer mhUSDC float remaining at the float check. Present only
   *  on the `insufficient_mhusdc_float` skip (lets the cron compose the
   *  `InsufficientMhusdcFloatError` warn alert with both numbers). */
  floatRemaining?: bigint;
  /** FU-1 — true when the snapshot-sized amount was CLAMPED to the cap
   *  ceiling (`decryptedSupply > cap`). The epoch is funded under the
   *  claimable total → late claimants silent-fail. The caller fires a WARN
   *  (raise the cap, or the on-chain supply is in an unexpected decimal
   *  scale). Set only on a funded `success`/`resumed_success`. */
  clampedToCapCeiling?: boolean;
}

// ── B.3 bounds-check error classes ───────────────────────────────────
//
// Distinct classes so the cron's catch can route them to Telegram
// alerts with specific operator copy (vs. a generic "yield cron failed").

export class ZeroRateError extends Error {
  constructor(symbol: string, tokenAddr: string) {
    super(
      `ZeroRateError(${symbol}=${tokenAddr}): ratePerShare floored to 0; ` +
        `every claim would silent-fail to zero. Inputs likely have apy×nav/365 < 1.`,
    );
    this.name = 'ZeroRateError';
  }
}
export class RateOverflowError extends Error {
  constructor(symbol: string, tokenAddr: string, rate: bigint) {
    super(
      `RateOverflowError(${symbol}=${tokenAddr}): ratePerShare ${rate} > uint128.max. ` +
        `Reject inputs at config-parse time.`,
    );
    this.name = 'RateOverflowError';
  }
}
export class EncTotalYieldNarrowingOverflowError extends Error {
  constructor(symbol: string, tokenAddr: string, encTotalYield: bigint) {
    super(
      `EncTotalYieldNarrowingOverflowError(${symbol}=${tokenAddr}): ` +
        `encTotalYield ${encTotalYield} > uint64.max. ` +
        `YieldSnapshot.fundEpoch narrows the input to euint64 via ` +
        `FHE.asEuint64 — values above 2^64-1 silently truncate to a ` +
        `small number, claims under-pay, no observable error. Reject ` +
        `at the runner boundary instead. (Solidity review M-1, 2026-05-20)`,
    );
    this.name = 'EncTotalYieldNarrowingOverflowError';
  }
}
export class OrphanedAuditError extends Error {
  constructor(symbol: string, auditEpochId: bigint, onChainEpochId: bigint) {
    super(
      `OrphanedAuditError(${symbol}): audit row epochId=${auditEpochId} ≠ ` +
        `on-chain currentEpoch=${onChainEpochId}. Manual cleanup required ` +
        `(mark the audit row 'failure' + retry next tick).`,
    );
    this.name = 'OrphanedAuditError';
  }
}

// v3.1 + Security review H-1 (2026-05-20). When an audit row's stored
// `ratePerShare` diverges from the on-chain `Epoch.ratePerShare` on a
// resume tick, the only sound interpretation is "someone funded this
// epoch outside the audit-led pipeline" — most likely an EOA-compromise
// window between the audit write and the fund tx confirming. Refuse to
// close `success`; alert + leave the audit row in `failure` for manual
// review.
export class RateMismatchOnResumeError extends Error {
  constructor(
    symbol: string,
    epochId: bigint,
    auditRate: bigint,
    onChainRate: bigint,
  ) {
    super(
      `RateMismatchOnResumeError(${symbol}, epoch=${epochId}): audit row ` +
        `ratePerShare=${auditRate} ≠ on-chain ratePerShare=${onChainRate}. ` +
        `Someone funded outside the audit-led pipeline; manual review required.`,
    );
    this.name = 'RateMismatchOnResumeError';
  }
}

// Security review M-3 (2026-05-20). Runner takes `pusdcAddr` as input
// but the canonical source is `YieldSnapshot.pusdc()`. A misconfigured
// caller passing a stale wrapper address would grant operator to the
// wrong contract — silent failure mode. Assert + throw before any
// `setOperator` call.
export class PusdcAddressMismatchError extends Error {
  constructor(symbol: string, expected: string, actual: string) {
    super(
      `PusdcAddressMismatchError(${symbol}): caller passed pusdcAddr=` +
        `${expected} but YieldSnapshot.pusdc()=${actual}. Check Phase-7.5 ` +
        `rotation state (ADR-041).`,
    );
    this.name = 'PusdcAddressMismatchError';
  }
}

// ── No-op implementations for callers without DB / lock backing ──────
//
// Both invariant-preserving: insertInProgress + updateStatus + release
// are all no-ops. `findLatestUnresolved` always returns null — the
// runner falls back to on-chain `currentEpoch[token]` for resume
// detection, which is what the legacy script already does.

export class NoOpAuditWriter implements AuditWriter {
  async insertInProgress(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async findLatestUnresolved(): Promise<AuditRow | null> {
    return null;
  }
}

export class NoOpAdvisoryLockHandle implements AdvisoryLockHandle {
  async release(): Promise<void> {}
}

// ── ABI fixtures (matches the surfaces used in legacy script) ────────
//
// Inline rather than importing from `@muhaven/sdk` so the runner has
// zero workspace-dep build-order surprises. The fragments below must
// stay byte-identical to the on-chain interface — covered by the
// MuHavenSdk integration test suite.

const SNAPSHOT_ABI = [
  'function openEpoch(address token) returns (uint256)',
  'function snapshotBatch(uint256 epochId, address[] investors)',
  'function finalizeSnapshot(uint256 epochId)',
  'function fundEpoch(uint256 epochId, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encTotalYield, uint128 ratePerShare)',
  'function currentEpoch(address token) view returns (uint256)',
  // Tuple field order MUST match `IYieldSnapshot.Epoch` — ethers decodes
  // positionally regardless of named labels.
  'function getEpoch(uint256 epochId) view returns (tuple(address token, uint256 snapshotStartTs, uint256 snapshotEndTs, bool finalized, bool funded, bytes32 encTotalYield, bytes32 encTotalSupply, bytes32 encRatio, uint256 claimExpiry, uint256 holderCount, uint128 ratePerShare))',
];

const REGISTRY_ABI = [
  'function getHoldersPaginated(address token, uint256 offset, uint256 limit) view returns (address[])',
  'function holderCount(address token) view returns (uint256)',
];

const PUSDC_ABI = [
  'function isOperator(address holder, address spender) view returns (bool)',
  'function setOperator(address spender, uint48 until) external',
];

const EPOCH_OPENED_IFACE = new Interface([
  'event EpochOpened(address indexed token, uint256 indexed epochId)',
]);

// ── Main entry point ─────────────────────────────────────────────────

const UINT128_MAX = 2n ** 128n - 1n;
// `YieldSnapshot.fundEpoch` narrows `encTotalYield` to `euint64` via
// `FHE.asEuint64` — see contract `YieldSnapshot.sol`. Values above
// uint64.max get silently truncated by the contract, so the runner
// pre-flight must reject loud at this boundary (Solidity review M-1).
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * FU-1 (Wave 5 W2) — snapshot-based fund sizing. Pure (no I/O) so the
 * math is unit-testable in isolation.
 *
 * Returns the mhUSDC base-unit amount to fund:
 *   `min(decryptedSupply, cap) × ratePerShare / RATE_SCALE`.
 *
 * The `cap` is a SAFETY CEILING that bounds the issuer's float exposure.
 *
 * - Normal case (`decryptedSupply <= cap`, the W1-raised-cap regime): the
 *   amount is `floor(Σ snapshotBalanceᵢ × rate / RATE_SCALE)`. Each
 *   on-chain claim is `floor(balanceᵢ × rate / RATE_SCALE)`, so by
 *   sum-of-floors ≤ floor-of-sum, `Σ claims <= amount` — conservation
 *   holds and the epoch funds exactly the claimable total (zero trapped
 *   float). This is the intended FU-1 behaviour.
 *
 * - Clamp case (`decryptedSupply > cap`, returned `clamped: true`): the
 *   amount is `floor(cap × rate / RATE_SCALE)`, which is STRICTLY LESS
 *   than `floor(supply × rate / RATE_SCALE) >= Σ claims`. So the epoch is
 *   UNDER-funded relative to total claims, and the LAST claimants
 *   silent-fail (the wrapper's `_encRemaining` `FHE.sub` underflows to
 *   zero). This is the deliberate ceiling tradeoff — NOT conservation —
 *   so the caller MUST surface it (we fire a WARN alert): a binding clamp
 *   means "raise the cap" (or, if it binds every tick, the on-chain
 *   supply is in a different decimal scale than the cap envelope — see
 *   the cron's UNIT-CONVENTION NOTE).
 *
 * Callers MUST still apply the uint64-narrowing guard + the zero-amount
 * skip on the returned `amount` (the contract narrows to euint64, and
 * funding 0 silent-fails every claim) — this helper is intentionally
 * total and side-effect-free.
 */
export function sizeSnapshotYield(args: {
  decryptedSupply: bigint;
  cap: bigint;
  ratePerShare: bigint;
}): { sizedSupply: bigint; amount: bigint; clamped: boolean } {
  const clamped = args.decryptedSupply > args.cap;
  const sizedSupply = clamped ? args.cap : args.decryptedSupply;
  const amount = (sizedSupply * args.ratePerShare) / RATE_SCALE;
  return { sizedSupply, amount, clamped };
}

export async function runYieldEpoch(input: RunEpochInput): Promise<RunEpochResult> {
  const {
    symbol,
    tokenAddr,
    ratePerShare,
    encTotalYield,
    snapshotAddr,
    investorRegistryAddr,
    pusdcAddr,
    signer,
    cofheClient,
    dryRun,
    logger,
    audit,
    tokenLock,
  } = input;

  const tokenAddrLower: LowerAddress = String(tokenAddr).toLowerCase();
  const operatorGrantSeconds = input.operatorGrantSeconds ?? 365n * 24n * 60n * 60n;
  const snapshotBatchSize = input.snapshotBatchSize ?? 50;
  const revokeOperatorAfterFund = input.revokeOperatorAfterFund ?? false;
  // FU-1 (Wave 5 W2) — snapshot-based funding mode + sweep float ledger.
  const snapshotBasedFunding = input.snapshotBasedFunding ?? false;
  const floatLedger = input.floatLedger;

  // Tracks the epoch ID once resolved; the catch block uses it to write
  // a `failure` audit row (Backend Arch H-4, 2026-05-20). null if the
  // throw landed before resume detection — no audit row to update.
  let currentEpochId: bigint | null = null;
  // The rate ACTUALLY submitted to fundEpoch. Hoisted to the outer scope
  // (Backend-Arch H-1, FU-1 review 2026-05-25) so the catch-path reconcile
  // can compare the on-chain `ep.ratePerShare` against the rate we funded
  // — NOT the raw input `ratePerShare`. On a resume the funded rate is the
  // STORED `auditRow.ratePerShare`, which (because the cron recomputes the
  // input rate from the current oracle each tick) generally differs from
  // today's input. Comparing the catch reconcile against the input would
  // mis-classify an actually-funded resume epoch as `failure` → next tick
  // opens a FRESH epoch → double-fund. Default to the input rate for the
  // pre-resume / fresh path; reassigned once `auditRow` is known.
  let fundRate: bigint = ratePerShare;

  try {
    // Assert the injected signer has a provider attached — needed by
    // the `funded_no_audit` resume path's `getTransactionReceipt` poll
    // and by the on-chain reconcile in the catch block. The earlier
    // fallback to `snapshot.runner` was dead code (ethers v6 Contract's
    // `runner` IS the signer we passed in, not a provider) — Solidity
    // review M-2 + Reality Checker H2 (2026-05-20).
    const signerProvider = (signer as any).provider;
    if (!signerProvider) {
      throw new Error(
        `runYieldEpoch: signer.provider is null. Inject a connected ` +
          `ethers.Wallet (\`new ethers.Wallet(pk, provider)\`) or a ` +
          `HardhatEthersSigner — bare signers don't support the receipt-` +
          `polling resume path.`,
      );
    }

    // FU-1 (Wave 5 W2) — snapshot funding needs the cap as a safety
    // ceiling. Fail loud at the boundary if the caller forgot it (rather
    // than silently falling through to fund the full decrypted supply).
    if (snapshotBasedFunding && input.effectiveMaxSupplyCap === undefined) {
      throw new Error(
        `runYieldEpoch(${symbol}): snapshotBasedFunding requires ` +
          `effectiveMaxSupplyCap (the min(supply, cap) safety ceiling).`,
      );
    }

    // ── B.3 bounds checks (BEFORE any on-chain side effect) ─────────
    if (ratePerShare === 0n) {
      throw new ZeroRateError(symbol, String(tokenAddr));
    }
    if (ratePerShare > UINT128_MAX) {
      throw new RateOverflowError(symbol, String(tokenAddr), ratePerShare);
    }
    // Hard-tightened from the original `> 2^127` to `> 2^64 - 1` per
    // Solidity review M-1 (2026-05-20). `YieldSnapshot.fundEpoch`
    // narrows the input to `euint64` via `FHE.asEuint64`; the prior
    // 2^127 bound let through values that would silently truncate
    // on-chain and silent-fail every claim.
    //
    // FU-1: in snapshot-funding mode the fund amount isn't the static
    // `encTotalYield` input — it's computed post-finalize from the
    // decrypted supply. The authoritative uint64 guard therefore runs in
    // the fund-sizing block below; the static input is only a cap-based
    // estimate (audit trail), so skipping its guard here is correct.
    if (!snapshotBasedFunding && encTotalYield > UINT64_MAX) {
      throw new EncTotalYieldNarrowingOverflowError(
        symbol,
        String(tokenAddr),
        encTotalYield,
      );
    }

    const snapshot = new Contract(snapshotAddr, SNAPSHOT_ABI, signer);
    const registry = new Contract(investorRegistryAddr, REGISTRY_ABI, signer);
    const pusdc = new Contract(pusdcAddr, PUSDC_ABI, signer);

    // Security review M-3 (2026-05-20) — assert caller's `pusdcAddr`
    // matches what YieldSnapshot will actually pull from. Catches stale
    // Phase-7.5 rotation state before granting operator to the wrong
    // contract. Both sides are EVM addresses; lowercase-compare both so
    // the assertion is case-blind. Phase-7.5 setPUSDC is owner-gated, so
    // the (entry-assert vs fundEpoch-call) TOCTOU is not a daily-cron
    // horizon concern.
    const snapshotPusdc: string = await new Contract(
      snapshotAddr,
      ['function pusdc() view returns (address)'],
      signer,
    ).pusdc();
    if (snapshotPusdc.toLowerCase() !== String(pusdcAddr).toLowerCase()) {
      throw new PusdcAddressMismatchError(symbol, String(pusdcAddr), snapshotPusdc);
    }

    // ── Holder-count preflight ──────────────────────────────────────
    // The v3.1 A.3.1c `holderCount × 100 > effectiveMaxSupplyCap` check
    // was removed in round 2 review: it mixed units (count vs base-units)
    // and was effectively dead code at any realistic supply (Reality
    // Checker H1, 2026-05-20). Real cap-vs-supply protection requires
    // an on-chain supply read which is structurally unavailable in v3
    // (the whole point of the v2 → v3 pivot — supply-free math). The
    // cron-side `STALE_NAV_HALT_DAYS` ceiling + the loud uint64-narrow
    // bound above are the load-bearing footgun guards. The `effective
    // MaxSupplyCap` input is preserved on the interface for the cron
    // commit's audit-row trail (it's how `encTotalYield` was computed).
    const holderCount: bigint = await registry.holderCount(tokenAddr);
    logger.info(
      { symbol, token: tokenAddr, holderCount: holderCount.toString() },
      'runYieldEpoch.preflight',
    );
    if (holderCount === 0n) {
      logger.warn(
        { symbol, token: tokenAddr },
        'no_holders — skipping epoch (matches legacy script throw, but graceful)',
      );
      return { epochId: 0n, status: 'skipped', skipReason: 'no_holders', resumed: false };
    }

    // ── Operator approval on `pusdcAddr` for the snapshot proxy ─────
    const issuerAddr = (signer.address ?? '').toLowerCase();
    const isOp: boolean = await pusdc.isOperator(issuerAddr, snapshotAddr);
    if (!isOp) {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const expiry = nowSec + operatorGrantSeconds;
      // Solidity review L-1 (2026-05-20). `MuHavenStable.isOperator`
      // checks `_operators[holder][spender] > block.timestamp` — a
      // host with bad NTP that hands us a past `expiry` produces a
      // grant that's dead-on-arrival, then `fundEpoch` reverts
      // NotOperator. Catch the bad-clock case loudly here.
      if (operatorGrantSeconds < 60n) {
        throw new Error(
          `Operator grant window too short (${operatorGrantSeconds}s). ` +
            `Min 60s; check NTP on the cron host.`,
        );
      }
      logger.info(
        { symbol, token: tokenAddr, snapshotAddr, expiry: expiry.toString() },
        'granting pusdc operator → YieldSnapshot',
      );
      if (!dryRun) {
        const tx = await sendWithNonceRetry(
          () => (pusdc as any).setOperator(snapshotAddr, expiry),
          { label: 'setOperator(grant)', symbol, logger },
        );
        await tx.wait();
      }
    } else {
      logger.debug?.(
        { symbol, token: tokenAddr },
        'pusdc operator already granted',
      );
    }

    // ── Resume detection: prefer audit row, fall back to on-chain ───
    let epochId: bigint;
    let resumed = false;
    const auditRow = await audit.findLatestUnresolved(tokenAddrLower);
    const currentForToken: bigint = await snapshot.currentEpoch(tokenAddr);

    if (auditRow) {
      // Audit-led resume: the audit row's stored rate is authoritative.
      if (currentForToken !== auditRow.epochId) {
        throw new OrphanedAuditError(symbol, auditRow.epochId, currentForToken);
      }
      const ep = await snapshot.getEpoch(auditRow.epochId);

      if (ep.funded) {
        // Already funded — verify the on-chain rate matches what we
        // stored before closing `success` (Security review H-1: an
        // EOA-compromise window could have caused an off-pipeline fund
        // with a different rate). Block close + raise loud.
        const onChainRate: bigint = ep.ratePerShare;
        if (onChainRate !== auditRow.ratePerShare) {
          throw new RateMismatchOnResumeError(
            symbol,
            auditRow.epochId,
            auditRow.ratePerShare,
            onChainRate,
          );
        }
        logger.warn(
          { symbol, epochId: auditRow.epochId.toString() },
          'audit row open but on-chain epoch already funded — closing audit',
        );
        await audit.updateStatus(auditRow.epochId, tokenAddrLower, 'success', {
          finishedAt: new Date(),
        });
        return {
          epochId: auditRow.epochId,
          status: 'resumed_success',
          resumed: true,
        };
      }

      // Code Review H-1 (2026-05-20). `funded_no_audit` means we
      // submitted `fundEpoch` but crashed/lost-rpc before `tx.wait()`
      // resolved. Re-calling fundEpoch on a soon-to-be-funded epoch is
      // (a) a double-spend / nonce race if the original tx is still
      // pending, or (b) a guaranteed revert if the original confirmed
      // (state guard). Instead: poll the stored tx hash. If confirmed,
      // close `success`. If not yet confirmed, alert + skip the token
      // for THIS tick — the next tick will re-check.
      if (auditRow.status === 'funded_no_audit') {
        const txHash = auditRow.fundEpochTxHash;
        if (!txHash) {
          // Plumbing bug — audit said funded_no_audit but no hash
          // stored. Treat as orphan; manual review needed.
          throw new Error(
            `funded_no_audit row for epoch ${auditRow.epochId} has no ` +
              `fundEpochTxHash — audit writer didn't persist it. Manual ` +
              `cleanup: probe currentEpoch on-chain, then flip row to ` +
              `success/failure.`,
          );
        }
        currentEpochId = auditRow.epochId;
        logger.info(
          { symbol, epochId: auditRow.epochId.toString(), txHash },
          'funded_no_audit resume: polling stored tx receipt',
        );
        // `getTransactionReceipt` returns null if not yet mined.
        // `signerProvider` was asserted non-null at runner entry.
        const rcpt = await signerProvider.getTransactionReceipt(txHash);
        if (rcpt && rcpt.status === 1) {
          await audit.updateStatus(auditRow.epochId, tokenAddrLower, 'success', {
            finishedAt: new Date(),
          });
          logger.info(
            { symbol, epochId: auditRow.epochId.toString() },
            'funded_no_audit resume: tx confirmed — audit closed success',
          );
          return {
            epochId: auditRow.epochId,
            fundTxHash: txHash,
            status: 'resumed_success',
            resumed: true,
          };
        }
        if (rcpt && rcpt.status === 0) {
          // Tx mined but reverted — let the catch path mark `failure`.
          throw new Error(
            `funded_no_audit resume: stored tx ${txHash} reverted on-chain. ` +
              `Manual review required.`,
          );
        }
        // Receipt null → tx not yet mined OR dropped from mempool.
        // Skip THIS tick; let the next tick re-poll. The cron's audit
        // row stays at `funded_no_audit`.
        logger.warn(
          { symbol, epochId: auditRow.epochId.toString(), txHash },
          'funded_no_audit resume: tx not yet mined — skipping this tick',
        );
        return {
          epochId: auditRow.epochId,
          fundTxHash: txHash,
          status: 'skipped',
          skipReason: 'orphaned_audit',
          resumed: true,
        };
      }

      epochId = auditRow.epochId;
      currentEpochId = epochId;
      resumed = true;
      await audit.updateStatus(epochId, tokenAddrLower, auditRow.status, {
        lastResumedAt: new Date(),
      });
      logger.info(
        {
          symbol,
          epochId: epochId.toString(),
          auditStatus: auditRow.status,
          ratePerShareStored: auditRow.ratePerShare.toString(),
        },
        'resuming epoch from audit row (stored rate wins over inputs)',
      );
    } else if (currentForToken > 0n) {
      const ep = await snapshot.getEpoch(currentForToken);
      if (!ep.funded) {
        epochId = currentForToken;
        currentEpochId = epochId;
        resumed = true;
        // Backend Arch H-3 / CR M-1 (2026-05-20) — back-fill the audit
        // row. Without this, downstream `updateStatus('snapshot_done')`
        // silently no-ops on a real writer and the lifecycle marker is
        // lost forever.
        await audit.insertInProgress({
          tokenAddress: tokenAddrLower,
          epochId,
          ratePerShare,
          encTotalYieldUsd6: encTotalYield,
          navAtTimeUsd: input.navAtTimeUsd,
          apyAtTimePercent: input.apyAtTimePercent,
        });
        logger.info(
          {
            symbol,
            epochId: epochId.toString(),
            finalized: ep.finalized,
            holderCount: ep.holderCount.toString(),
          },
          'resuming on-chain epoch (no audit row; back-filled in_progress)',
        );
      } else {
        // Most-recent epoch already funded — open a fresh one.
        epochId = await openEpochAndCapture(
          snapshot,
          tokenAddr,
          logger,
          symbol,
          dryRun,
        );
        currentEpochId = epochId;
        await audit.insertInProgress({
          tokenAddress: tokenAddrLower,
          epochId,
          ratePerShare,
          encTotalYieldUsd6: encTotalYield,
          navAtTimeUsd: input.navAtTimeUsd,
          apyAtTimePercent: input.apyAtTimePercent,
        });
      }
    } else {
      // No prior epoch on-chain — open the first.
      epochId = await openEpochAndCapture(
        snapshot,
        tokenAddr,
        logger,
        symbol,
        dryRun,
      );
      currentEpochId = epochId;
      await audit.insertInProgress({
        tokenAddress: tokenAddrLower,
        epochId,
        ratePerShare,
        encTotalYieldUsd6: encTotalYield,
        navAtTimeUsd: input.navAtTimeUsd,
        apyAtTimePercent: input.apyAtTimePercent,
      });
    }

    // ── Snapshot phase ──────────────────────────────────────────────
    const epochAtSnapshotPhase = await snapshot.getEpoch(epochId);
    if (!epochAtSnapshotPhase.finalized) {
      let captured = 0n;
      for (
        let offset = 0n;
        offset < holderCount;
        offset += BigInt(snapshotBatchSize)
      ) {
        const limit = BigInt(snapshotBatchSize);
        const result = await registry.getHoldersPaginated(tokenAddr, offset, limit);
        // ethers v6 returns a frozen Result proxy; spread to plain array
        // so the contract-arg coercion path doesn't choke.
        const investors: string[] = Array.from(result, (a: unknown) => String(a));
        if (investors.length === 0) break;
        logger.info(
          { symbol, epochId: epochId.toString(), offset: offset.toString(), count: investors.length },
          'snapshotBatch',
        );
        if (!dryRun) {
          const tx = await sendWithNonceRetry(
            () => (snapshot as any).snapshotBatch(epochId, investors),
            { label: 'snapshotBatch', symbol, logger },
          );
          await tx.wait();
        }
        captured += BigInt(investors.length);
      }
      logger.info(
        { symbol, epochId: epochId.toString(), captured: captured.toString() },
        'snapshot phase complete',
      );

      logger.info({ symbol, epochId: epochId.toString() }, 'finalizeSnapshot');
      if (!dryRun) {
        const finTx = await sendWithNonceRetry(
          () => (snapshot as any).finalizeSnapshot(epochId),
          { label: 'finalizeSnapshot', symbol, logger },
        );
        await finTx.wait();
      }
      await audit.updateStatus(epochId, tokenAddrLower, 'snapshot_done');
    } else {
      logger.info(
        { symbol, epochId: epochId.toString() },
        'epoch already finalized — skipping snapshot phase',
      );
    }

    if (dryRun) {
      logger.warn(
        { symbol, epochId: epochId.toString() },
        'dry-run: skipping fundEpoch — DB stays at snapshot_done / in_progress',
      );
      return {
        epochId,
        status: 'skipped',
        skipReason: 'dry_run',
        resumed,
      };
    }

    // ── Fund sizing ─────────────────────────────────────────────────
    // Rate is always the resumed audit row's stored rate if present, else
    // the input (v3.1 idempotency — stored rate wins). Assigned to the
    // outer-scoped `fundRate` so the catch reconcile compares the right
    // value (Backend-Arch H-1).
    fundRate = auditRow?.ratePerShare ?? ratePerShare;

    // The amount funded:
    //  - Static path: the audit row's stored amount (resume) or the
    //    caller's input (`cap × rate / RATE_SCALE`, computed by the caller).
    //  - Snapshot path (FU-1): `min(decryptedSupply, cap) × fundRate /
    //    RATE_SCALE`, where `decryptedSupply` is read from the now-
    //    finalized on-chain `encTotalSupply`. The SUPPLY is re-decrypted
    //    every run (incl. resume) — `encTotalSupply` is immutable
    //    post-finalize (ADR-038) so that recompute is idempotent. The RATE
    //    on a resume is the STORED `auditRow.ratePerShare` (idempotency),
    //    so the sized amount is `fresh_supply × stored_rate` — fresh on
    //    the supply axis, pinned on the rate axis (Backend-Arch M-4).
    let fundEncTotalYield: bigint;
    let clampedToCapCeiling = false;
    if (snapshotBasedFunding) {
      const sized = await sizeAndCheckSnapshotFunding({
        snapshot,
        epochId,
        cap: input.effectiveMaxSupplyCap!,
        ratePerShare: fundRate,
        cofheClient,
        floatLedger,
        resumed,
        symbol,
        tokenAddr: String(tokenAddr),
        tokenAddrLower,
        audit,
        logger,
      });
      // A skip decision short-circuits the fund phase. The audit row stays
      // at `snapshot_done` (no fund); the next tick resumes + retries
      // (decrypt) or re-evaluates (float). Caller alerts on the reason.
      if ('skip' in sized) {
        return {
          epochId,
          status: 'skipped',
          skipReason: sized.skip,
          resumed,
          ...(sized.computedYield !== undefined ? { computedYield: sized.computedYield } : {}),
          ...(sized.floatRemaining !== undefined ? { floatRemaining: sized.floatRemaining } : {}),
        };
      }
      fundEncTotalYield = sized.amount;
      clampedToCapCeiling = sized.clamped;
    } else {
      fundEncTotalYield = auditRow?.encTotalYieldUsd6 ?? encTotalYield;
    }

    logger.info(
      {
        symbol,
        epochId: epochId.toString(),
        ratePerShare: fundRate.toString(),
        encTotalYield: fundEncTotalYield.toString(),
      },
      'encrypting totalYield + calling fundEpoch',
    );
    const [enc] = await cofheClient
      .encryptInputs([Encryptable.uint128(fundEncTotalYield)])
      .setAccount(issuerAddr)
      .execute();
    // FU-4: retry the fundEpoch SEND on a shared-EOA nonce collision (the
    // most expensive tx to lose to the race — a rejected send here would
    // otherwise fail the tick + force a next-tick resume). The retry re-uses
    // the same encrypted input; the audit `funded_no_audit` write below only
    // runs once a send actually succeeds.
    const fundTx = await sendWithNonceRetry(
      () =>
        (snapshot as any).fundEpoch(
          epochId,
          {
            ctHash: enc.ctHash,
            securityZone: enc.securityZone,
            utype: enc.utype,
            signature: enc.signature,
          },
          fundRate,
        ),
      { label: 'fundEpoch', symbol, logger },
    );
    await audit.updateStatus(epochId, tokenAddrLower, 'funded_no_audit', {
      fundEpochTxHash: String(fundTx.hash),
    });
    await fundTx.wait();
    // FU-1 (Wave 5 W2) — decrement the sweep float ledger the MOMENT the
    // on-chain drain is committed (fundTx confirmed), BEFORE the success
    // audit write. Backend-Arch H-2 (2026-05-25): if `updateStatus('success')`
    // throws (DB blip) the in-memory ledger must STILL reflect the drain,
    // else the next token in the sweep over-commits the float against a
    // balance that's already been spent → its `fundEpoch` pull silent-fails
    // (the wrapper's `_silentFailBound`, runner-header KNOWN GAP). Only on a
    // FRESH fundEpoch this tick — the no-fund resume paths returned earlier
    // without touching the ledger; the sweep-start balance already reflects
    // prior-tick drains. Static path has no ledger (gated off in the cron).
    if (snapshotBasedFunding) {
      floatLedger?.consume(fundEncTotalYield);
    }
    await audit.updateStatus(epochId, tokenAddrLower, 'success', {
      finishedAt: new Date(),
    });
    logger.info(
      { symbol, epochId: epochId.toString(), fundTxHash: fundTx.hash },
      'fundEpoch settled',
    );

    // Code Review H-2 (2026-05-20). Revoke is wrapped in its own
    // try/catch — if the on-chain revoke throws, we MUST NOT let the
    // outer catch flip the just-written `success` audit row to
    // `failure`. `revokeOperatorWithRetry` already swallows its own
    // errors, but the explicit wrapper here protects against future
    // edits that make it throw + makes the intent obvious to readers.
    if (revokeOperatorAfterFund) {
      try {
        await revokeOperatorWithRetry(pusdc, snapshotAddr, logger, symbol);
      } catch (revokeErr) {
        logger.error(
          { symbol, revokeErr },
          'revokeOperatorWithRetry threw — operator grant remains until +2d expiry',
        );
      }
    }

    return {
      epochId,
      fundTxHash: String(fundTx.hash),
      status: resumed ? 'resumed_success' : 'success',
      resumed,
      computedYield: fundEncTotalYield,
      ...(clampedToCapCeiling ? { clampedToCapCeiling: true } : {}),
    };
  } catch (err) {
    // Backend Arch H-4 (2026-05-20). Flip the audit row to `failure`
    // when we know the epoch id — keeps the lifecycle invariant honest.
    // If the throw landed before resume-detection (e.g. B.3 bounds
    // check), `currentEpochId` is null and we skip the audit write.
    //
    // Reality Checker M1 (2026-05-20): before writing `failure`, RE-READ
    // the on-chain state. The fundEpoch tx may have already confirmed
    // even though the catch fired (e.g. the throw came from
    // `audit.updateStatus` itself between fundEpoch submission and the
    // post-wait audit write). Writing `failure` on an actually-funded
    // epoch would cause the NEXT tick's `findLatestUnresolved` to
    // return null (terminal status), the on-chain currentEpoch check
    // to see `ep.funded == true`, and the runner to open a FRESH epoch
    // → double-fund. So: if on-chain says funded + rate matches, write
    // `success` instead of `failure`.
    const errClass = err instanceof Error ? err.name : 'UnknownError';
    const errMsg = err instanceof Error ? err.message : String(err);
    if (currentEpochId !== null) {
      try {
        let terminalStatus: AuditStatus = 'failure';
        try {
          const snapshot = new Contract(snapshotAddr, SNAPSHOT_ABI, signer);
          const ep = await snapshot.getEpoch(currentEpochId);
          if (
            ep.funded === true &&
            // Compare against the rate we ACTUALLY funded (Backend-Arch
            // H-1, 2026-05-25). On a resume that's the stored
            // `auditRow.ratePerShare` (== `fundRate`), which differs from
            // today's input `ratePerShare`; comparing the input would
            // mis-classify the funded epoch as `failure` → double-fund.
            (ep.ratePerShare as bigint) === fundRate
          ) {
            terminalStatus = 'success';
            logger.warn(
              {
                symbol,
                currentEpochId: currentEpochId.toString(),
                errClass,
              },
              'catch-path reconcile: on-chain shows funded + rate matches — ' +
                'writing success not failure to prevent double-fund next tick',
            );
          }
        } catch (reconcileErr) {
          // On-chain read failed — stick with the original `failure`
          // verdict. Worst case the next tick sees on-chain funded +
          // audit row in `failure`, which `findLatestUnresolved`
          // excludes from the resume scan; the funded check at branch
          // (b) then catches it via the openEpoch-on-already-funded
          // path. Logged for triage.
          logger.warn(
            { reconcileErr, symbol },
            'catch-path on-chain reconcile failed — defaulting to failure verdict',
          );
        }
        await audit.updateStatus(currentEpochId, tokenAddrLower, terminalStatus, {
          errorClass: errClass.slice(0, 64),
          errorMessage: errMsg.slice(0, 1024),
          finishedAt: new Date(),
        });
      } catch (auditWriteErr) {
        logger.error(
          { auditWriteErr, symbol, currentEpochId: currentEpochId.toString() },
          'failure-path audit.updateStatus threw — row may remain in non-terminal state',
        );
      }
    }
    if (err instanceof Error) {
      logger.error(
        { err, errClass, errMsg, symbol, token: tokenAddr },
        'runYieldEpoch threw — re-raising for caller to alert',
      );
    } else {
      logger.error({ err, symbol, token: tokenAddr }, 'runYieldEpoch threw');
    }
    throw err;
  } finally {
    // v3.1 A3 lock ownership — release in finally so a thrown error
    // can't leak the per-token advisory lock. Caller's
    // `AdvisoryLockHandle.release()` MUST be idempotent + non-throwing.
    try {
      await tokenLock.release();
    } catch (releaseErr) {
      logger.error(
        { releaseErr, symbol },
        'tokenLock.release threw — advisory lock may be leaked',
      );
    }
  }
}

/**
 * FU-1 (Wave 5 W2) — fund-sizing + pre-fund gates for snapshot-based
 * funding. Runs post-`finalizeSnapshot`, pre-`fundEpoch`, ONLY in live
 * mode (dry-run returns before the fund phase, so this is never reached
 * under `dryRun`).
 *
 * Returns either:
 *   - `{ amount }` — proceed to fund this amount (the audit row's stored
 *     `encTotalYieldUsd6` has been re-stamped to it), OR
 *   - `{ skip, computedYield?, floatRemaining? }` — short-circuit (no
 *     fund). The caller surfaces the skip; the next tick resumes the
 *     finalized-but-unfunded epoch and retries.
 *
 * Skip reasons:
 *   - `supply_decrypt_failed` — `encTotalSupply` decryptForView timed out
 *     / failed (the ACL grant may not have propagated to the coprocessor
 *     yet on a same-tick finalize). NEVER fund blind; retry next tick.
 *   - `zero_snapshot_yield`   — `min(supply, cap) × rate` floored to 0;
 *     funding 0 silent-fails every claim.
 *   - `insufficient_mhusdc_float` — issuer float < computed amount (or the
 *     sweep-start float read failed → `remaining === null`).
 */
async function sizeAndCheckSnapshotFunding(args: {
  snapshot: Contract;
  epochId: bigint;
  cap: bigint;
  ratePerShare: bigint;
  cofheClient: any;
  floatLedger?: { readonly remaining: bigint | null; consume(amount: bigint): void };
  resumed: boolean;
  symbol: string;
  tokenAddr: string;
  tokenAddrLower: LowerAddress;
  audit: AuditWriter;
  logger: RunnerLogger;
}): Promise<
  | { amount: bigint; clamped: boolean }
  | { skip: RunEpochSkipReason; computedYield?: bigint; floatRemaining?: bigint }
> {
  const { snapshot, epochId, cap, ratePerShare, cofheClient, floatLedger, symbol, logger } = args;

  // Re-read the now-finalized epoch to get the sealed encTotalSupply
  // handle. ACL to the issuer EOA was granted in finalizeSnapshot
  // (YieldSnapshot.sol:485); the cofhe client's self-permit can read it.
  const finalizedEpoch = await snapshot.getEpoch(epochId);
  const supplyHandleRaw = String(finalizedEpoch.encTotalSupply);
  // Defensive: a zero-hash handle means the snapshot accumulated nothing.
  // Can't happen post-finalize (holderCount > 0 → finalize reverts
  // EmptySnapshot), but never hand a zero handle to decryptForView.
  if (!supplyHandleRaw || /^0x0{64}$/i.test(supplyHandleRaw)) {
    logger.warn(
      { symbol, epochId: epochId.toString() },
      'snapshot funding: encTotalSupply handle is zero post-finalize — skipping (no fund)',
    );
    return { skip: 'supply_decrypt_failed' };
  }

  const decryptedSupply = await decryptSnapshotSupply(
    cofheClient,
    supplyHandleRaw,
    logger,
    symbol,
    epochId,
  );
  if (decryptedSupply === null) {
    return { skip: 'supply_decrypt_failed' };
  }

  const { sizedSupply, amount, clamped } = sizeSnapshotYield({
    decryptedSupply,
    cap,
    ratePerShare,
  });
  logger.info(
    {
      symbol,
      epochId: epochId.toString(),
      decryptedSupply: decryptedSupply.toString(),
      cap: cap.toString(),
      sizedSupply: sizedSupply.toString(),
      computedYield: amount.toString(),
      clamped,
    },
    'snapshot funding: sized epoch to actual on-chain supply',
  );
  if (clamped) {
    // The cap is binding (supply > cap): the epoch funds LESS than the
    // claimable total → late claimants silent-fail. Surface loud (the
    // caller raises a WARN). A clamp that binds EVERY tick also flags the
    // unit-scale hazard (on-chain supply in a different decimal scale than
    // the cap envelope — see the cron's UNIT-CONVENTION NOTE).
    logger.warn(
      {
        symbol,
        epochId: epochId.toString(),
        decryptedSupply: decryptedSupply.toString(),
        cap: cap.toString(),
      },
      'snapshot funding: supply > cap — funding CLAMPED to the ceiling; ' +
        'late claimants will silent-fail. Raise YIELD_CRON_MAX_SUPPLY_CAP ' +
        '(or verify the on-chain supply decimal scale).',
    );
  }

  // Authoritative uint64-narrowing guard on the ACTUAL amount — the
  // contract narrows to euint64 in fundEpoch. `amount <= cap × rate /
  // RATE_SCALE`, which the caller already conservatively pre-checked, so
  // this should never trip; it's the load-bearing guard regardless.
  if (amount > UINT64_MAX) {
    throw new EncTotalYieldNarrowingOverflowError(symbol, args.tokenAddr, amount);
  }
  // Supply-based zero: tiny supply × sub-scale rate floors to 0. Funding 0
  // silent-fails every claim (FHE.sub underflow). Skip log-only (mirrors
  // the cap-based `zero_yield` skip) — no operator alert noise.
  if (amount === 0n) {
    logger.warn(
      {
        symbol,
        epochId: epochId.toString(),
        decryptedSupply: decryptedSupply.toString(),
        ratePerShare: ratePerShare.toString(),
      },
      'snapshot funding: computed yield floored to 0 — skipping (no fund)',
    );
    return { skip: 'zero_snapshot_yield', computedYield: 0n };
  }

  // Multi-token-safe float gate. `remaining === null` in live mode means
  // the caller's sweep-start read failed — refuse to fund blind.
  const remaining = floatLedger?.remaining ?? null;
  if (remaining === null || remaining < amount) {
    logger.warn(
      {
        symbol,
        epochId: epochId.toString(),
        remaining: remaining === null ? 'null' : remaining.toString(),
        needed: amount.toString(),
      },
      'snapshot funding: issuer mhUSDC float short — skipping (no fund)',
    );
    return {
      skip: 'insufficient_mhusdc_float',
      computedYield: amount,
      ...(remaining !== null ? { floatRemaining: remaining } : {}),
    };
  }

  // Proceeding to fund. Re-stamp the audit row's amount to the actual
  // (insertInProgress stamped the cap-based estimate) so the trail records
  // what was funded. Idempotent: status stays `snapshot_done`.
  await args.audit.updateStatus(epochId, args.tokenAddrLower, 'snapshot_done', {
    encTotalYieldUsd6: amount,
  });
  return { amount, clamped };
}

/**
 * FU-1 — decrypt the on-chain `encTotalSupply` handle via the cofhe
 * client's self-permit. Mirrors the cron's `readMhUsdcFloat` timeout
 * shape: single attempt wrapped in a 60s `Promise.race` so a stalled
 * coprocessor can't wedge the runner. Returns `null` on any failure (the
 * caller skips + the next tick retries — `encTotalSupply` is immutable
 * post-finalize so the recompute is safe).
 */
async function decryptSnapshotSupply(
  cofheClient: any,
  handleHex: string,
  logger: RunnerLogger,
  symbol: string,
  epochId: bigint,
): Promise<bigint | null> {
  const DECRYPT_TIMEOUT_MS = 60_000;
  // Cleared in the finally so the 60s timer doesn't dangle on the (common)
  // success path — once per token per tick across an 11-token sweep would
  // otherwise keep the event loop armed + delay clean shutdown
  // (Backend-Arch M-3, 2026-05-25).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // `getEpoch` returns encTotalSupply as bytes32; decryptForView wants
    // the numeric ctHash handle (same as the cron's confidentialBalanceOf
    // uint256 handle). encTotalSupply is euint128 → FheTypes.Uint128.
    const handle = BigInt(handleHex);
    const decryptPromise = cofheClient
      .decryptForView(handle, FheTypes.Uint128)
      .withPermit()
      .execute();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              `encTotalSupply decryptForView timed out after ${DECRYPT_TIMEOUT_MS}ms`,
            ),
          ),
        DECRYPT_TIMEOUT_MS,
      );
    });
    return (await Promise.race([decryptPromise, timeoutPromise])) as bigint;
  } catch (err) {
    logger.error(
      {
        symbol,
        epochId: epochId.toString(),
        err: err instanceof Error ? err.message : String(err),
      },
      'snapshot funding: encTotalSupply decryptForView failed — skipping + retrying next tick',
    );
    return null;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * FU-4 (Wave 5 W2, 2026-05-25) — is this a "nonce too low / already used"
 * rejection? The yield issuer EOA is SHARED with the nav crons (nav-publisher
 * / nav-worker) on prod, so a NAV tx fired from the same address between the
 * runner reading the pending nonce and broadcasting can advance the account
 * nonce and get our tx rejected. Such a tx is DEFINITIVELY rejected (never
 * entered the mempool) — so it's safe to re-send with a freshly-queried
 * nonce. We deliberately do NOT treat network/timeout errors as retryable:
 * those may have broadcast-then-lost-the-response, and re-sending a
 * state-changing tx (fundEpoch) could double-fund. Network blips fail the
 * tick and self-heal via the resume path instead.
 */
function isNonceCollisionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: string;
    message?: string;
    shortMessage?: string;
    error?: { message?: string };
  };
  if (e.code === 'NONCE_EXPIRED') return true;
  const msg = `${e.message ?? ''} ${e.shortMessage ?? ''} ${e.error?.message ?? ''}`.toLowerCase();
  return msg.includes('nonce too low') || msg.includes('nonce has already been used');
}

/**
 * FU-4 — send an on-chain tx with bounded retry ON NONCE COLLISION ONLY.
 * Wraps just the SEND (`contract.method(...)`), not `tx.wait()` — a
 * nonce-too-low is rejected at broadcast, never at mining. Each retry
 * re-invokes `send`, which re-queries the pending nonce via ethers' default
 * per-call population (NO `NonceManager` — its locally-cached nonce would
 * stay stale against the OTHER process's tx and never converge). Backoff
 * gives the mempool time to reflect the concurrent tx so the re-query lands
 * a fresh nonce. Non-nonce errors propagate immediately (caller's catch →
 * audit `failure` → next-tick resume).
 */
async function sendWithNonceRetry(
  // Returns an ethers tx response (`.hash` / `.wait()`); the runner's send
  // sites already go through `(contract as any).method(...)`, so the tx is
  // `any` here too — the caller awaits `.wait()` / reads `.hash` as before.
  send: () => Promise<any>,
  ctx: { label: string; symbol: string; logger: RunnerLogger; maxAttempts?: number },
): Promise<any> {
  const maxAttempts = ctx.maxAttempts ?? 4;
  const backoffMs = [500, 1500, 3000];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isNonceCollisionError(err) || attempt === maxAttempts) throw err;
      const delayMs = backoffMs[attempt - 1] ?? 3000;
      ctx.logger.warn(
        { symbol: ctx.symbol, label: ctx.label, attempt, maxAttempts, delayMs },
        'nonce collision on send (shared issuer EOA?) — re-querying nonce + retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastErr;
}

async function openEpochAndCapture(
  snapshot: Contract,
  tokenAddr: Address,
  logger: RunnerLogger,
  symbol: string,
  dryRun: boolean,
): Promise<bigint> {
  if (dryRun) {
    logger.warn(
      { symbol, token: tokenAddr },
      'dry-run: would openEpoch — synthesising epochId=0 for downstream skip',
    );
    return 0n;
  }
  const openTx = await sendWithNonceRetry(
    () => (snapshot as any).openEpoch(tokenAddr),
    { label: 'openEpoch', symbol, logger },
  );
  const rcpt = await openTx.wait();
  let opened: bigint | null = null;
  for (const log of rcpt?.logs ?? []) {
    try {
      const parsed = EPOCH_OPENED_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed?.name === 'EpochOpened') {
        opened = parsed.args.epochId as bigint;
        break;
      }
    } catch {
      // non-matching log; ignore
    }
  }
  if (opened == null) {
    throw new Error('openEpoch did not emit EpochOpened — abort');
  }
  logger.info(
    { symbol, token: tokenAddr, epochId: opened.toString() },
    'openEpoch settled',
  );
  return opened;
}

// v3.1 S6 — 3-attempt exponential backoff (1s, 4s, 16s). On persistent
// failure, log + caller can route to Telegram. Does NOT throw — the
// +2d operator grant is the safety floor.
async function revokeOperatorWithRetry(
  pusdc: Contract,
  snapshotAddr: Address,
  logger: RunnerLogger,
  symbol: string,
): Promise<void> {
  const delays = [1_000, 4_000, 16_000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      const tx = await (pusdc as any).setOperator(snapshotAddr, 0n);
      await tx.wait();
      logger.info(
        { symbol, attempt: attempt + 1 },
        'operator revoked on snapshot proxy',
      );
      return;
    } catch (err) {
      logger.warn(
        { symbol, attempt: attempt + 1, err: (err as Error).message },
        'setOperator(...,0) retry',
      );
      if (attempt < delays.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }
  logger.error(
    { symbol },
    'operator revoke failed after 3 attempts — +2d expiry is the safety floor',
  );
}
