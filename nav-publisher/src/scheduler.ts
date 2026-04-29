/**
 * Scheduler — interval-based cycle runner. One cycle in flight at a
 * time; if a cycle is still running when its tick fires, the new tick
 * is dropped (logged) so we never stack overlapping submits.
 */
import { runPublishCycle, type CycleResult } from './publisher.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastCycleAt: Date | null = null;
let lastResult: CycleResult | null = null;
let cycleInFlight = false;

async function tick(): Promise<void> {
  if (cycleInFlight) {
    console.warn('[scheduler] previous cycle still in flight — skipping this tick');
    return;
  }
  cycleInFlight = true;
  console.log(`[scheduler] starting publish cycle at ${new Date().toISOString()}`);
  try {
    lastResult = await runPublishCycle();
    lastCycleAt = new Date();
    console.log(
      `[scheduler] cycle complete: visited=${lastResult.visited}, published=${lastResult.published}, skipped=${lastResult.skipped}, errors=${lastResult.errors}`,
    );
  } catch (err) {
    console.error('[scheduler] cycle failed:', err);
    lastCycleAt = new Date();
  } finally {
    cycleInFlight = false;
  }
}

/**
 * Start the scheduler. Runs immediately on first call, then at interval.
 * The first cycle is intentionally fire-and-forget so HTTP /health
 * answers `degraded` until a cycle completes — the caller can monitor.
 */
export function startScheduler(intervalMs: number): void {
  if (intervalHandle) {
    console.warn('[scheduler] already running');
    return;
  }
  console.log(`[scheduler] starting with interval ${intervalMs}ms (${(intervalMs / 60_000).toFixed(1)}min)`);
  void tick();
  intervalHandle = setInterval(() => void tick(), intervalMs);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[scheduler] stopped');
  }
}

export function getSchedulerStatus() {
  return {
    running: intervalHandle !== null,
    cycleInFlight,
    lastCycleAt: lastCycleAt?.toISOString() ?? null,
    lastResult,
  };
}
