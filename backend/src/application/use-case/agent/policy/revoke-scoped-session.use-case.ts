import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../domain/agent/model/scoped-session-status.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A · DELETE /policy/scoped-session/:id.
 *
 * User-initiated revoke. Marks the row `status='revoked'` so:
 *   - The dashboard banner stops showing the session as active.
 *   - The MCP auto-sync (Commit 2.B) finds no active snapshot and
 *     leaves the broker keystore untouched on next position.* call.
 *   - Forensic queries can prove the consent window closed.
 *
 * Distinct from "broker keystore wipe" — the broker daemon is
 * authoritative for whether it actually signs; revoking the mirror
 * doesn't unilaterally stop a broker with a stale on-disk snapshot.
 * Slice 3 wires the matching `broker.clearPolicySnapshot` IPC call as
 * part of the kill-switch ceremony. Slice 2's revoke is the FIRST half
 * (operator says "no more"); Slice 3 adds the SECOND half (broker
 * forgets too).
 *
 * **Ownership check is load-bearing**: revoke is authenticated by the
 * passkey-JWT subject (the kernel address = `userId`), but the
 * `sessionId` is operator-supplied via the URL path. Without the
 * ownership check, a malicious user A could DELETE user B's session.
 * We re-load by PK + match `session.userId === input.userId` BEFORE
 * calling repo.revoke (rather than letting the SQL WHERE clause do
 * it) so the 404 vs 403 distinction is correct: not-found is "no such
 * id"; ownership-mismatch is "exists but not yours" — same 404 mask
 * (don't leak existence) but the use-case sees the distinction for
 * audit emission in Commit 2.B.
 *
 * **Audit emission (Commit 2.B)**: composes `AppendAuditEventUseCase`
 * with `eventType: AuditEventType.ScopedSessionRevoked`. Metadata
 * carries `{ sessionId, revokedAt }` so the forensic-chain query that
 * pairs mint↔revoke can use the audit row's `created_at` as the closure
 * timestamp without re-joining to `agent_scoped_sessions.revoked_at`
 * (the row is the WORM stable key per Security M-2).
 *
 * **`broker.clearPolicySnapshot` deferred to Slice 3.** The backend
 * runs in the homelab; the broker daemon runs on the user's machine
 * (loopback Unix socket / Windows named pipe). The use-case has no
 * line-of-sight to the broker IPC socket; ANY backend-side clear would
 * have to route through the MCP server (which the user might not be
 * running). Slice 3 wires the full kill-switch ceremony: dashboard
 * revoke → backend mirror revoke → MCP-side "broker stale on next call"
 * detection → `broker.clearPolicySnapshot` over IPC. Today (Slice 2.B),
 * the mirror row's `status='revoked'` is the authoritative signal; a
 * stale broker keystore is forensically harmless because the on-chain
 * CallPolicy validator + per-selector cap still bound execution, and
 * the broker daemon's restart-from-scratch flow re-fetches the active
 * snapshot from the mirror.
 *
 * **Audit-throw orphan risk (CR-R2 M-1)**: when `repo.revoke` succeeds
 * but `appendAudit.execute` throws, the mirror row is already terminal
 * (`status='revoked'`) and a subsequent DELETE on the same sessionId
 * hits the "already terminal" 409 branch — the missed audit row is NOT
 * re-emitted (asymmetric vs. mint, where a retry hits the active-dedup
 * 409 but at least the row pair is detectable via "orphan mirror has
 * NO `ScopedSessionRevoked` audit pair"). Until the Slice 3+
 * transactional-outbox closes this gap, the operator runbook is "scan
 * `agent_scoped_sessions` for revoked rows lacking a paired
 * `ScopedSessionRevoked` audit row" — the use-case logs a
 * `orphanMirrorRow:true` structured log on emission throw so the entry
 * shows up in homelab grep sweeps (Compliance L-4 round 2).
 */
export interface RevokeScopedSessionInput {
  userId: string;
  sessionId: string;
  now?: Date;
}

export interface RevokeScopedSessionResult {
  session: ScopedSession;
}

export class RevokeScopedSessionUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: RevokeScopedSessionInput): Promise<RevokeScopedSessionResult> {
    const now = input.now ?? new Date();

    const existing = await this.scopedRepo.findById(input.sessionId);
    if (!existing || existing.userId !== input.userId) {
      // Mask ownership mismatch as 404 — the response body must not let
      // a caller probe whether a given sessionId exists for another
      // user. The use-case-internal audit emission (Commit 2.B) can
      // still distinguish the two cases via separate metadata.
      throw ApplicationHttpError.notFound(`scoped session ${input.sessionId} not found`);
    }
    if (existing.status !== ScopedSessionStatus.Active) {
      // Already terminal — idempotent at the surface (no double audit
      // emission in Commit 2.B; same 409 the dashboard maps to a
      // "session already inactive" toast).
      throw ApplicationHttpError.conflict(
        `scoped session ${input.sessionId} is already ${existing.status}`,
        { sessionId: input.sessionId, status: existing.status },
      );
    }

    const revoked = await this.scopedRepo.revoke(input.sessionId, now);
    if (!revoked) {
      // Race — another caller revoked between findById and revoke.
      // Surface as 409 to match the "already terminal" branch above.
      throw ApplicationHttpError.conflict(
        `scoped session ${input.sessionId} could not be revoked (already terminal?)`,
      );
    }

    // Use the use-case's `now` as the revoke wall-clock so the audit
    // row's `created_at` is consistent with the persisted
    // `revoked_at`. The repo's `revoke()` also took `now` — these are
    // the same instant by design (test injection works through both).
    //
    // `existing.surface` (not `revoked.surface`) is the audit anchor:
    // the surface the user originally minted under is the invariant,
    // and a future repo migration that mutated the field on revoke
    // would shift the audit metadata away from the user's intent
    // (Backend Architect L-5 round 1).
    try {
      await this.appendAudit.execute({
        userId: input.userId,
        surface: existing.surface,
        eventType: AuditEventType.ScopedSessionRevoked,
        metadata: {
          sessionId: revoked.sessionId,
          revokedAt: now.toISOString(),
        },
        now,
      });
    } catch (err) {
      // CR-R2 M-1 / Compliance L-4 round 2 — structured log so the
      // orphan-revoke gap is grep-able even before the H-2
      // reconciliation cron lands. Re-throw to surface a 500.
      getLogger('RevokeScopedSessionUseCase').error(
        {
          err,
          sessionId: revoked.sessionId,
          userId: input.userId,
          surface: existing.surface,
          orphanMirrorRow: true,
        },
        'audit emission failed AFTER revoke commit — mirror row terminal without paired audit row; reconcile manually',
      );
      throw err;
    }

    return { session: revoked };
  }
}
