/**
 * Wave 5 Option D · Commit 3 — 60-block validator-install watchdog.
 *
 * Periodically scans `agent_scoped_sessions` for rows still
 * `enable_status='pending'` whose `mintedAt` is older than the
 * configured stale threshold (default 720s = ~60 Arb Sepolia blocks
 * at 12s/block). Flips each stale row to `'failed'` so:
 *   - Future MCP buys fall back to Path C with a clear "re-walk
 *     the ceremony" remediation (Path D fallback `validator_install_failed_re_walk_required`).
 *   - The dashboard banner can render a "your previous Scoped session
 *     never installed — re-mint" CTA.
 *
 * Fires one Telegram operator alert per flipped row (idempotent on
 * the row state — alerts are best-effort; a missed alert doesn't
 * stop the flip).
 *
 * The watchdog is INDEPENDENT of the chain indexer: in dev / partial-
 * production posture, the operator can run the watchdog without the
 * indexer to confirm that pending rows fail closed within the
 * threshold window. Both run together in prod.
 */

import { AuditEventType } from '../../domain/agent/model/audit-event-type.enum.js';
import type { IScopedSessionRepository } from '../../domain/agent/repository/scoped-session.repository.js';
import type { ScopedSession } from '../../domain/agent/model/scoped-session.js';
import type { AppendAuditEventUseCase } from '../../application/use-case/agent/policy/append-audit-event.use-case.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';
import type { IOperatorAlertTransport } from '../operator/operator-alert-transport.js';

export interface ValidatorEnableWatchdogConfig {
  /**
   * Post-expiry grace (seconds). A pending session is flagged `failed`
   * only once `valid_until_sec + graceSec <= now` — i.e. its TTL window
   * closed AND the grace buffer elapsed without the validator
   * installing. (Third-commit correction: this WAS "minutes since
   * mint", which prematurely killed healthy within-TTL sessions that
   * were simply awaiting their first Path D buy. C3 installs at first
   * buy, not at mint, so the only genuine failure is "TTL expired
   * without ever installing".) Default 720s grace ≈ one watchdog
   * confirmation window past expiry.
   */
  readonly staleThresholdSec: number;
  /** Maximum rows processed per tick. */
  readonly batchLimit: number;
}

export class ValidatorEnableWatchdog {
  private readonly logger: Logger;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly alertTransport: IOperatorAlertTransport,
    /**
     * Wave 5 Option D Commit 3 (multi-agent review SW Arch M-4) —
     * watchdog emits `AuditEventType.ValidatorInstallFailed` per
     * flipped row so the audit trail has symmetric coverage of the
     * install lifecycle (success → `ValidatorInstalled` from the
     * use-case; failure → `ValidatorInstallFailed` from here).
     * Without this, the audit table was one-sided (success-only),
     * which broke `since X show every install attempt's outcome`
     * replay queries.
     */
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly config: ValidatorEnableWatchdogConfig,
  ) {
    this.logger = getLogger().child({ poller: 'validator-enable-watchdog' });
  }

  start(intervalMs: number): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Test seam. */
  async tickOnce(now?: Date): Promise<{ flipped: number }> {
    return this.tick(now);
  }

  private async tick(nowOverride?: Date): Promise<{ flipped: number }> {
    if (this.running) return { flipped: 0 };
    this.running = true;
    let flipped = 0;
    try {
      const now = nowOverride ?? new Date();
      // TTL-based cutoff (third-commit correction): flag pending
      // sessions whose `valid_until_sec + grace <= now` — i.e. their
      // TTL window has closed plus a grace buffer, and the validator
      // never installed. `cutoffSec = nowSec - graceSec` so the repo
      // matches `valid_until_sec <= cutoffSec`.
      const nowSec = Math.floor(now.getTime() / 1000);
      const cutoffSec = nowSec - this.config.staleThresholdSec;
      const stale = await this.scopedRepo.findExpiredPendingEnable(
        cutoffSec,
        this.config.batchLimit,
      );
      for (const row of stale) {
        try {
          const result = await this.scopedRepo.markValidatorFailed(row.sessionId);
          if (result) {
            flipped++;
            await this.emitFailedAudit(result, now);
            await this.emitStaleAlert(result, now);
          }
        } catch (err) {
          this.logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              sessionId: row.sessionId,
            },
            'failed to flip stale enable_status to failed',
          );
        }
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'validator-enable watchdog tick failed',
      );
    } finally {
      this.running = false;
    }
    return { flipped };
  }

  private async emitFailedAudit(
    session: ScopedSession,
    now: Date,
  ): Promise<void> {
    if (!session.userId) {
      // Orphaned row (FK SET NULL after user deletion). Mirrors the
      // MarkScopedSessionValidatorEnabledUseCase orphan posture —
      // persist the row flip + log structurally, skip the audit
      // (the audit row needs a userId to be queryable forensically).
      this.logger.warn(
        {
          sessionId: session.sessionId,
          orphanMirrorRow: true,
        },
        'ValidatorInstallFailed flip on orphaned session row — audit skipped',
      );
      return;
    }
    try {
      // Milliseconds since the session's TTL window closed (the
      // trigger condition), NOT since mint.
      const expiredMs = now.getTime() - session.validUntilSec * 1000;
      await this.appendAudit.execute({
        userId: session.userId,
        surface: session.surface,
        eventType: AuditEventType.ValidatorInstallFailed,
        metadata: {
          sessionId: session.sessionId,
          permissionId: session.permissionId,
          signerAddressPrefix: session.signerAddress.slice(0, 10),
          mintedAt: session.mintedAt.toISOString(),
          validUntilSec: session.validUntilSec,
          expiredMs,
          reason: 'ttl_expired_without_install',
          source: 'watchdog',
        },
        now,
      });
    } catch (err) {
      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.sessionId,
          orphanMirrorRow: true,
        },
        'ValidatorInstallFailed audit emission failed — mirror row flipped, audit missing',
      );
    }
  }

  private async emitStaleAlert(
    session: ScopedSession,
    now: Date,
  ): Promise<void> {
    // Minutes since the session's TTL window closed (NOT since mint —
    // the trigger is TTL-expiry, see findExpiredPendingEnable).
    const expiredMs = now.getTime() - session.validUntilSec * 1000;
    const expiredMin = Math.max(0, Math.round(expiredMs / 60_000));
    // Match the OperatorAlertPayloadSchema (strict) — see
    // `infrastructure/operator/operator-alert-transport.ts`. The
    // bot worker's renderer collapses these fields into the final
    // Telegram message; we don't pre-format the wire shape here.
    // `shortMessage` is capped at 1024 chars; ours is ~500.
    const shortMessage =
      `Scoped session flipped pending → failed: TTL expired ${expiredMin}min ago without the validator ever installing (user minted but never completed a Path D buy, or every attempt failed). ` +
      `sessionId=${session.sessionId.slice(0, 32)}, signer=${session.signerAddress.slice(0, 10)}, ` +
      `permissionId=${session.permissionId ?? 'null'}, mintedAt=${session.mintedAt.toISOString()}. ` +
      `No operator action required unless this is unexpected; the affected user must re-mint to use autonomous buys.`;
    try {
      await this.alertTransport.notify({
        tokenSymbol: 'agent_scoped_session',
        errorClass: 'ValidatorInstallExpired',
        shortMessage: shortMessage.slice(0, 1024),
        severity: 'warn',
      });
    } catch (err) {
      this.logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.sessionId,
        },
        'operator alert emission failed (watchdog continued)',
      );
    }
  }
}
