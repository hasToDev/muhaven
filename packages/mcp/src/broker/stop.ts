/**
 * `muhaven-broker stop` — clean shutdown for the detached daemon spawned
 * by `muhaven-broker setup`.
 *
 * Flow:
 *   1. Probe broker via `hello()`. Not reachable → 0 (already stopped).
 *   2. Best-effort `clearJwt()` so the OS-keychain entry doesn't leak.
 *   3. Read `hello.pid` (protocol 0.3.0+; @muhaven/mcp@0.1.5+). On
 *      pre-0.1.5 daemons the field is absent — surface a manual-kill hint
 *      and exit 1.
 *   4. `process.kill(pid, 'SIGTERM')`. The daemon's `BrokerDaemon.stop()`
 *      tears down the listener + unlinks the socket cleanly.
 *   5. Poll `hello()` until it fails (= socket gone = daemon dead) or 5s
 *      elapses.
 *   6. On timeout: `process.kill(pid, 'SIGKILL')`.
 *
 * The pure orchestrator (`runStop`) takes injected IO so tests can
 * exercise every branch without spawning real processes.
 */

import type { BrokerClient } from '../clients/broker-client.js';

export interface StopDeps {
  print(line: string): void;
  printErr(line: string): void;
  /** Construct a broker client at the given endpoint. */
  newBrokerClient(
    endpoint: string,
    timeoutMs: number,
  ): Pick<BrokerClient, 'hello' | 'clearJwt'>;
  /** OS signal sender. Injectable for tests. Returns `true` on success,
   *  `false` if the target is gone, throws on permission errors. */
  killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  /** Sleeper, injectable for tests. */
  sleep(ms: number): Promise<void>;
  /** Resolved broker endpoint to talk to. */
  endpoint: string;
  /** Broker IPC timeout. */
  brokerTimeoutMs: number;
  /** Overall budget for SIGTERM → graceful exit before SIGKILL. Default 5000. */
  gracefulShutdownMs?: number;
  /** Per-attempt poll interval after SIGTERM. Default 200. */
  pollIntervalMs?: number;
  /**
   * Whether to clear the keystore JWT as part of the stop. Default `true`
   * — the `stop` subcommand wipes the JWT so the OS-keychain entry doesn't
   * linger. `muhaven-broker update` passes `false`: a key rotation stops
   * the old daemon but MUST preserve the device-flow JWT (broker identity,
   * independent of the session key) so the restarted daemon reuses it
   * instead of forcing a fresh device-code login. Wave 5 Option D OPEN-D.
   */
  clearJwtOnStop?: boolean;
  /**
   * Wave 5 Slice 2c — stop the keyless `muhaven-reinvest` runner the broker
   * auto-spawned. Wired ONLY by the `stop` subcommand (NOT by `update`'s
   * internal stopDaemon — a key rotation leaves the keyless runner running;
   * it reconnects over the stable socket). Best-effort: a failure is printed
   * but never changes the broker-stop exit code. Runs FIRST so no in-flight
   * runner cycle hits the broker while it's tearing down.
   */
  stopReinvest?(): Promise<{ status: string; pid?: number }>;
}

/**
 * Orchestrator. Returns the process exit code (0 on success / no-op).
 * Pure-ish — only injected IO (broker IPC + killProcess + sleep).
 */
export async function runStop(deps: StopDeps): Promise<number> {
  const gracefulShutdownMs = deps.gracefulShutdownMs ?? 5000;
  const pollIntervalMs = deps.pollIntervalMs ?? 200;

  const broker = deps.newBrokerClient(deps.endpoint, deps.brokerTimeoutMs);

  // 0. Wave 5 Slice 2c — stop the keyless reinvest runner FIRST (best-effort)
  // so no in-flight reinvest cycle hits the broker mid-teardown. Only the
  // `stop` subcommand wires this; `update` leaves the runner running.
  if (deps.stopReinvest) {
    try {
      const outcome = await deps.stopReinvest();
      if (outcome.status === 'not_running') {
        deps.print('Reinvest runner: not running.');
      } else if (outcome.status === 'error') {
        deps.print(`Reinvest runner: stop reported an error (PID ${outcome.pid ?? '?'}); continuing.`);
      } else {
        deps.print(`Reinvest runner: ${outcome.status} (PID ${outcome.pid ?? '?'}).`);
      }
    } catch (err) {
      deps.print(
        `Reinvest runner: stop threw (${err instanceof Error ? err.message : String(err)}); continuing with broker shutdown.`,
      );
    }
  }

  // 1. Probe.
  let hello;
  try {
    hello = await broker.hello();
  } catch {
    deps.print('Broker daemon: not running, nothing to stop.');
    return 0;
  }

  // 2. Best-effort JWT clear. Failure here is non-fatal — we'd rather kill
  // the daemon than abort because of a keystore hiccup. Skipped when
  // `clearJwtOnStop` is false (the `update` key-rotation path preserves the
  // JWT so the restarted daemon reuses it).
  if (deps.clearJwtOnStop ?? true) {
    try {
      await broker.clearJwt();
      deps.print('JWT cleared from keystore.');
    } catch (err) {
      deps.print(
        `Warning: clearJwt failed (${err instanceof Error ? err.message : String(err)}); continuing with daemon shutdown.`,
      );
    }
  }

  // 3. PID lookup.
  const pid = hello.pid;
  if (pid === undefined) {
    deps.printErr(
      'Broker daemon did not advertise its PID (older than @muhaven/mcp@0.1.5).',
    );
    deps.printErr('Stop manually with:');
    deps.printErr('  POSIX:   pkill -f muhaven-broker');
    deps.printErr('  Windows: Stop-Process -Name node -Force  (filter to muhaven-broker)');
    return 1;
  }

  // 4. SIGTERM.
  try {
    deps.killProcess(pid, 'SIGTERM');
    deps.print(`Sent SIGTERM to broker daemon (PID ${pid}). Waiting up to ${gracefulShutdownMs}ms for clean exit...`);
  } catch (err) {
    deps.printErr(
      `Failed to send SIGTERM to PID ${pid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // 5. Poll until the daemon stops answering.
  const maxAttempts = Math.ceil(gracefulShutdownMs / pollIntervalMs);
  for (let i = 0; i < maxAttempts; i++) {
    await deps.sleep(pollIntervalMs);
    try {
      await broker.hello();
      // still alive; loop
    } catch {
      deps.print('Broker daemon stopped cleanly.');
      return 0;
    }
  }

  // 6. SIGKILL fallback.
  deps.print(`Daemon did not exit after ${gracefulShutdownMs}ms — sending SIGKILL.`);
  try {
    deps.killProcess(pid, 'SIGKILL');
    deps.print(`Broker daemon force-killed (PID ${pid}).`);
    return 0;
  } catch (err) {
    deps.printErr(
      `Failed to SIGKILL PID ${pid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    deps.printErr(
      '  Daemon process may be orphaned. Inspect with `ps aux | grep muhaven-broker` and kill manually.',
    );
    return 1;
  }
}

/**
 * Default `killProcess` implementation backed by Node's `process.kill`.
 * Translates "process already gone" (ESRCH) into a `false` return; other
 * errors propagate.
 */
export function defaultKillProcess(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // Process is already gone.
      return false;
    }
    throw err;
  }
}
