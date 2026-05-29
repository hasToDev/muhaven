import { describe, expect, it, vi } from 'vitest';
import { defaultKillProcess, runStop, type StopDeps } from '../src/broker/stop.js';
import type { BrokerClient } from '../src/clients/broker-client.js';

interface StopHarness {
  output: string[];
  errOutput: string[];
  brokerHello: ReturnType<typeof vi.fn>;
  brokerClearJwt: ReturnType<typeof vi.fn>;
  killProcess: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  stopReinvest: ReturnType<typeof vi.fn>;
  deps: StopDeps;
}

function makeHarness(opts: {
  helloResults?: Array<{ pid?: number; hasJwt?: boolean } | Error>;
  clearJwtBehavior?: 'ok' | Error;
  killBehavior?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  gracefulShutdownMs?: number;
  pollIntervalMs?: number;
  clearJwtOnStop?: boolean;
  withStopReinvest?: boolean;
} = {}): StopHarness {
  const output: string[] = [];
  const errOutput: string[] = [];

  const helloResults = opts.helloResults ?? [new Error('ECONNREFUSED')];
  let helloIdx = 0;
  const brokerHello = vi.fn(async () => {
    const r = helloResults[helloIdx];
    helloIdx = Math.min(helloIdx + 1, helloResults.length - 1);
    if (r instanceof Error) throw r;
    return {
      type: 'hello' as const,
      version: '0.3.0',
      sessionKeyAddress: '0x0000000000000000000000000000000000000000' as const,
      hasJwt: r.hasJwt ?? true,
      hasSessionKey: true,
      ...(r.pid !== undefined ? { pid: r.pid } : {}),
    };
  });

  const clearBehavior = opts.clearJwtBehavior ?? 'ok';
  const brokerClearJwt = vi.fn(async () => {
    if (clearBehavior instanceof Error) throw clearBehavior;
    return { type: 'clear_jwt' as const, cleared: true as const };
  });

  const killProcess = vi.fn(opts.killBehavior ?? (() => true));
  const sleep = vi.fn(async () => undefined);
  const stopReinvest = vi.fn(async () => ({ status: 'stopped', pid: 4242 }));

  const deps: StopDeps = {
    print: (line) => output.push(line),
    printErr: (line) => errOutput.push(line),
    newBrokerClient: () =>
      ({
        hello: brokerHello,
        clearJwt: brokerClearJwt,
      } as unknown as Pick<BrokerClient, 'hello' | 'clearJwt'>),
    killProcess,
    sleep,
    endpoint: '/tmp/muhaven-broker.sock',
    brokerTimeoutMs: 2000,
    gracefulShutdownMs: opts.gracefulShutdownMs,
    pollIntervalMs: opts.pollIntervalMs,
    clearJwtOnStop: opts.clearJwtOnStop,
    ...(opts.withStopReinvest ? { stopReinvest } : {}),
  };

  return { output, errOutput, brokerHello, brokerClearJwt, killProcess, sleep, stopReinvest, deps };
}

describe('runStop', () => {
  it('returns 0 + prints "not running" when broker is unreachable', async () => {
    const h = makeHarness({ helloResults: [new Error('ECONNREFUSED')] });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.output.join('\n')).toMatch(/not running, nothing to stop/);
    expect(h.killProcess).not.toHaveBeenCalled();
  });

  it('graceful path: hello → clearJwt → SIGTERM → hello fails → return 0', async () => {
    const h = makeHarness({
      // hello[0]: returns pid (alive). hello[1]: throws (dead after SIGTERM).
      helloResults: [{ pid: 12345 }, new Error('ECONNREFUSED')],
      killBehavior: () => true,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.brokerClearJwt).toHaveBeenCalledTimes(1);
    expect(h.killProcess).toHaveBeenCalledTimes(1);
    expect(h.killProcess).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(h.output.join('\n')).toMatch(/JWT cleared from keystore/);
    expect(h.output.join('\n')).toMatch(/Sent SIGTERM to broker daemon \(PID 12345\)/);
    expect(h.output.join('\n')).toMatch(/Broker daemon stopped cleanly/);
  });

  it('stops the keyless reinvest runner FIRST when wired (stop subcommand)', async () => {
    const h = makeHarness({
      helloResults: [{ pid: 12345 }, new Error('ECONNREFUSED')],
      withStopReinvest: true,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.stopReinvest).toHaveBeenCalledTimes(1);
    expect(h.output.join('\n')).toMatch(/Reinvest runner: stopped \(PID 4242\)/);
  });

  it('still stops the reinvest runner even when the broker is already down', async () => {
    const h = makeHarness({ helloResults: [new Error('ECONNREFUSED')], withStopReinvest: true });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.stopReinvest).toHaveBeenCalledTimes(1);
  });

  it('does NOT stop the reinvest runner when stopReinvest is unwired (update path)', async () => {
    const h = makeHarness({ helloResults: [{ pid: 12345 }, new Error('ECONNREFUSED')] });
    await runStop(h.deps);
    expect(h.stopReinvest).not.toHaveBeenCalled();
  });

  it('returns 1 with manual-kill hint when daemon does not advertise pid (pre-0.1.5)', async () => {
    const h = makeHarness({
      helloResults: [{ /* no pid */ }],
    });
    const code = await runStop(h.deps);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/older than @muhaven\/mcp@0\.1\.5/);
    expect(h.errOutput.join('\n')).toMatch(/pkill -f muhaven-broker/);
    expect(h.killProcess).not.toHaveBeenCalled();
  });

  it('falls back to SIGKILL when daemon does not exit after gracefulShutdownMs', async () => {
    // hello always succeeds (daemon never exits gracefully). Should SIGKILL.
    const h = makeHarness({
      helloResults: [{ pid: 12345 }],
      killBehavior: () => true,
      gracefulShutdownMs: 400,
      pollIntervalMs: 100,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.killProcess).toHaveBeenCalledTimes(2);
    expect(h.killProcess).toHaveBeenNthCalledWith(1, 12345, 'SIGTERM');
    expect(h.killProcess).toHaveBeenNthCalledWith(2, 12345, 'SIGKILL');
    expect(h.output.join('\n')).toMatch(/did not exit after 400ms — sending SIGKILL/);
    expect(h.output.join('\n')).toMatch(/Broker daemon force-killed \(PID 12345\)/);
  });

  it('returns 1 when SIGTERM throws (permission denied)', async () => {
    const h = makeHarness({
      helloResults: [{ pid: 12345 }],
      killBehavior: () => {
        throw new Error('EPERM');
      },
    });
    const code = await runStop(h.deps);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/Failed to send SIGTERM to PID 12345.*EPERM/);
  });

  it('returns 1 when SIGKILL throws after SIGTERM timeout', async () => {
    let killCalls = 0;
    const h = makeHarness({
      helloResults: [{ pid: 12345 }],
      killBehavior: () => {
        killCalls += 1;
        if (killCalls === 1) return true; // SIGTERM succeeds
        throw new Error('EPERM'); // SIGKILL fails
      },
      gracefulShutdownMs: 200,
      pollIntervalMs: 100,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/Failed to SIGKILL PID 12345.*EPERM/);
    expect(h.errOutput.join('\n')).toMatch(/may be orphaned/);
  });

  it('clearJwtOnStop=false (update key-rotation path) preserves the JWT', async () => {
    // `muhaven-broker update` stops the old daemon but must NOT wipe the
    // device-flow JWT — the restarted daemon reuses it instead of forcing a
    // fresh device-code login.
    const h = makeHarness({
      helloResults: [{ pid: 12345 }, new Error('socket closed')],
      killBehavior: () => true,
      clearJwtOnStop: false,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.brokerClearJwt).not.toHaveBeenCalled();
    expect(h.output.join('\n')).not.toMatch(/JWT cleared/);
    expect(h.killProcess).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('clearJwtOnStop=true (default stop subcommand) still clears the JWT', async () => {
    const h = makeHarness({
      helloResults: [{ pid: 12345 }, new Error('socket closed')],
      killBehavior: () => true,
      clearJwtOnStop: true,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.brokerClearJwt).toHaveBeenCalledTimes(1);
    expect(h.output.join('\n')).toMatch(/JWT cleared from keystore/);
  });

  it('continues with kill even when clearJwt fails (warning, not abort)', async () => {
    const h = makeHarness({
      helloResults: [{ pid: 12345 }, new Error('socket closed')],
      clearJwtBehavior: new Error('keystore offline'),
      killBehavior: () => true,
    });
    const code = await runStop(h.deps);
    expect(code).toBe(0);
    expect(h.output.join('\n')).toMatch(/Warning: clearJwt failed.*keystore offline.*continuing/);
    expect(h.killProcess).toHaveBeenCalledWith(12345, 'SIGTERM');
  });
});

describe('defaultKillProcess', () => {
  it('returns false (no throw) when target process does not exist (ESRCH)', () => {
    // PID 1 is init/systemd on POSIX, but we don't send a real signal — we
    // expect process.kill to throw EPERM (not ESRCH) since we're not root.
    // Instead, use a definitely-nonexistent PID. Range guard: pick 9999999
    // (above typical max_pid).
    const FAKE_PID = 9999999;
    // On Windows the call surface is different but both should still raise
    // ESRCH for a nonexistent PID via Node's normalization.
    const result = defaultKillProcess(FAKE_PID, 'SIGTERM');
    expect(result).toBe(false);
  });

  it('rethrows non-ESRCH errors (e.g. EPERM on PID 1)', () => {
    // Skip on Windows — PID 1 doesn't map to a privileged init process the
    // same way, and the test would be flaky.
    if (process.platform === 'win32') return;
    expect(() => defaultKillProcess(1, 'SIGTERM')).toThrow();
  });
});
