/**
 * Wave 5 Slice 2c — spawn / stop helpers for the `muhaven-reinvest` runner,
 * used by BOTH the runner's own CLI AND the broker's auto-spawn lifecycle
 * (`broker start`/`setup` spawn it; `broker stop` kills it).
 *
 * Kept dependency-light (only node built-ins + pidfile + the default-path
 * helper) so the broker bundle does NOT pull in the runner's client +
 * bundler surface when it imports the spawn/stop helpers.
 *
 * THE LOAD-BEARING SECURITY PROPERTY: `spawnReinvestRunner` STRIPS
 * `MUHAVEN_BROKER_SESSION_KEY` from the child env. The runner is KEYLESS —
 * it asks the broker to sign over the local socket; it must never receive
 * the session-key private half (Option D separation of duties). It also
 * strips the same dangerous `NODE_*` vars the broker daemon spawn strips.
 */

import { spawn } from 'node:child_process';
import { readFileSync, openSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { readReinvestPid, clearReinvestPid } from './pidfile.js';
import { defaultReinvestPidPath, defaultReinvestLogPath } from './config.js';

/** Env vars that let a same-user attacker hijack the long-lived process —
 *  stripped from the spawned runner (mirrors broker `DANGEROUS_NODE_ENV_VARS`). */
const DANGEROUS_NODE_ENV_VARS = [
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
] as const;

/** The session key MUST NEVER reach the keyless runner. */
const FORBIDDEN_RUNNER_ENV_VARS = ['MUHAVEN_BROKER_SESSION_KEY'] as const;

export interface SpawnReinvestOptions {
  /** Absolute path to the `muhaven-reinvest.cjs` bin entry. */
  readonly binPath: string;
  /** Explicit env to layer over the (sanitized) inherited env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Node executable. Defaults to `process.execPath`; injectable for tests. */
  readonly execPath?: string;
  /** Spawn impl — injectable for tests. */
  readonly spawnImpl?: typeof spawn;
  /** Source env to inherit from. Defaults to `process.env`; injectable. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /**
   * Logfile to redirect the detached runner's stderr to (its JSON log
   * lines). Defaults to `~/.muhaven/reinvest.log`. `null` → `'ignore'`
   * (the pre-logfile behaviour; used by tests that don't want a real fd).
   */
  readonly logFilePath?: string | null;
}

/**
 * Spawn the runner as a detached child. Returns the PID. Inherits the
 * (sanitized) parent env — so the operator's MUHAVEN_BUNDLER_URL /
 * MUHAVEN_SUBSCRIPTION_ADDRESS / backend URL flow through — minus the
 * session key + dangerous NODE_* vars.
 */
export function spawnReinvestRunner(options: SpawnReinvestOptions): number {
  const sourceEnv = options.sourceEnv ?? process.env;
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if ((DANGEROUS_NODE_ENV_VARS as readonly string[]).includes(k)) continue;
    if ((FORBIDDEN_RUNNER_ENV_VARS as readonly string[]).includes(k)) continue;
    sanitized[k] = v;
  }
  const merged: NodeJS.ProcessEnv = { ...sanitized, ...(options.env ?? {}) };
  // Belt-and-suspenders: even if a caller passed the key in `env`, drop it.
  for (const k of FORBIDDEN_RUNNER_ENV_VARS) delete merged[k];

  // Redirect the detached runner's stderr to a logfile so a silent-idle /
  // crash-looping runner is debuggable (the broker spawns it with no
  // attached terminal). Best-effort: a logfile open failure falls back to
  // 'ignore' rather than failing the spawn. `logFilePath: null` opts out
  // (tests). stdout/IPC stay 'ignore' — the runner isn't an IPC server.
  let stderrTarget: 'ignore' | number = 'ignore';
  const logPath = options.logFilePath === undefined ? defaultReinvestLogPath() : options.logFilePath;
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      stderrTarget = openSync(logPath, 'a', 0o600);
    } catch {
      stderrTarget = 'ignore';
    }
  }

  const spawnFn = options.spawnImpl ?? spawn;
  const child = spawnFn(options.execPath ?? process.execPath, [options.binPath], {
    detached: true,
    stdio: ['ignore', 'ignore', stderrTarget],
    windowsHide: true,
    env: merged,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('failed to spawn muhaven-reinvest runner — child pid is undefined');
  }
  return child.pid;
}

export interface StopReinvestDeps {
  readonly pidFilePath?: string;
  /** Returns true on success, false if the target is gone, throws on perm errors. */
  readonly killProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Liveness probe — true while the process exists (signal 0). */
  readonly isAlive?: (pid: number) => boolean;
  readonly gracefulShutdownMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Verify the pidfile's PID still belongs to a `muhaven-reinvest` process
   * BEFORE signalling it — guards against PID reuse (a crashed/SIGKILLed
   * runner leaves a stale pidfile; the OS can recycle that PID for an
   * unrelated process, which `stop` would otherwise SIGTERM/SIGKILL).
   * Defaults to a `/proc/<pid>/cmdline` cmdline match on Linux (the prod
   * homelab target); returns `true` on platforms where we can't cheaply
   * verify (best-effort — same posture as today there). Injectable for tests.
   */
  readonly verifyTarget?: (pid: number) => boolean;
}

export type StopReinvestOutcome =
  | { readonly status: 'not_running' }
  | { readonly status: 'stopped'; readonly pid: number }
  | { readonly status: 'killed'; readonly pid: number }
  | { readonly status: 'error'; readonly pid: number; readonly reason: string };

function defaultKill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours (still "alive").
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Default PID-reuse guard. On Linux reads `/proc/<pid>/cmdline` (NUL-
 * separated argv) and confirms it mentions `muhaven-reinvest` — so a
 * recycled PID now held by an unrelated process is NOT signalled. On
 * non-Linux we can't read this cheaply, so return `true` (best-effort,
 * unchanged behaviour there). A read failure (race: process exited) → `false`
 * so the caller treats it as not-running + clears the stale pidfile.
 */
function defaultVerifyTarget(pid: number): boolean {
  if (platform() !== 'linux') return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('muhaven-reinvest');
  } catch {
    return false;
  }
}

/**
 * Whether a `muhaven-reinvest` runner is ALREADY running per the pidfile
 * (live PID + identity match). Used by the runner's own boot path to refuse
 * a second instance — two runners would race independent in-process cooldown
 * maps and could double-submit a reinvest. Returns the live PID or null.
 */
export async function reinvestRunnerPid(
  deps: { pidFilePath?: string; isAlive?: (pid: number) => boolean; verifyTarget?: (pid: number) => boolean } = {},
): Promise<number | null> {
  const pidPath = deps.pidFilePath ?? defaultReinvestPidPath();
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const verify = deps.verifyTarget ?? defaultVerifyTarget;
  const pid = await readReinvestPid(pidPath);
  if (pid === null) return null;
  if (!isAlive(pid)) {
    await clearReinvestPid(pidPath); // stale
    return null;
  }
  return verify(pid) ? pid : null;
}

/**
 * Stop the runner via its pidfile: SIGTERM, poll for exit, SIGKILL fallback,
 * then clear the pidfile. Idempotent — a missing / stale pidfile resolves to
 * `not_running`. Pure-ish: all IO injectable for tests.
 */
export async function stopReinvestRunner(deps: StopReinvestDeps = {}): Promise<StopReinvestOutcome> {
  const pidPath = deps.pidFilePath ?? defaultReinvestPidPath();
  const kill = deps.killProcess ?? defaultKill;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gracefulMs = deps.gracefulShutdownMs ?? 5000;
  const pollMs = deps.pollIntervalMs ?? 200;

  const pid = await readReinvestPid(pidPath);
  if (pid === null) return { status: 'not_running' };

  // PID-reuse guard: only signal a PID that still looks like our runner.
  const verify = deps.verifyTarget ?? defaultVerifyTarget;
  if (!verify(pid)) {
    // Stale pidfile (runner exited / crashed; PID possibly recycled) — clear
    // it and report not-running rather than SIGTERM an unrelated process.
    await clearReinvestPid(pidPath);
    return { status: 'not_running' };
  }

  let sentTerm: boolean;
  try {
    sentTerm = kill(pid, 'SIGTERM');
  } catch (err) {
    return { status: 'error', pid, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!sentTerm) {
    // Process already gone — clear the stale pidfile.
    await clearReinvestPid(pidPath);
    return { status: 'not_running' };
  }

  const attempts = Math.ceil(gracefulMs / pollMs);
  for (let i = 0; i < attempts; i++) {
    await sleep(pollMs);
    if (!isAlive(pid)) {
      await clearReinvestPid(pidPath);
      return { status: 'stopped', pid };
    }
  }
  // SIGKILL fallback.
  try {
    kill(pid, 'SIGKILL');
  } catch (err) {
    return { status: 'error', pid, reason: err instanceof Error ? err.message : String(err) };
  }
  await clearReinvestPid(pidPath);
  return { status: 'killed', pid };
}
