import { ApplicationHttpError } from '../../../../core/errors.js';
import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../domain/agent/model/scoped-session-status.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';

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
 * **Audit emission deferred to Commit 2.B**.
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
  constructor(private readonly scopedRepo: IScopedSessionRepository) {}

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
    // TODO(Commit 2.B): emit AuditEventType.ScopedSessionRevoked via
    // AppendAuditEventUseCase. Metadata: { sessionId, revokedAt }.
    // Also wire `broker.clearPolicySnapshot(sessionId)` IPC call so the
    // broker keystore drops its half of the pair (Slice 3 ships the
    // full kill-switch ceremony; Slice 2.B partial covers mirror + IPC).

    return { session: revoked };
  }
}
