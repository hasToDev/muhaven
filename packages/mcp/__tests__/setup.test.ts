import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvDefaults,
  decideSetupAction,
  mintSessionKey,
  parseSetupFlags,
  runSetup,
  waitForBroker,
  type SetupDeps,
} from '../src/broker/setup.js';

describe('applyEnvDefaults', () => {
  it('sets backend + dashboard defaults when env is empty', () => {
    const result = applyEnvDefaults({ env: {}, platformId: 'linux', osRelease: '6.1.0' });
    expect(result.toSet.MUHAVEN_BACKEND_URL).toBe('https://api.muhaven.app');
    expect(result.toSet.MUHAVEN_DASHBOARD_URL).toBe('https://muhaven.app');
    expect(result.preserved).toEqual([]);
  });

  it('preserves existing backend + dashboard env without overwriting', () => {
    const result = applyEnvDefaults({
      env: {
        MUHAVEN_BACKEND_URL: 'https://api-stage.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'https://stage.muhaven.app',
      },
      platformId: 'linux',
      osRelease: '6.1.0',
    });
    expect(result.toSet.MUHAVEN_BACKEND_URL).toBeUndefined();
    expect(result.toSet.MUHAVEN_DASHBOARD_URL).toBeUndefined();
    expect(result.preserved).toContain('MUHAVEN_BACKEND_URL');
    expect(result.preserved).toContain('MUHAVEN_DASHBOARD_URL');
  });

  it('auto-defaults MUHAVEN_KEYRING=file on win32', () => {
    const result = applyEnvDefaults({ env: {}, platformId: 'win32', osRelease: '10.0.26200' });
    expect(result.toSet.MUHAVEN_KEYRING).toBe('file');
  });

  it('auto-defaults MUHAVEN_KEYRING=file on WSL2', () => {
    const result = applyEnvDefaults({
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      platformId: 'linux',
      osRelease: '5.15.0-microsoft-standard-WSL2',
    });
    expect(result.toSet.MUHAVEN_KEYRING).toBe('file');
  });

  it('auto-defaults MUHAVEN_KEYRING=file under SSH', () => {
    const result = applyEnvDefaults({
      env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' },
      platformId: 'linux',
      osRelease: '6.1.0',
    });
    expect(result.toSet.MUHAVEN_KEYRING).toBe('file');
  });

  it('auto-defaults MUHAVEN_KEYRING=file in devcontainer', () => {
    const result = applyEnvDefaults({
      env: { REMOTE_CONTAINERS: 'true' },
      platformId: 'linux',
      osRelease: '6.1.0',
    });
    expect(result.toSet.MUHAVEN_KEYRING).toBe('file');
  });

  it('auto-defaults MUHAVEN_KEYRING=file in GitHub Codespaces', () => {
    const result = applyEnvDefaults({
      env: { CODESPACES: 'true' },
      platformId: 'linux',
      osRelease: '6.1.0',
    });
    expect(result.toSet.MUHAVEN_KEYRING).toBe('file');
  });

  it('does NOT default MUHAVEN_KEYRING on native macOS / Linux desktop', () => {
    const result = applyEnvDefaults({ env: {}, platformId: 'darwin', osRelease: '24.0.0' });
    expect(result.toSet.MUHAVEN_KEYRING).toBeUndefined();
  });

  it('preserves explicit MUHAVEN_KEYRING=os even on Windows', () => {
    const result = applyEnvDefaults({
      env: { MUHAVEN_KEYRING: 'os' },
      platformId: 'win32',
      osRelease: '10.0.26200',
    });
    expect(result.toSet.MUHAVEN_KEYRING).toBeUndefined();
    expect(result.preserved).toContain('MUHAVEN_KEYRING');
  });

  it('treats empty-string env vars as unset (not preserved)', () => {
    const result = applyEnvDefaults({
      env: { MUHAVEN_BACKEND_URL: '' },
      platformId: 'linux',
      osRelease: '6.1.0',
    });
    expect(result.toSet.MUHAVEN_BACKEND_URL).toBe('https://api.muhaven.app');
    expect(result.preserved).not.toContain('MUHAVEN_BACKEND_URL');
  });
});

describe('mintSessionKey', () => {
  it('returns a 0x-prefixed 32-byte hex string', () => {
    const k = mintSessionKey();
    expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('returns a different value on each call', () => {
    const a = mintSessionKey();
    const b = mintSessionKey();
    expect(a).not.toEqual(b);
  });
});

describe('decideSetupAction', () => {
  it('returns spawn_and_login when broker is unreachable', () => {
    expect(decideSetupAction({ hello: null })).toBe('spawn_and_login');
  });

  it('returns login_only when broker is up but has no JWT', () => {
    expect(decideSetupAction({ hello: { hasJwt: false } })).toBe('login_only');
  });

  it('returns already_ready when broker is up and has a JWT', () => {
    expect(decideSetupAction({ hello: { hasJwt: true } })).toBe('already_ready');
  });
});

describe('parseSetupFlags', () => {
  it('returns defaults for empty argv', () => {
    expect(parseSetupFlags([])).toEqual({
      foreground: false,
      noLaunchBrowser: false,
      brokerEndpoint: undefined,
      backendBaseUrl: undefined,
      dashboardBaseUrl: undefined,
      skipLogin: false,
    });
  });

  it('parses --foreground and -f as the same flag', () => {
    expect(parseSetupFlags(['--foreground']).foreground).toBe(true);
    expect(parseSetupFlags(['-f']).foreground).toBe(true);
  });

  it('parses --skip-login', () => {
    expect(parseSetupFlags(['--skip-login']).skipLogin).toBe(true);
  });

  it('parses --no-launch-browser as a pass-through', () => {
    expect(parseSetupFlags(['--no-launch-browser']).noLaunchBrowser).toBe(true);
  });

  it('parses value flags with their argument', () => {
    const flags = parseSetupFlags([
      '--broker-endpoint',
      '/tmp/x.sock',
      '--backend-base-url',
      'https://api.example.test',
      '--dashboard-base-url',
      'https://dash.example.test',
    ]);
    expect(flags.brokerEndpoint).toBe('/tmp/x.sock');
    expect(flags.backendBaseUrl).toBe('https://api.example.test');
    expect(flags.dashboardBaseUrl).toBe('https://dash.example.test');
  });

  it('rejects unknown flags', () => {
    expect(() => parseSetupFlags(['--bogus'])).toThrow(/unknown flag/);
  });
});

describe('waitForBroker', () => {
  it('resolves on the first successful hello', async () => {
    const broker = { hello: vi.fn().mockResolvedValueOnce({ hasJwt: false }) };
    const sleep = vi.fn();
    const result = await waitForBroker({ broker, sleep, timeoutMs: 1000, intervalMs: 50 });
    expect(result).toEqual({ hasJwt: false });
    expect(broker.hello).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until hello succeeds', async () => {
    let calls = 0;
    const broker = {
      hello: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) throw new Error('not ready');
        return { hasJwt: true };
      }),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    // Inject a virtual clock so the deadline math is deterministic.
    let nowMs = 0;
    const result = await waitForBroker({
      broker,
      sleep,
      now: () => nowMs,
      timeoutMs: 1000,
      intervalMs: 50,
    });
    expect(result).toEqual({ hasJwt: true });
    expect(broker.hello).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws with the last error message on timeout', async () => {
    const broker = { hello: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    // Virtual clock — sleep advances the clock past the deadline so we
    // exit after a finite number of attempts.
    let nowMs = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      nowMs += ms;
    });
    await expect(
      waitForBroker({
        broker,
        sleep,
        now: () => nowMs,
        timeoutMs: 500,
        intervalMs: 200,
      }),
    ).rejects.toThrow(/did not become reachable within 500ms.*ECONNREFUSED/);
  });
});

// ---------- runSetup orchestrator (with fully-mocked deps) ----------

interface RunSetupHarness {
  output: string[];
  errOutput: string[];
  spawnDaemon: ReturnType<typeof vi.fn>;
  runLogin: ReturnType<typeof vi.fn>;
  runForegroundDaemon: ReturnType<typeof vi.fn>;
  waitForBroker: ReturnType<typeof vi.fn>;
  brokerHello: ReturnType<typeof vi.fn>;
  deps: SetupDeps;
}

function makeHarness(overrides: {
  helloResults?: Array<{ hasJwt: boolean } | Error>;
  waitForBrokerResult?: { hasJwt: boolean } | Error;
  loginExitCode?: number;
  env?: Record<string, string | undefined>;
  platformId?: NodeJS.Platform;
  osRelease?: string;
} = {}): RunSetupHarness {
  const output: string[] = [];
  const errOutput: string[] = [];

  const helloResults = overrides.helloResults ?? [new Error('ECONNREFUSED')];
  let helloIdx = 0;
  const brokerHello = vi.fn(async () => {
    const r = helloResults[helloIdx++] ?? helloResults[helloResults.length - 1];
    if (r instanceof Error) throw r;
    return r;
  });

  const spawnDaemon = vi.fn(() => 99999);
  const runLogin = vi.fn(async () => overrides.loginExitCode ?? 0);
  const runForegroundDaemon = vi.fn(async () => undefined);
  const waitForBrokerMock = vi.fn(async () => {
    if (overrides.waitForBrokerResult instanceof Error) throw overrides.waitForBrokerResult;
    return overrides.waitForBrokerResult ?? { hasJwt: false };
  });

  const deps: SetupDeps = {
    print: (line) => output.push(line),
    printErr: (line) => errOutput.push(line),
    mintSessionKey: () => '0x' + 'aa'.repeat(32),
    newBrokerClient: () => ({ hello: brokerHello }),
    spawnDaemon,
    waitForBroker: waitForBrokerMock,
    runLogin,
    runForegroundDaemon,
    resolveBinPath: () => '/usr/local/bin/muhaven-broker',
    env: overrides.env ?? {},
    platformId: overrides.platformId ?? 'linux',
    osRelease: overrides.osRelease ?? '6.1.0',
  };

  return {
    output,
    errOutput,
    spawnDaemon,
    runLogin,
    runForegroundDaemon,
    waitForBroker: waitForBrokerMock,
    brokerHello,
    deps,
  };
}

describe('runSetup orchestrator', () => {
  beforeEach(() => {
    // Isolate per-test process.env mutations introduced by runSetup.
    vi.stubEnv('MUHAVEN_BACKEND_URL', '');
    vi.stubEnv('MUHAVEN_DASHBOARD_URL', '');
    vi.stubEnv('MUHAVEN_KEYRING', '');
    vi.stubEnv('MUHAVEN_BROKER_SESSION_KEY', '');
    vi.stubEnv('MUHAVEN_BROKER_ENDPOINT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 2 + prints usage on unknown flag', async () => {
    const h = makeHarness();
    const code = await runSetup(['--bogus'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/unknown flag/);
    expect(h.errOutput.join('\n')).toMatch(/usage: muhaven-broker setup/);
  });

  it('foreground mode runs daemon attached without spawning a child', async () => {
    const h = makeHarness();
    const code = await runSetup(['--foreground'], h.deps);
    expect(code).toBe(0);
    expect(h.runForegroundDaemon).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.runLogin).not.toHaveBeenCalled();
  });

  it('spawn_and_login path: spawns daemon, waits, runs login, returns 0', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(0);
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(h.waitForBroker).toHaveBeenCalledTimes(1);
    expect(h.runLogin).toHaveBeenCalledTimes(1);
    expect(h.runLogin).toHaveBeenCalledWith([]);
    const stdout = h.output.join('\n');
    expect(stdout).toMatch(/Broker daemon: not running, starting one/);
    expect(stdout).toMatch(/Broker daemon: ready \(PID 99999/);
    expect(stdout).toMatch(/Setup complete/);
  });

  it('login_only path: skips spawn, runs login when broker up but no JWT', async () => {
    const h = makeHarness({
      helloResults: [{ hasJwt: false }],
      loginExitCode: 0,
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(0);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.waitForBroker).not.toHaveBeenCalled();
    expect(h.runLogin).toHaveBeenCalledTimes(1);
    expect(h.output.join('\n')).toMatch(/already reachable/);
  });

  it('already_ready path: skips spawn AND login when broker has JWT', async () => {
    const h = makeHarness({
      helloResults: [{ hasJwt: true }],
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(0);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.runLogin).not.toHaveBeenCalled();
    expect(h.output.join('\n')).toMatch(/Login: skipped — JWT already in keystore/);
  });

  it('--skip-login: spawns daemon but does not invoke login', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
    });
    const code = await runSetup(['--skip-login'], h.deps);
    expect(code).toBe(0);
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(h.runLogin).not.toHaveBeenCalled();
    expect(h.output.join('\n')).toMatch(/Login: skipped per --skip-login/);
  });

  it('returns login exit code + leaves daemon running on login failure', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 1,
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/login step failed/);
    expect(h.errOutput.join('\n')).toMatch(/daemon PID 99999/);
  });

  it('returns 1 when wait-for-broker times out', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: new Error('did not become reachable within 8000ms'),
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/did not become reachable/);
    expect(h.runLogin).not.toHaveBeenCalled();
  });

  it('passes --no-launch-browser through to login', async () => {
    const h = makeHarness({
      helloResults: [{ hasJwt: false }],
      loginExitCode: 0,
    });
    await runSetup(['--no-launch-browser'], h.deps);
    expect(h.runLogin).toHaveBeenCalledWith(['--no-launch-browser']);
  });

  it('passes value flag overrides through to spawned env + login', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runSetup(
      [
        '--backend-base-url',
        'https://api-stage.muhaven.app',
        '--dashboard-base-url',
        'https://stage.muhaven.app',
      ],
      h.deps,
    );
    const spawnArgs = h.spawnDaemon.mock.calls[0][0];
    expect(spawnArgs.env.MUHAVEN_BACKEND_URL).toBe('https://api-stage.muhaven.app');
    expect(spawnArgs.env.MUHAVEN_DASHBOARD_URL).toBe('https://stage.muhaven.app');
    const loginArgv = h.runLogin.mock.calls[0][0];
    expect(loginArgv).toContain('--backend-base-url');
    expect(loginArgv).toContain('https://api-stage.muhaven.app');
    expect(loginArgv).toContain('--dashboard-base-url');
    expect(loginArgv).toContain('https://stage.muhaven.app');
  });

  it('mints a fresh session key when not provided in env', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
    });
    await runSetup(['--skip-login'], h.deps);
    expect(h.output.join('\n')).toMatch(/Session key: minted fresh/);
    const spawnArgs = h.spawnDaemon.mock.calls[0][0];
    expect(spawnArgs.env.MUHAVEN_BROKER_SESSION_KEY).toBe('0x' + 'aa'.repeat(32));
  });

  it('preserves caller-supplied MUHAVEN_BROKER_SESSION_KEY', async () => {
    const caller = '0x' + '11'.repeat(32);
    vi.stubEnv('MUHAVEN_BROKER_SESSION_KEY', caller);
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      env: { MUHAVEN_BROKER_SESSION_KEY: caller },
    });
    await runSetup(['--skip-login'], h.deps);
    expect(h.output.join('\n')).toMatch(/Session key: using MUHAVEN_BROKER_SESSION_KEY from env/);
    const spawnArgs = h.spawnDaemon.mock.calls[0][0];
    expect(spawnArgs.env.MUHAVEN_BROKER_SESSION_KEY).toBe(caller);
  });
});
