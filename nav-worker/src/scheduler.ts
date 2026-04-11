/**
 * Scheduler — interval-based job runner.
 * Runs a fetch cycle at configurable intervals.
 */
import { runFetchCycle, type FetchCycleResult } from './engine.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastFetchAt: Date | null = null;
let lastResult: FetchCycleResult | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn('[scheduler] Previous cycle still running, skipping');
    return;
  }

  running = true;
  console.log(`[scheduler] Starting fetch cycle at ${new Date().toISOString()}`);
  try {
    lastResult = await runFetchCycle();
    lastFetchAt = new Date();
    console.log(
      `[scheduler] Cycle complete: fetched=${lastResult.fetched}, written=${lastResult.written}, skipped=${lastResult.skipped}, errors=${lastResult.errors}`,
    );
  } catch (err) {
    console.error('[scheduler] Fetch cycle failed:', err);
    lastFetchAt = new Date();
  } finally {
    running = false;
  }
}

/**
 * Start the scheduler. Runs immediately on first call, then at interval.
 */
export function startScheduler(intervalMs: number): void {
  if (intervalHandle) {
    console.warn('[scheduler] Already running');
    return;
  }

  console.log(`[scheduler] Starting with interval ${intervalMs}ms (${intervalMs / 60_000}min)`);

  // Run immediately on startup
  tick();

  // Then on interval
  intervalHandle = setInterval(tick, intervalMs);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[scheduler] Stopped');
  }
}

export function getSchedulerStatus() {
  return {
    running: intervalHandle !== null,
    lastFetchAt: lastFetchAt?.toISOString() ?? null,
    lastResult,
  };
}
