/**
 * Wave 5 Slice 2c — tests for the reinvest spawn/stop lifecycle
 * (`src/reinvest/lifecycle.ts`). The load-bearing assertion: the spawned
 * runner NEVER receives the session-key private half (keyless separation
 * of duties), and `stopReinvestRunner` drives the pidfile → SIGTERM →
 * SIGKILL ladder.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnReinvestRunner, stopReinvestRunner, reinvestRunnerPid } from '../src/reinvest/lifecycle.js';

const tmpDirs: string[] = [];
function tmpPid(): string {
  const d = mkdtempSync(join(tmpdir(), 'reinvest-test-'));
  tmpDirs.push(d);
  return join(d, 'reinvest.pid');
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('spawnReinvestRunner', () => {
  it('STRIPS the session key + dangerous NODE_* vars from the child env (keyless)', () => {
    let captured: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = vi.fn().mockImplementation((_exe: string, _argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
      captured = opts.env;
      return { pid: 4242, unref: () => {} };
    });
    const pid = spawnReinvestRunner({
      binPath: '/pkg/bin/muhaven-reinvest.cjs',
      spawnImpl: fakeSpawn as never,
      logFilePath: null, // don't open a real fd in tests
      sourceEnv: {
        MUHAVEN_BROKER_SESSION_KEY: '0x' + '1'.repeat(64),
        NODE_OPTIONS: '--require=/tmp/evil.js',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        MUHAVEN_BUNDLER_URL: 'https://bundler.example',
        MUHAVEN_SUBSCRIPTION_ADDRESS: '0x' + '2'.repeat(40),
        PATH: '/usr/bin',
      },
      env: { MUHAVEN_BACKEND_URL: 'https://api.muhaven.app' },
    });
    expect(pid).toBe(4242);
    expect(captured).toBeDefined();
    // Keyless: the session key is GONE.
    expect(captured!.MUHAVEN_BROKER_SESSION_KEY).toBeUndefined();
    // Dangerous NODE_* stripped.
    expect(captured!.NODE_OPTIONS).toBeUndefined();
    expect(captured!.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    // Operator config inherited.
    expect(captured!.MUHAVEN_BUNDLER_URL).toBe('https://bundler.example');
    expect(captured!.MUHAVEN_SUBSCRIPTION_ADDRESS).toBe('0x' + '2'.repeat(40));
    expect(captured!.PATH).toBe('/usr/bin');
    // Explicit env layered on.
    expect(captured!.MUHAVEN_BACKEND_URL).toBe('https://api.muhaven.app');
  });

  it('redirects the detached runner stderr to a logfile fd (stdout/IPC stay ignore)', () => {
    let captured: { stdio?: unknown } | undefined;
    const fakeSpawn = vi.fn().mockImplementation((_e: string, _a: string[], opts: { stdio?: unknown }) => {
      captured = opts;
      return { pid: 7, unref: () => {} };
    });
    const logPath = join(mkdtempSync(join(tmpdir(), 'reinvest-log-')), 'reinvest.log');
    tmpDirs.push(dirname(logPath));
    spawnReinvestRunner({
      binPath: '/x.cjs',
      spawnImpl: fakeSpawn as never,
      sourceEnv: { PATH: '/usr/bin' },
      logFilePath: logPath,
    });
    const stdio = captured!.stdio as [unknown, unknown, unknown];
    expect(stdio[0]).toBe('ignore');
    expect(stdio[1]).toBe('ignore');
    expect(typeof stdio[2]).toBe('number'); // an open fd for the logfile
    expect(existsSync(logPath)).toBe(true);
  });

  it('drops the session key even if a caller smuggles it via explicit env', () => {
    let captured: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = vi.fn().mockImplementation((_e: string, _a: string[], opts: { env: NodeJS.ProcessEnv }) => {
      captured = opts.env;
      return { pid: 1, unref: () => {} };
    });
    spawnReinvestRunner({
      binPath: '/x.cjs',
      spawnImpl: fakeSpawn as never,
      logFilePath: null,
      sourceEnv: { PATH: '/usr/bin' },
      env: { MUHAVEN_BROKER_SESSION_KEY: '0x' + 'f'.repeat(64) } as Record<string, string>,
    });
    expect(captured!.MUHAVEN_BROKER_SESSION_KEY).toBeUndefined();
  });
});

describe('stopReinvestRunner', () => {
  it('returns not_running when there is no pidfile', async () => {
    const out = await stopReinvestRunner({ pidFilePath: tmpPid() });
    expect(out).toEqual({ status: 'not_running' });
  });

  it('SIGTERMs the pid + clears the pidfile on a graceful exit', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '9999\n');
    let aliveCalls = 0;
    const kill = vi.fn().mockReturnValue(true);
    const isAlive = vi.fn().mockImplementation(() => {
      aliveCalls += 1;
      return aliveCalls < 2; // alive once, then exits
    });
    const out = await stopReinvestRunner({
      pidFilePath: pidPath,
      killProcess: kill,
      isAlive,
      verifyTarget: () => true,
      sleep: async () => {},
    });
    expect(out).toEqual({ status: 'stopped', pid: 9999 });
    expect(kill).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(existsSync(pidPath)).toBe(false);
  });

  it('escalates to SIGKILL when the process refuses to exit', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '8888\n');
    const kill = vi.fn().mockReturnValue(true);
    const out = await stopReinvestRunner({
      pidFilePath: pidPath,
      killProcess: kill,
      isAlive: () => true, // never dies
      verifyTarget: () => true,
      sleep: async () => {},
      gracefulShutdownMs: 400,
      pollIntervalMs: 200,
    });
    expect(out).toEqual({ status: 'killed', pid: 8888 });
    expect(kill).toHaveBeenCalledWith(8888, 'SIGKILL');
    expect(existsSync(pidPath)).toBe(false);
  });

  it('clears a stale pidfile when the process is already gone', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '7777\n');
    const out = await stopReinvestRunner({
      pidFilePath: pidPath,
      killProcess: () => false, // ESRCH → already gone
      isAlive: () => false,
      verifyTarget: () => true,
      sleep: async () => {},
    });
    expect(out).toEqual({ status: 'not_running' });
    expect(existsSync(pidPath)).toBe(false);
  });

  it('reinvestRunnerPid returns the live PID when alive + identity matches (boot guard)', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '3210\n');
    const pid = await reinvestRunnerPid({
      pidFilePath: pidPath,
      isAlive: () => true,
      verifyTarget: () => true,
    });
    expect(pid).toBe(3210);
  });

  it('reinvestRunnerPid returns null + clears a stale (dead) pidfile', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '3211\n');
    const pid = await reinvestRunnerPid({ pidFilePath: pidPath, isAlive: () => false });
    expect(pid).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('reinvestRunnerPid returns null when the live PID is not our runner', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '3212\n');
    const pid = await reinvestRunnerPid({
      pidFilePath: pidPath,
      isAlive: () => true,
      verifyTarget: () => false,
    });
    expect(pid).toBeNull();
  });

  it('does NOT signal a recycled PID that is no longer our runner (PID-reuse guard)', async () => {
    const pidPath = tmpPid();
    writeFileSync(pidPath, '5555\n');
    const kill = vi.fn().mockReturnValue(true);
    const out = await stopReinvestRunner({
      pidFilePath: pidPath,
      killProcess: kill,
      verifyTarget: () => false, // PID exists but isn't muhaven-reinvest
      sleep: async () => {},
    });
    expect(out).toEqual({ status: 'not_running' });
    expect(kill).not.toHaveBeenCalled(); // never signalled the unrelated process
    expect(existsSync(pidPath)).toBe(false); // stale pidfile cleared
  });
});
