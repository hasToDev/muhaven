import type { PolicyEngineTickUseCase } from '../../application/use-case/agent/policy/policy-engine-tick.use-case.js';
import { getLogger } from '../../core/logger.js';
import type { Logger } from 'pino';

export interface PolicyEngineCronConfig {
  intervalMs: number;
}

/**
 * Wraps `PolicyEngineTickUseCase` with the cron lifecycle pattern used
 * elsewhere in the backend (`NavWriterCron`, `BlockchainEventPoller`,
 * `TaxEventIndexer`). 60s default tick per ADR-0 / WAVE_PLAN P1.
 *
 * Each tick is single-flight — if a previous tick is still running when
 * the interval fires, the new fire is skipped. This prevents pile-up
 * during transient TN slowness (the bench saw 854ms p99 with one
 * Forbidden retry consuming up to 3000ms of retry budget; the next
 * tick's worth of work would happily wait another 60s).
 */
export class PolicyEngineCron {
  private readonly logger: Logger;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly tick: PolicyEngineTickUseCase,
    private readonly config: PolicyEngineCronConfig,
  ) {
    this.logger = getLogger('PolicyEngineCron');
  }

  start(): void {
    if (this.intervalHandle) {
      this.logger.warn('PolicyEngineCron already running');
      return;
    }
    this.logger.info({ intervalMs: this.config.intervalMs }, 'Starting policy engine cron');
    void this.safeTick();
    this.intervalHandle = setInterval(() => void this.safeTick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('PolicyEngineCron stopped');
    }
  }

  private async safeTick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous tick still running; skipping');
      return;
    }
    this.running = true;
    try {
      const result = await this.tick.execute();
      if (result.attempted > 0 || result.errors > 0) {
        this.logger.info(
          {
            attempted: result.attempted,
            paused: result.breachesAutoPaused,
            softFails: result.softFails,
            errors: result.errors,
          },
          'Policy engine tick complete',
        );
      } else {
        this.logger.debug('Policy engine tick — no policy-bound users');
      }
    } catch (err) {
      this.logger.error({ err }, 'Policy engine tick failed (caught at top level)');
    } finally {
      this.running = false;
    }
  }
}
