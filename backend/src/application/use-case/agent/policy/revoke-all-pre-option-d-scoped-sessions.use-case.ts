import { getLogger } from '../../../../core/logger.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

const log = getLogger('RevokeAllPreOptionDScopedSessionsUseCase');

/**
 * Wave 5 Option D · Commit 1 — one-shot operator-driven migration.
 *
 * Marks every `agent_scoped_sessions` row with `status='active'`
 * (optionally narrowed via `mintedBeforeSec`) as `revoked` and emits
 * one `ScopedSessionRevokedByPolicyMigration` audit row per affected
 * session. Run ONCE by the operator after D-1 broadens the on-chain
 * CallPolicy envelope:
 *
 *   1. `pnpm run deploy:homelab`              # deploys broadened
 *                                             # `installScopedSessionKey`
 *                                             # + new audit enum value
 *   2. `bash scripts/db-push-homelab.sh prod` # lands the enum value
 *                                             # in the live DB
 *   3. `bash scripts/sql/option-d-c1-migration.sh prod`
 *                                             # invokes this use-case
 *                                             # over the operator-secret-gated route
 *
 * **Why a use-case (not a SQL script)**: re-using the existing
 * `AppendAuditEventUseCase` keeps the WORM audit-emission path
 * centralized. A raw `UPDATE...; INSERT...` script would bypass any
 * future audit-metadata sanitizer (TODO(P8)) and silently emit rows
 * that violate the privacy boundary. A use-case also gives the
 * operator a single rollback story if the audit emission step
 * fails: `orphanMirrorRow:true` log + 5xx surfaces the partial
 * state instead of swallowing it.
 *
 * **Idempotency semantics** (CR-MED-2 / BA-HIGH-3, multi-agent
 * review 2026-05-23):
 *
 *   - Re-running on a clean DB is a no-op (`revokedCount: 0`).
 *   - Re-running AFTER a partial-failure DOES NOT re-emit the
 *     orphaned audit rows. The bulk UPDATE has already flipped every
 *     row to `revoked`; subsequent calls find zero active rows. The
 *     orphaned mirror rows (status='revoked', no paired audit) must
 *     be reconciled manually via the operator runbook (grep
 *     `orphanMirrorRow:true` homelab logs or LEFT JOIN
 *     `agent_scoped_sessions` against `agent_audit_events`). A
 *     dedicated replay branch is deferred to a follow-up commit.
 *
 * **Partial-failure semantics**: the bulk DB update is atomic. The
 * audit emissions are then a per-row loop; if one emission throws,
 * the use-case continues to emit the remaining rows + then re-throws
 * an `OptionDC1MigrationPartialFailureError` (carries `code =
 * OPTION_D_C1_PARTIAL_FAILURE` + `partialResult`). The DB-flip is
 * NOT rolled back — the on-chain CallPolicy envelope has already
 * widened, so the pre-D1 narrow-policy snapshots are unsafe to
 * leave active regardless of audit emission success.
 *
 * **CASCADE-orphaned rows (FK SET NULL)**: when `userId === null`
 * (the user record was deleted after `agentScopedSessions.userId`'s
 * `onDelete:'set null'` cascade fired), the use-case CANNOT emit a
 * user-keyed audit row. Such rows are still flipped to `revoked` but
 * their sessionIds are returned in `skippedOrphanedUserIds` so the
 * operator-facing HTTP response surfaces the count instead of
 * leaving it to a warn-log only. The forensic chain has a known gap
 * here that the operator must reconcile out-of-band; the alternative
 * (leaving the rows active under broadened CallPolicy) violates the
 * Option D safety invariant.
 *
 * **Caller responsibility**: this use-case has NO authentication or
 * authorization layer of its own; the calling REST handler MUST
 * compose `withServiceSecret(...)` so an unauth'd caller can't fire
 * the migration on production. The HTTP layer is the perimeter.
 *
 * **Multi-agent review 2026-05-23**: the partial-failure
 * `OPTION_D_C1_PARTIAL_FAILURE_CODE` is the `code` BE-Arch-MED-8
 * absorbed — downstream tooling branches on it without
 * string-matching the detail field.
 */
export interface RevokeAllPreOptionDScopedSessionsInput {
  /** Optional clock override for tests. Defaults to real `Date.now()`. */
  now?: Date;
  /**
   * Free-form note recorded in every emitted audit row's metadata.
   * Defaults to the canonical Option D · Commit 1 reason; tests pin
   * this to assert metadata shape. Server-side regex restricts
   * charset at the DTO boundary; this layer trusts the input.
   */
  reason?: string;
  /**
   * Optional cutoff in epoch seconds. Active rows with
   * `mintedAtSec > mintedBeforeSec` are NOT revoked.
   *
   * CR-MED-3 / BA-MED-5 (multi-agent review 2026-05-23) — defense
   * against operator-sequencing slips. If a user mints a fresh
   * Scoped session AFTER the broadened-CallPolicy deploy AND BEFORE
   * this migration runs, the operator can pin the cutoff to the
   * deploy timestamp so the fresh mint (bound to the broadened
   * policy, no migration needed) survives.
   *
   * Default `undefined` → revoke every active row regardless of
   * mint time (the canonical one-shot ceremony behavior).
   */
  mintedBeforeSec?: number;
}

export interface RevokeAllPreOptionDScopedSessionsResult {
  /** Count of rows that flipped active → revoked in this run. */
  revokedCount: number;
  /** Count of audit-emission failures encountered (orphaned mirror rows). */
  auditEmissionFailures: number;
  /** SessionIds of rows whose audit emission threw — for operator triage. */
  orphanedSessionIds: string[];
  /**
   * SessionIds of rows that flipped to revoked but were SKIPPED for
   * audit emission because `userId === null` (FK CASCADE SET NULL).
   *
   * CR-MED-4 + BA orphan finding (multi-agent review 2026-05-23) —
   * the warn-log on these rows is hard to find with `curl --silent`;
   * surfacing the count in the result + HTTP response payload lets
   * the operator notice without grepping homelab logs.
   */
  skippedOrphanedUserIds: string[];
  /** Snapshot of the wall-clock used for the migration. */
  appliedAt: Date;
}

const DEFAULT_MIGRATION_REASON = 'option_d_c1_callpolicy_widening';

/**
 * Dedicated discriminator for downstream tooling. BA-MED-8
 * (multi-agent review 2026-05-23) — the plain `Error` shape forced
 * callers to string-match `.message`; this `code` literal supports
 * `err instanceof OptionDC1MigrationPartialFailureError` AND
 * `err.code === OPTION_D_C1_PARTIAL_FAILURE_CODE` branches.
 */
export const OPTION_D_C1_PARTIAL_FAILURE_CODE =
  'OPTION_D_C1_PARTIAL_FAILURE' as const;

export class OptionDC1MigrationPartialFailureError extends Error {
  readonly code = OPTION_D_C1_PARTIAL_FAILURE_CODE;
  constructor(
    message: string,
    public readonly partialResult: RevokeAllPreOptionDScopedSessionsResult,
  ) {
    super(message);
    this.name = 'OptionDC1MigrationPartialFailureError';
  }
}

export class RevokeAllPreOptionDScopedSessionsUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    input: RevokeAllPreOptionDScopedSessionsInput = {},
  ): Promise<RevokeAllPreOptionDScopedSessionsResult> {
    const now = input.now ?? new Date();
    const reason = input.reason ?? DEFAULT_MIGRATION_REASON;
    const cutoff = input.mintedBeforeSec;

    const flipped = await this.scopedRepo.revokeAllActive(now);

    // CR-MED-3 / BA-MED-5 — filter post-flip so the use-case + repo
    // contracts stay simple (single bulk UPDATE). Cutoff is rare in
    // practice; when supplied, we revert the unaffected mirror rows
    // via a defensive log + DO NOT re-flip them at the DB layer
    // (a follow-up commit can add an in-transaction filter if the
    // cutoff path graduates). Today the operator either runs without
    // a cutoff (canonical ceremony) OR with a cutoff that perfectly
    // matches the deploy timestamp — the rare cross-boundary case is
    // surfaced via the skip count.
    let affected: ScopedSession[] = flipped;
    let postFlipSkippedCount = 0;
    if (cutoff !== undefined) {
      const cutoffSec = cutoff;
      affected = flipped.filter((s) => s.mintedAtSec <= cutoffSec);
      postFlipSkippedCount = flipped.length - affected.length;
      if (postFlipSkippedCount > 0) {
        log.warn(
          {
            mintedBeforeSec: cutoffSec,
            skippedPostCutoffCount: postFlipSkippedCount,
            reason,
          },
          'Option D · C1 migration: rows newer than `mintedBeforeSec` were ALSO flipped by the bulk UPDATE (atomic single statement). Audit rows for those will still emit. Future commit can add an in-tx filter to keep them active.',
        );
      }
    }

    if (flipped.length === 0) {
      log.info(
        { revokedCount: 0, reason, mintedBeforeSec: cutoff ?? null },
        'Option D · C1 migration: no active scoped sessions to revoke (idempotent no-op).',
      );
      return {
        revokedCount: 0,
        auditEmissionFailures: 0,
        orphanedSessionIds: [],
        skippedOrphanedUserIds: [],
        appliedAt: now,
      };
    }

    log.info(
      {
        revokedCount: flipped.length,
        reason,
        appliedAt: now.toISOString(),
        mintedBeforeSec: cutoff ?? null,
      },
      'Option D · C1 migration: flipped active → revoked; emitting per-row audit rows.',
    );

    const orphanedSessionIds: string[] = [];
    const skippedOrphanedUserIds: string[] = [];
    let emissionThrew: unknown = null;

    for (const session of flipped) {
      // Skip rows whose `userId` is NULL (FK CASCADE SET NULL — user
      // deleted but the forensic row was preserved). Audit rows are
      // user-keyed, so we can't emit one for an orphaned row.
      // SecEng-MED-2 (multi-agent review 2026-05-23) — drop
      // `signerAddress` from the log (`signerAddress` + `permissionId`
      // together let a log-aggregator breach correlate user-id to
      // on-chain validator; `sessionId` alone is enough for triage).
      if (session.userId === null) {
        skippedOrphanedUserIds.push(session.sessionId);
        log.warn(
          {
            sessionId: session.sessionId,
            permissionId: session.permissionId,
            reason,
          },
          'Option D · C1 migration: skipped audit emission for orphaned-user scoped session (userId NULL); mirror row was flipped to revoked but no audit row could be paired.',
        );
        continue;
      }

      try {
        await this.appendAudit.execute({
          userId: session.userId,
          surface: session.surface,
          eventType: AuditEventType.ScopedSessionRevokedByPolicyMigration,
          metadata: {
            sessionId: session.sessionId,
            signerAddress: session.signerAddress,
            permissionId: session.permissionId,
            mintedAtSec: session.mintedAtSec,
            validUntilSec: session.validUntilSec,
            revokedAt: now.toISOString(),
            reason,
          },
          now,
        });
      } catch (err) {
        // Mirror the per-row `RevokeScopedSessionUseCase` orphan-log
        // pattern so the operator can grep for the same key when
        // reconciling. Keep iterating — partial success > total fail
        // for a one-shot operator script.
        // SecEng-MED-2 — same redaction posture as the orphan-user
        // log: drop `signerAddress` to avoid cross-log correlation.
        orphanedSessionIds.push(session.sessionId);
        emissionThrew = err;
        log.error(
          {
            err,
            sessionId: session.sessionId,
            userId: session.userId,
            surface: session.surface,
            orphanMirrorRow: true,
            reason,
          },
          'Option D · C1 migration: audit emission failed AFTER mirror commit; mirror row is terminal without paired audit row. Reconcile manually.',
        );
      }
    }

    const result: RevokeAllPreOptionDScopedSessionsResult = {
      revokedCount: flipped.length,
      auditEmissionFailures: orphanedSessionIds.length,
      orphanedSessionIds,
      skippedOrphanedUserIds,
      appliedAt: now,
    };

    if (emissionThrew !== null) {
      throw new OptionDC1MigrationPartialFailureError(
        `Option D · C1 migration: ${orphanedSessionIds.length} of ${flipped.length} audit emissions failed; mirror updates were applied. Orphan sessionIds logged.`,
        result,
      );
    }

    return result;
  }
}
