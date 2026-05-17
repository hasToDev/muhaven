import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvDefaults,
  buildClaudeMcpAddJsonArgv,
  buildClaudeMcpRegisterJson,
  buildClaudeMcpRemoveArgv,
  buildRegisterEnv,
  decideSetupAction,
  KNOWN_REGISTER_HOSTS,
  KNOWN_REGISTER_SCOPES,
  mintSessionKey,
  parseSetupFlags,
  registerWithHost,
  runSetup,
  validateBrokerEndpointFlag,
  validateHttpUrlFlag,
  waitForBroker,
  type RegisterHost,
  type SetupDeps,
  type ShellResult,
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

  it('produces a value in the valid secp256k1 scalar range (via viem)', () => {
    // viem's generatePrivateKey rejects 0 and values ≥ curve order. Sample
    // a batch + assert none are 0x00...00 (the only failure mode visible
    // without importing the curve order constant).
    for (let i = 0; i < 256; i++) {
      const k = mintSessionKey();
      expect(k).not.toBe('0x' + '00'.repeat(32));
    }
  });
});

describe('validateHttpUrlFlag', () => {
  it('accepts https URLs', () => {
    expect(validateHttpUrlFlag('--backend-base-url', 'https://api.muhaven.app')).toBeNull();
    expect(validateHttpUrlFlag('--backend-base-url', 'https://api-stage.muhaven.app/')).toBeNull();
  });

  it('accepts http://localhost and http://127.0.0.1 (dev carve-out)', () => {
    expect(validateHttpUrlFlag('--backend-base-url', 'http://localhost:3000')).toBeNull();
    expect(validateHttpUrlFlag('--backend-base-url', 'http://127.0.0.1:8080')).toBeNull();
    expect(validateHttpUrlFlag('--backend-base-url', 'http://[::1]:3000')).toBeNull();
  });

  it('rejects http://<non-loopback>', () => {
    const err = validateHttpUrlFlag('--backend-base-url', 'http://evil.example.com');
    expect(err).toMatch(/must use https/);
    expect(err).toMatch(/refusing to ship JWT cleartext/);
  });

  it('rejects javascript: / file: / data: schemes', () => {
    expect(validateHttpUrlFlag('--backend-base-url', 'javascript:alert(1)')).toMatch(/must use https/);
    expect(validateHttpUrlFlag('--backend-base-url', 'file:///etc/passwd')).toMatch(/must use https/);
    expect(validateHttpUrlFlag('--backend-base-url', 'data:text/html,<script>')).toMatch(/must use https/);
  });

  it('rejects unparseable input', () => {
    expect(validateHttpUrlFlag('--backend-base-url', 'not a url')).toMatch(/not a valid URL/);
    expect(validateHttpUrlFlag('--backend-base-url', '')).toMatch(/not a valid URL/);
  });
});

describe('validateBrokerEndpointFlag', () => {
  it('accepts \\\\.\\pipe\\... paths on win32', () => {
    expect(validateBrokerEndpointFlag('\\\\.\\pipe\\muhaven-broker-alice', 'win32')).toBeNull();
    // forward-slash spelling seen in Git Bash on Windows
    expect(validateBrokerEndpointFlag('//./pipe/muhaven-broker-alice', 'win32')).toBeNull();
  });

  it('rejects non-pipe paths on win32', () => {
    expect(validateBrokerEndpointFlag('/tmp/muhaven-broker.sock', 'win32')).toMatch(/named pipe/);
    expect(validateBrokerEndpointFlag('C:\\Users\\evil\\fake', 'win32')).toMatch(/named pipe/);
  });

  it('accepts absolute paths on POSIX', () => {
    expect(validateBrokerEndpointFlag('/run/muhaven/broker.sock', 'linux')).toBeNull();
    expect(validateBrokerEndpointFlag('/Users/alice/.muhaven/broker.sock', 'darwin')).toBeNull();
  });

  it('rejects relative paths on POSIX', () => {
    expect(validateBrokerEndpointFlag('./broker.sock', 'linux')).toMatch(/absolute path/);
    expect(validateBrokerEndpointFlag('../broker.sock', 'linux')).toMatch(/absolute path/);
    expect(validateBrokerEndpointFlag('broker.sock', 'linux')).toMatch(/absolute path/);
  });

  it('rejects empty string on both platforms', () => {
    expect(validateBrokerEndpointFlag('', 'win32')).toMatch(/cannot be empty/);
    expect(validateBrokerEndpointFlag('', 'linux')).toMatch(/cannot be empty/);
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
      register: [],
      registerScope: 'user',
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
  shellOut: ReturnType<typeof vi.fn>;
  /** Per-test scripted shellOut responses, keyed by the cmd+argv joined string.
   *  Tests push entries via h.scriptShell(...). Falls back to a successful empty
   *  ShellResult so legacy tests that don't use --register stay green. */
  shellScript: Map<string, ShellResult | Error>;
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

  const shellScript = new Map<string, ShellResult | Error>();
  const shellOut = vi.fn(async (cmd: string, argv: readonly string[]): Promise<ShellResult> => {
    const key = `${cmd} ${argv.join(' ')}`;
    const scripted = shellScript.get(key);
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    // Default: success with no output. Lets legacy tests that don't
    // touch --register pass without scripting. Register-flow tests
    // explicitly script every call.
    return { exitCode: 0, stdout: '', stderr: '' };
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
    shellOut,
  };

  return {
    output,
    errOutput,
    spawnDaemon,
    runLogin,
    runForegroundDaemon,
    waitForBroker: waitForBrokerMock,
    brokerHello,
    shellOut,
    shellScript,
    deps,
  };
}

/** Helper: script a shellOut response. Key is `cmd argv...joined with spaces`. */
function scriptShell(
  h: RunSetupHarness,
  cmd: string,
  argv: readonly string[],
  result: ShellResult | Error,
): void {
  h.shellScript.set(`${cmd} ${argv.join(' ')}`, result);
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

  // ---------- security regressions ----------

  it('does NOT echo the session-key value to stdout / stderr', async () => {
    // Use a grep-able sentinel for the harness's mintSessionKey mock.
    const SENTINEL = 'aa'.repeat(32);
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runSetup([], h.deps);
    const all = [...h.output, ...h.errOutput].join('\n');
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('0x' + SENTINEL);
  });

  it('does NOT mutate process.env.MUHAVEN_BROKER_SESSION_KEY (no leak to later children)', async () => {
    vi.stubEnv('MUHAVEN_BROKER_SESSION_KEY', '');
    expect(process.env.MUHAVEN_BROKER_SESSION_KEY).toBe('');
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runSetup([], h.deps);
    // After setup returns, process.env must NOT contain the minted key — it
    // lives only in the spawned daemon's env and in this orchestrator's
    // local var (released at function exit).
    expect(process.env.MUHAVEN_BROKER_SESSION_KEY).toBe('');
  });

  it('does NOT echo preserved env values (only names — they belong to the operator)', async () => {
    const SENTINEL_URL = 'https://api-preserved-secret.example.test';
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
      env: { MUHAVEN_BACKEND_URL: SENTINEL_URL },
    });
    await runSetup(['--skip-login'], h.deps);
    const stdout = h.output.join('\n');
    expect(stdout).toMatch(/Env preserved: MUHAVEN_BACKEND_URL/);
    // Value MUST NOT appear in any output line — it's operator-supplied
    // material, treat as opaque.
    expect(stdout).not.toContain(SENTINEL_URL);
  });

  it('always prints endpoint in the closing summary (even on already_ready path)', async () => {
    const h = makeHarness({
      helloResults: [{ hasJwt: true }],
    });
    await runSetup([], h.deps);
    const stdout = h.output.join('\n');
    expect(stdout).toMatch(/Setup complete/);
    expect(stdout).toMatch(/Endpoint\s*:/);
    expect(stdout).toMatch(/Daemon\s*:\s*already running/);
  });

  it('closing summary uses Stop-Process on win32, kill on POSIX', async () => {
    const hWin = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
      platformId: 'win32',
    });
    await runSetup([], hWin.deps);
    const win = hWin.output.join('\n');
    expect(win).toMatch(/Stop daemon: Stop-Process -Id 99999/);
    expect(win).not.toMatch(/Stop daemon: kill/);

    const hPosix = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
      platformId: 'linux',
    });
    await runSetup([], hPosix.deps);
    const posix = hPosix.output.join('\n');
    expect(posix).toMatch(/Stop daemon: kill 99999/);
    expect(posix).not.toMatch(/Stop daemon: Stop-Process/);
  });

  it('closing summary documents logout as JWT-only (not daemon shutdown)', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runSetup([], h.deps);
    const stdout = h.output.join('\n');
    expect(stdout).toMatch(/Sign out\s*:\s*muhaven-broker logout/);
    expect(stdout).toMatch(/clears JWT, leaves daemon running/);
  });

  // ---------- input validation ----------

  it('rejects --backend-base-url with http:// to non-loopback before spawning', async () => {
    const h = makeHarness();
    const code = await runSetup(['--backend-base-url', 'http://evil.example.com'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/must use https/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.runLogin).not.toHaveBeenCalled();
  });

  it('rejects --dashboard-base-url with javascript: scheme', async () => {
    const h = makeHarness();
    const code = await runSetup(['--dashboard-base-url', 'javascript:alert(1)'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/must use https/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it('rejects --broker-endpoint with a relative path on POSIX', async () => {
    const h = makeHarness({ platformId: 'linux' });
    const code = await runSetup(['--broker-endpoint', './attacker.sock'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/absolute path/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it('rejects --broker-endpoint with a non-pipe path on win32', async () => {
    const h = makeHarness({ platformId: 'win32' });
    const code = await runSetup(['--broker-endpoint', 'C:\\Users\\evil\\fake'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/named pipe/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it('accepts --broker-endpoint with a value that starts with -- (flag-injection defense)', async () => {
    // parseSetupFlags MUST NOT treat the value as a sibling flag. Today it
    // does, because the parser greedily consumes the next token as the
    // value (no further look-ahead). Lock that behavior here so a future
    // refactor that "fixes" the look-ahead doesn't accidentally break the
    // negative test below.
    const parsed = parseSetupFlags(['--broker-endpoint', '--from-daemon']);
    expect(parsed.brokerEndpoint).toBe('--from-daemon');
    // …but the downstream broker-endpoint validation rejects the
    // suspicious value before spawn, so the security property holds.
    const h = makeHarness({ platformId: 'linux' });
    const code = await runSetup(['--broker-endpoint', '--from-daemon'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/absolute path/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });
});

// ---------- --register flag parsing ----------

describe('parseSetupFlags --register', () => {
  it('defaults register to [] and registerScope to user', () => {
    const flags = parseSetupFlags([]);
    expect(flags.register).toEqual([]);
    expect(flags.registerScope).toBe('user');
  });

  it('parses a single host name', () => {
    const flags = parseSetupFlags(['--register', 'claude-code']);
    expect(flags.register).toEqual(['claude-code']);
  });

  it('parses comma-separated host names', () => {
    const flags = parseSetupFlags(['--register', 'claude-code,cursor']);
    expect(flags.register).toEqual(['claude-code', 'cursor']);
  });

  it('parses repeated --register flags', () => {
    const flags = parseSetupFlags(['--register', 'claude-code', '--register', 'cursor']);
    expect(flags.register).toEqual(['claude-code', 'cursor']);
  });

  it('dedupes hosts across both comma-separated AND repeated forms', () => {
    const flags = parseSetupFlags([
      '--register', 'claude-code,cursor',
      '--register', 'claude-code',
    ]);
    expect(flags.register).toEqual(['claude-code', 'cursor']);
  });

  it('rejects unknown host names', () => {
    expect(() => parseSetupFlags(['--register', 'wishfulhost'])).toThrow(
      /unknown --register host: "wishfulhost"/,
    );
  });

  it('rejects unknown host names even inside a comma-separated value', () => {
    expect(() => parseSetupFlags(['--register', 'claude-code,wishfulhost'])).toThrow(
      /unknown --register host/,
    );
  });

  it('lowercases host names (case-insensitive matching)', () => {
    const flags = parseSetupFlags(['--register', 'Claude-Code']);
    expect(flags.register).toEqual(['claude-code']);
  });

  it('accepts --register-scope project|user|local', () => {
    expect(parseSetupFlags(['--register-scope', 'project']).registerScope).toBe('project');
    expect(parseSetupFlags(['--register-scope', 'user']).registerScope).toBe('user');
    expect(parseSetupFlags(['--register-scope', 'local']).registerScope).toBe('local');
  });

  it('rejects unknown --register-scope', () => {
    expect(() => parseSetupFlags(['--register-scope', 'global'])).toThrow(
      /unknown --register-scope: "global"/,
    );
  });

  it('KNOWN_REGISTER_HOSTS + SCOPES constants are non-empty', () => {
    expect(KNOWN_REGISTER_HOSTS.length).toBeGreaterThan(0);
    expect(KNOWN_REGISTER_SCOPES.length).toBeGreaterThan(0);
    expect(KNOWN_REGISTER_HOSTS).toContain('claude-code');
    expect(KNOWN_REGISTER_SCOPES).toContain('user');
  });
});

// ---------- pure register helpers ----------

describe('buildRegisterEnv', () => {
  it('passes through the load-bearing trio when set', () => {
    const env = buildRegisterEnv({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
      MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
      MUHAVEN_KEYRING: 'file',
    });
    expect(env).toEqual({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
      MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
      MUHAVEN_KEYRING: 'file',
    });
  });

  it('omits MUHAVEN_KEYRING when it was not auto-defaulted (native macOS / Linux desktop)', () => {
    const env = buildRegisterEnv({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
      MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
    });
    expect(env).toEqual({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
      MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
    });
    expect(env.MUHAVEN_KEYRING).toBeUndefined();
  });

  it('excludes the broker session key + endpoint even when present', () => {
    // These live with the daemon; baking them into the host config would
    // either leak a long-lived secret or desync the client when the
    // operator re-runs setup with a different endpoint.
    const env = buildRegisterEnv({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
      MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
      MUHAVEN_BROKER_SESSION_KEY: '0x' + 'aa'.repeat(32),
      MUHAVEN_BROKER_ENDPOINT: '/tmp/muhaven-broker.sock',
    });
    expect(env.MUHAVEN_BROKER_SESSION_KEY).toBeUndefined();
    expect(env.MUHAVEN_BROKER_ENDPOINT).toBeUndefined();
  });
});

describe('buildClaudeMcpRegisterJson', () => {
  it('emits {type, command, env} when env is non-empty', () => {
    const json = buildClaudeMcpRegisterJson({
      MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
    });
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      type: 'stdio',
      command: 'muhaven-mcp',
      env: { MUHAVEN_BACKEND_URL: 'https://api.muhaven.app' },
    });
  });

  it('omits the env field when no env vars resolved', () => {
    const json = buildClaudeMcpRegisterJson({});
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ type: 'stdio', command: 'muhaven-mcp' });
    expect('env' in parsed).toBe(false);
  });

  it('keeps key order stable (type → command → env)', () => {
    const json = buildClaudeMcpRegisterJson({ FOO: 'bar' });
    // JSON.stringify preserves insertion order for non-numeric keys; lock
    // the order so future diffs of `.mcp.json` stay readable.
    expect(json).toBe('{"type":"stdio","command":"muhaven-mcp","env":{"FOO":"bar"}}');
  });
});

describe('buildClaudeMcpAddJsonArgv + buildClaudeMcpRemoveArgv', () => {
  it('add-json argv: [mcp, add-json, name, json, --scope, scope]', () => {
    const argv = buildClaudeMcpAddJsonArgv('muhaven', '{"type":"stdio"}', 'user');
    expect(argv).toEqual(['mcp', 'add-json', 'muhaven', '{"type":"stdio"}', '--scope', 'user']);
  });

  it('add-json argv passes JSON as a single positional (shell metacharacters survive)', () => {
    const json = '{"type":"stdio","env":{"K":"v with $shell `meta`"}}';
    const argv = buildClaudeMcpAddJsonArgv('muhaven', json, 'project');
    // The JSON blob must appear as ONE argv entry — node's spawn (argv path)
    // doesn't run /bin/sh -c on it, so the shell metacharacters are literal.
    expect(argv).toContain(json);
    // Scope wiring stays in place too.
    expect(argv.indexOf('--scope')).toBeGreaterThan(argv.indexOf(json));
    expect(argv[argv.indexOf('--scope') + 1]).toBe('project');
  });

  it('remove argv: [mcp, remove, name, --scope, scope]', () => {
    const argv = buildClaudeMcpRemoveArgv('muhaven', 'local');
    expect(argv).toEqual(['mcp', 'remove', 'muhaven', '--scope', 'local']);
  });
});

// ---------- registerWithHost ----------

describe('registerWithHost (claude-code)', () => {
  function makeShellHarness(): {
    shellOut: ReturnType<typeof vi.fn>;
    script: Map<string, ShellResult | Error>;
  } {
    const script = new Map<string, ShellResult | Error>();
    const shellOut = vi.fn(async (cmd: string, argv: readonly string[]): Promise<ShellResult> => {
      const key = `${cmd} ${argv.join(' ')}`;
      const scripted = script.get(key);
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    return { shellOut, script };
  }

  it('happy path: probe + remove + add → registered', async () => {
    const { shellOut } = makeShellHarness();
    const outcome = await registerWithHost(
      { shellOut },
      {
        host: 'claude-code',
        scope: 'user',
        serverName: 'muhaven',
        registerEnv: { MUHAVEN_BACKEND_URL: 'https://api.muhaven.app' },
      },
    );
    expect(outcome).toEqual({ status: 'registered', host: 'claude-code', scope: 'user' });
    // 3 calls: probe, remove, add (in order)
    expect(shellOut).toHaveBeenCalledTimes(3);
    expect(shellOut.mock.calls[0]).toEqual(['claude', ['--version']]);
    expect(shellOut.mock.calls[1][1]).toContain('remove');
    expect(shellOut.mock.calls[2][1]).toContain('add-json');
  });

  it('cli_missing when claude binary not on PATH (spawn throws ENOENT)', async () => {
    const { shellOut, script } = makeShellHarness();
    script.set('claude --version', new Error('spawn claude ENOENT'));
    const outcome = await registerWithHost(
      { shellOut },
      {
        host: 'claude-code',
        scope: 'user',
        serverName: 'muhaven',
        registerEnv: {},
      },
    );
    expect(outcome.status).toBe('cli_missing');
    if (outcome.status === 'cli_missing') {
      expect(outcome.host).toBe('claude-code');
      expect(outcome.cmd).toMatch(/ENOENT/);
    }
    // Probe failed → no remove + no add issued.
    expect(shellOut).toHaveBeenCalledTimes(1);
  });

  it('cli_missing when claude --version returns a non-zero exit', async () => {
    const { shellOut, script } = makeShellHarness();
    script.set('claude --version', { exitCode: 127, stdout: '', stderr: 'command not found' });
    const outcome = await registerWithHost(
      { shellOut },
      {
        host: 'claude-code',
        scope: 'user',
        serverName: 'muhaven',
        registerEnv: {},
      },
    );
    expect(outcome.status).toBe('cli_missing');
    expect(shellOut).toHaveBeenCalledTimes(1);
  });

  it('idempotent: remove failure (server not registered) does NOT block add', async () => {
    // First-run reality — `claude mcp remove muhaven` errors when nothing's
    // bound to the name. registerWithHost must swallow that AND still
    // attempt the add.
    const { shellOut, script } = makeShellHarness();
    script.set('claude mcp remove muhaven --scope user', {
      exitCode: 1,
      stdout: '',
      stderr: 'No MCP server named muhaven',
    });
    const outcome = await registerWithHost(
      { shellOut },
      {
        host: 'claude-code',
        scope: 'user',
        serverName: 'muhaven',
        registerEnv: {},
      },
    );
    expect(outcome).toEqual({ status: 'registered', host: 'claude-code', scope: 'user' });
    expect(shellOut).toHaveBeenCalledTimes(3);
  });

  it('failed when add-json returns non-zero', async () => {
    const { shellOut, script } = makeShellHarness();
    const json = JSON.stringify({ type: 'stdio', command: 'muhaven-mcp' });
    script.set(`claude mcp add-json muhaven ${json} --scope user`, {
      exitCode: 1,
      stdout: '',
      stderr: 'invalid JSON config',
    });
    const outcome = await registerWithHost(
      { shellOut },
      {
        host: 'claude-code',
        scope: 'user',
        serverName: 'muhaven',
        registerEnv: {},
      },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toMatch(/invalid JSON config/);
    }
  });

  it.each(['claude-desktop' as const, 'cursor' as const])(
    'not_implemented for reserved host %s',
    async (host: RegisterHost) => {
      const { shellOut } = makeShellHarness();
      const outcome = await registerWithHost(
        { shellOut },
        {
          host,
          scope: 'user',
          serverName: 'muhaven',
          registerEnv: {},
        },
      );
      expect(outcome).toEqual({ status: 'not_implemented', host });
      // No shell calls — the registrar short-circuits BEFORE touching the
      // host's CLI. Protects operators who pass --register cursor on a
      // machine without cursor installed from getting a misleading
      // cli_missing message.
      expect(shellOut).not.toHaveBeenCalled();
    },
  );
});

// ---------- runSetup orchestration with --register ----------

describe('runSetup --register integration', () => {
  beforeEach(() => {
    vi.stubEnv('MUHAVEN_BACKEND_URL', '');
    vi.stubEnv('MUHAVEN_DASHBOARD_URL', '');
    vi.stubEnv('MUHAVEN_KEYRING', '');
    vi.stubEnv('MUHAVEN_BROKER_SESSION_KEY', '');
    vi.stubEnv('MUHAVEN_BROKER_ENDPOINT', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT call shellOut when --register is absent', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    const code = await runSetup([], h.deps);
    expect(code).toBe(0);
    expect(h.shellOut).not.toHaveBeenCalled();
  });

  it('happy path: --register claude-code wires the host after login + returns 0', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    const code = await runSetup(['--register', 'claude-code'], h.deps);
    expect(code).toBe(0);
    // probe + remove + add
    expect(h.shellOut).toHaveBeenCalledTimes(3);
    expect(h.shellOut.mock.calls[0]).toEqual(['claude', ['--version']]);
    const addArgv = h.shellOut.mock.calls[2][1] as string[];
    expect(addArgv).toContain('add-json');
    expect(addArgv).toContain('muhaven');
    expect(addArgv).toContain('--scope');
    expect(addArgv[addArgv.indexOf('--scope') + 1]).toBe('user');
    // JSON blob has the load-bearing env
    const json = addArgv[addArgv.indexOf('muhaven') + 1];
    expect(JSON.parse(json)).toEqual({
      type: 'stdio',
      command: 'muhaven-mcp',
      env: {
        MUHAVEN_BACKEND_URL: 'https://api.muhaven.app',
        MUHAVEN_DASHBOARD_URL: 'https://muhaven.app',
      },
    });
    expect(h.output.join('\n')).toMatch(/claude-code wired \(scope: user\)/);
  });

  it('forwards --register-scope through to the add-json call', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runSetup(['--register', 'claude-code', '--register-scope', 'project'], h.deps);
    const addArgv = h.shellOut.mock.calls[2][1] as string[];
    expect(addArgv[addArgv.indexOf('--scope') + 1]).toBe('project');
  });

  it('Windows: includes MUHAVEN_KEYRING=file in the registered env', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
      platformId: 'win32',
      osRelease: '10.0.26200',
    });
    await runSetup(['--register', 'claude-code'], h.deps);
    const addArgv = h.shellOut.mock.calls[2][1] as string[];
    const json = addArgv[addArgv.indexOf('muhaven') + 1];
    expect(JSON.parse(json).env.MUHAVEN_KEYRING).toBe('file');
  });

  it('cli_missing: setup still returns 0 + prints fallback hint to stderr', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    scriptShell(h, 'claude', ['--version'], new Error('spawn claude ENOENT'));
    const code = await runSetup(['--register', 'claude-code'], h.deps);
    expect(code).toBe(0); // broker + JWT shipped — register failure is best-effort
    expect(h.errOutput.join('\n')).toMatch(/claude-code CLI not found on PATH/);
    expect(h.errOutput.join('\n')).toMatch(/docs.muhaven.app\/mcp\/install/);
  });

  it('register failure: setup still returns 0 + prints reason + re-run hint', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    // probe OK, remove OK, add fails
    scriptShell(h, 'claude', ['--version'], { exitCode: 0, stdout: '1.0.0', stderr: '' });
    scriptShell(h, 'claude', ['mcp', 'remove', 'muhaven', '--scope', 'user'], {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    // add-json's argv contains a JSON blob we'd have to predict to script
    // exactly — instead, override the default vi.fn to return failure on
    // any add-json call. Simpler.
    h.shellOut.mockImplementation(async (_cmd: string, argv: readonly string[]) => {
      if (argv[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
      if (argv.includes('remove')) return { exitCode: 0, stdout: '', stderr: '' };
      if (argv.includes('add-json')) {
        return { exitCode: 1, stdout: '', stderr: 'permission denied on ~/.claude.json' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const code = await runSetup(['--register', 'claude-code'], h.deps);
    expect(code).toBe(0);
    expect(h.errOutput.join('\n')).toMatch(/claude-code failed.*permission denied/);
    expect(h.errOutput.join('\n')).toMatch(/re-run.*--register claude-code/);
  });

  it('unknown --register host returns 2 + usage', async () => {
    const h = makeHarness();
    const code = await runSetup(['--register', 'wishfulhost'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/unknown --register host/);
    // Setup never started — no spawn, no shellOut
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.shellOut).not.toHaveBeenCalled();
  });

  it('reserved host (cursor): setup still returns 0, prints not-implemented hint', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    const code = await runSetup(['--register', 'cursor'], h.deps);
    expect(code).toBe(0);
    expect(h.errOutput.join('\n')).toMatch(/cursor registrar not implemented yet/);
    // not_implemented short-circuits BEFORE shelling out — proves operators
    // who run --register cursor on a cursor-less machine don't get a
    // misleading "cli not found" error.
    expect(h.shellOut).not.toHaveBeenCalled();
  });
});
