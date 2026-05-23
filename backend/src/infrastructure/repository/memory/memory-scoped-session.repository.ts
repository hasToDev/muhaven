import {
  ScopedSession,
  type ScopedSessionInstallMaterial,
} from '../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../domain/agent/model/scoped-session-status.enum.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type {
  IScopedSessionRepository,
  ScopedSessionInstallMaterialWrite,
} from '../../../domain/agent/repository/scoped-session.repository.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A — in-memory scoped-session repo for
 * tests + dev (`DB_PROVIDER` not `'postgres'`). Mirrors the Pg
 * repository semantics: PK-conflict throws on `create`, `revoke`
 * returns null on terminal rows, etc.
 *
 * Sort order in `findLatestActive` mirrors the Pg version: newest
 * `minted_at` first (ties broken by `session_id` for determinism in
 * tests).
 */
export class MemoryScopedSessionRepository implements IScopedSessionRepository {
  private readonly store = new Map<string, ScopedSession>();
  /**
   * Wave 5 Option D · Commit 2 — install material lives in a sidecar map
   * keyed by sessionId so the public `ScopedSession` shape doesn't grow
   * encryption-bearing fields. The Pg repo encrypts via pgcrypto; the
   * memory repo stores cleartext verbatim (the test path uses this
   * directly to assert the round-trip).
   */
  private readonly installMaterial = new Map<
    string,
    ScopedSessionInstallMaterialWrite & { userIdAtMint: string | null }
  >();

  async create(
    session: ScopedSession,
    installMaterial?: ScopedSessionInstallMaterialWrite,
  ): Promise<void> {
    if (this.store.has(session.sessionId)) {
      throw new Error(`scoped session ${session.sessionId} already exists`);
    }
    // Mirror the Pg `agent_scoped_sessions_user_surface_active_uq_v2`
    // partial UNIQUE constraint so dev (`DB_PROVIDER != 'postgres'`) and
    // prod fail-mode match. Without this guard, a concurrent-mint test
    // run against memory mode would silently produce two active rows
    // for the same (userId, surface) — divergence that would only
    // surface in prod. The use-case-level `findLatestActive` pre-check
    // already gates this for single-threaded request flow; this repo
    // guard catches the multi-request race that the partial UNIQUE
    // would catch at the DB layer.
    if (session.status === ScopedSessionStatus.Active && session.userId !== null) {
      for (const existing of this.store.values()) {
        if (existing.userId !== session.userId) continue;
        if (existing.surface !== session.surface) continue;
        if (existing.status !== ScopedSessionStatus.Active) continue;
        const err = new Error(
          `memory partial UNIQUE: active session already exists for user=${session.userId} surface=${session.surface} (sessionId=${existing.sessionId})`,
        ) as Error & { code?: string };
        err.code = '23505'; // mirrors Pg unique-violation code for callers that match on it
        throw err;
      }
    }
    // Wave 5 Option D · Commit 2 — the use-case already populated
    // `enableStatus` + `validatorNonce` on the domain entity. The
    // repo's job here is purely persistence; we DO NOT re-derive.
    // enableData + enableSig live in a sidecar (the memory equivalent
    // of the Pg repo's encrypted columns) keyed by sessionId. The
    // surface route paths get the public ScopedSession; the
    // install-material route reads the sidecar.
    this.store.set(session.sessionId, session);
    if (installMaterial) {
      this.installMaterial.set(session.sessionId, {
        enableData: installMaterial.enableData,
        enableSig: installMaterial.enableSig,
        validatorNonce: installMaterial.validatorNonce,
        userIdAtMint: session.userId,
      });
    }
  }

  async findInstallMaterialById(
    sessionId: string,
    userId: string,
  ): Promise<ScopedSessionInstallMaterial | null> {
    const session = this.store.get(sessionId);
    if (!session) return null;
    if (session.userId !== userId) return null;
    const mat = this.installMaterial.get(sessionId);
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      surface: session.surface,
      status: session.status,
      signerAddress: session.signerAddress,
      permissionId: session.permissionId,
      enableStatus: session.enableStatus,
      enableData: mat?.enableData ?? null,
      enableSig: mat?.enableSig ?? null,
      validatorNonce: session.validatorNonce,
      validatorEnabledAt: session.validatorEnabledAt,
      validatorEnabledTxHash: session.validatorEnabledTxHash,
      validUntilSec: session.validUntilSec,
      mintedAtSec: session.mintedAtSec,
    };
  }

  async findById(sessionId: string): Promise<ScopedSession | null> {
    return this.store.get(sessionId) ?? null;
  }

  async findLatestActive(
    userId: string,
    surface: Surface,
    nowSec: number,
  ): Promise<ScopedSession | null> {
    const matches: ScopedSession[] = [];
    for (const session of this.store.values()) {
      if (session.userId !== userId) continue;
      if (session.surface !== surface) continue;
      if (session.status !== ScopedSessionStatus.Active) continue;
      if (session.validUntilSec <= nowSec) continue;
      matches.push(session);
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const t = b.mintedAt.getTime() - a.mintedAt.getTime();
      if (t !== 0) return t;
      return a.sessionId.localeCompare(b.sessionId);
    });
    return matches[0]!;
  }

  async revoke(sessionId: string, now: Date): Promise<ScopedSession | null> {
    const existing = this.store.get(sessionId);
    if (!existing) return null;
    if (existing.status !== ScopedSessionStatus.Active) return null;
    const revoked = existing.with({
      status: ScopedSessionStatus.Revoked,
      revokedAt: now,
    });
    this.store.set(sessionId, revoked);
    return revoked;
  }

  async markExpired(beforeSec: number, now: Date): Promise<number> {
    let count = 0;
    for (const [sessionId, session] of this.store) {
      if (session.status !== ScopedSessionStatus.Active) continue;
      if (session.validUntilSec > beforeSec) continue;
      this.store.set(
        sessionId,
        session.with({ status: ScopedSessionStatus.Expired, expiredAt: now }),
      );
      count += 1;
    }
    return count;
  }

  async markExpiredForUserSurface(
    userId: string,
    surface: Surface,
    beforeSec: number,
    now: Date,
  ): Promise<number> {
    let count = 0;
    for (const [sessionId, session] of this.store) {
      if (session.userId !== userId) continue;
      if (session.surface !== surface) continue;
      if (session.status !== ScopedSessionStatus.Active) continue;
      if (session.validUntilSec > beforeSec) continue;
      this.store.set(
        sessionId,
        session.with({ status: ScopedSessionStatus.Expired, expiredAt: now }),
      );
      count += 1;
    }
    return count;
  }

  async revokeAllActive(now: Date): Promise<ScopedSession[]> {
    // Wave 5 Option D · Commit 1 — mirror the Pg variant: flip every
    // active row (regardless of `valid_until_sec`) to revoked, return
    // the affected entities. Iteration order isn't load-bearing for
    // the use-case; the migration emits audit rows by iterating the
    // returned array.
    const affected: ScopedSession[] = [];
    for (const [sessionId, session] of this.store) {
      if (session.status !== ScopedSessionStatus.Active) continue;
      const revoked = session.with({
        status: ScopedSessionStatus.Revoked,
        revokedAt: now,
      });
      this.store.set(sessionId, revoked);
      affected.push(revoked);
    }
    return affected;
  }
}
