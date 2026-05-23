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

import type { IScopedSessionRepository } from '../../domain/agent/repository/scoped-session.repository.js';
import type { ScopedSession } from '../../domain/agent/model/scoped-session.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';
import type { IOperatorAlertTransport } from '../operator/operator-alert-transport.js';

export interface ValidatorEnableWatchdogConfig {
  /** Rows with `mintedAt < now - staleThresholdSec` get flipped. */
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
      const cutoff = new Date(now.getTime() - this.config.staleThresholdSec * 1000);
      const stale = await this.scopedRepo.findPendingEnableOlderThan(
        cutoff,
        this.config.batchLimit,
      );
      for (const row of stale) {
        try {
          const result = await this.scopedRepo.markValidatorFailed(row.sessionId);
          if (result) {
            flipped++;
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

  private async emitStaleAlert(
    session: ScopedSession,
    now: Date,
  ): Promise<void> {
    const ageMs = now.getTime() - session.mintedAt.getTime();
    const ageMin = Math.round(ageMs / 60_000);
    // Match the OperatorAlertPayloadSchema (strict) — see
    // `infrastructure/operator/operator-alert-transport.ts`. The
    // bot worker's renderer collapses these fields into the final
    // Telegram message; we don't pre-format the wire shape here.
    // `shortMessage` is capped at 1024 chars; ours is ~500.
    const shortMessage =
      `Scoped session validator install watchdog flipping pending → failed after ${ageMin}min stale. ` +
      `sessionId=${session.sessionId.slice(0, 32)}, signer=${session.signerAddress.slice(0, 10)}, ` +
      `permissionId=${session.permissionId ?? 'null'}, mintedAt=${session.mintedAt.toISOString()}. ` +
      `Operator action: investigate broker/bundler/paymaster; user must re-mint Scoped tier.`;
    try {
      await this.alertTransport.notify({
        tokenSymbol: 'agent_scoped_session',
        errorClass: 'ValidatorInstallTimeout',
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
