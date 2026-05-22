import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A · GET /policy/scoped-session?surface=mcp.
 *
 * Pure read — returns the most-recently-minted active snapshot for
 * `(userId, surface)`, or `null` if zero match. Repository's
 * `findLatestActive` does the heavy lifting; this wrapper exists so the
 * REST handler doesn't depend on the repo interface directly (DI
 * hygiene + future-proofing for "we want to add audit-on-read" type
 * concerns).
 *
 * Used by three callers:
 *   - Dashboard banner (`ActiveSessionBanner.vue`, Commit 2.C).
 *   - MCP server auto-sync (Commit 2.B) — when the position.* probe
 *     chain hits `no_active_session_key` against a fresh broker, the
 *     MCP server calls GET here, then `broker.storePolicySnapshot` via
 *     IPC.
 *   - Forensic queries / Slice 1 smoke (operator manually curling).
 */
export interface GetActiveScopedSessionInput {
  userId: string;
  surface: Surface;
  /** Optional clock override for tests. Defaults to real `Date.now()`. */
  now?: Date;
}

export class GetActiveScopedSessionUseCase {
  constructor(private readonly scopedRepo: IScopedSessionRepository) {}

  async execute(input: GetActiveScopedSessionInput): Promise<ScopedSession | null> {
    const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
    return this.scopedRepo.findLatestActive(input.userId, input.surface, nowSec);
  }
}
