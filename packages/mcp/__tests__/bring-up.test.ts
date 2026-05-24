import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseBringUpFlags,
  runBringUp,
  type BringUpDeps,
  type BringUpMode,
} from '../src/broker/bring-up.js';
import type { SessionPromptDeps } from '../src/broker/session-input.js';

const PROVIDED_KEY = '0x' + 'bb'.repeat(32); // grep-able sentinel
const SIGNER_ADDR = '0x' + '12'.repeat(20);

describe('parseBringUpFlags', () => {
  it('returns defaults for empty argv', () => {
    expect(parseBringUpFlags([])).toEqual({
      session: undefined,
      noLaunchBrowser: false,
      skipLogin: false,
      brokerEndpoint: undefined,
      backendBaseUrl: undefined,
      dashboardBaseUrl: undefined,
      brokerRpcUrl: undefined,
    });
  });

  it('parses --broker-rpc-url', () => {
    expect(parseBringUpFlags(['--broker-rpc-url', 'https://my-rpc.example.test']).brokerRpcUrl).toBe(
      'https://my-rpc.example.test',
    );
  });

  it('parses --session <key>', () => {
    expect(parseBringUpFlags(['--session', PROVIDED_KEY]).session).toBe(PROVIDED_KEY);
  });

  it('parses --session - (stdin sentinel)', () => {
    expect(parseBringUpFlags(['--session', '-']).session).toBe('-');
  });

  it('throws a clear error when --session has no value', () => {
    expect(() => parseBringUpFlags(['--session'])).toThrow(/--session requires a value/);
  });

  it('parses pass-through + value flags', () => {
    const f = parseBringUpFlags([
      '--session',
      PROVIDED_KEY,
      '--no-launch-browser',
      '--skip-login',
      '--broker-endpoint',
      '/tmp/x.sock',
      '--backend-base-url',
      'https://api.example.test',
      '--dashboard-base-url',
      'https://dash.example.test',
    ]);
    expect(f).toEqual({
      session: PROVIDED_KEY,
      noLaunchBrowser: true,
      skipLogin: true,
      brokerEndpoint: '/tmp/x.sock',
      backendBaseUrl: 'https://api.example.test',
      dashboardBaseUrl: 'https://dash.example.test',
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseBringUpFlags(['--bogus'])).toThrow(/unknown flag/);
  });

  it('rejects a flag-like --session value with a clear message (not a shape error)', () => {
    expect(() => parseBringUpFlags(['--session', '--skip-login'])).toThrow(
      /--session requires a key value.*got flag: --skip-login/,
    );
  });

  it('still accepts the `-` stdin sentinel (not treated as a flag)', () => {
    expect(parseBringUpFlags(['--session', '-']).session).toBe('-');
  });
});

// ---------- runBringUp orchestrator ----------

interface Harness {
  output: string[];
  errOutput: string[];
  spawnDaemon: ReturnType<typeof vi.fn>;
  waitForBroker: ReturnType<typeof vi.fn>;
  stopDaemon: ReturnType<typeof vi.fn>;
  runLogin: ReturnType<typeof vi.fn>;
  brokerHello: ReturnType<typeof vi.fn>;
  promptYesNo: ReturnType<typeof vi.fn>;
  promptSecret: ReturnType<typeof vi.fn>;
  readStdinAll: ReturnType<typeof vi.fn>;
  deps: BringUpDeps;
}

function makeHarness(opts: {
  /** hello() responses in order. Error = not reachable. Object = reachable. */
  helloResults?: Array<{ sessionKeyAddress?: string; hasSessionKey?: boolean } | Error>;
  waitForBrokerResult?: { hasJwt: boolean } | Error;
  stopExitCode?: number;
  loginExitCode?: number;
  env?: Record<string, string | undefined>;
  platformId?: NodeJS.Platform;
  isTty?: boolean;
  promptYesNoResult?: boolean;
  promptSecretResult?: string;
  stdin?: string;
} = {}): Harness {
  const output: string[] = [];
  const errOutput: string[] = [];

  const helloResults = opts.helloResults ?? [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }];
  let helloIdx = 0;
  const brokerHello = vi.fn(async () => {
    const r = helloResults[Math.min(helloIdx, helloResults.length - 1)];
    helloIdx += 1;
    if (r instanceof Error) throw r;
    return { type: 'hello', version: '0.5.0', hasJwt: true, hasSessionKey: true, ...r };
  });

  const spawnDaemon = vi.fn(() => 99999);
  const waitForBroker = vi.fn(async () => {
    if (opts.waitForBrokerResult instanceof Error) throw opts.waitForBrokerResult;
    return opts.waitForBrokerResult ?? { hasJwt: false };
  });
  const stopDaemon = vi.fn(async () => opts.stopExitCode ?? 0);
  const runLogin = vi.fn(async () => opts.loginExitCode ?? 0);

  const promptYesNo = vi.fn(async () => opts.promptYesNoResult ?? false);
  const promptSecret = vi.fn(async () => opts.promptSecretResult ?? '');
  const readStdinAll = vi.fn(async () => opts.stdin ?? '');

  const sessionPrompt: SessionPromptDeps = {
    isTty: opts.isTty ?? false,
    readStdinAll,
    promptYesNo,
    promptSecret,
  };

  const deps: BringUpDeps = {
    print: (l) => output.push(l),
    printErr: (l) => errOutput.push(l),
    newBrokerClient: () => ({ hello: brokerHello }),
    spawnDaemon,
    waitForBroker,
    stopDaemon,
    runLogin,
    resolveBinPath: () => '/usr/local/bin/muhaven-broker',
    env: opts.env ?? {},
    platformId: opts.platformId ?? 'linux',
    osRelease: '6.1.0',
    sessionPrompt,
  };

  return {
    output,
    errOutput,
    spawnDaemon,
    waitForBroker,
    stopDaemon,
    runLogin,
    brokerHello,
    promptYesNo,
    promptSecret,
    readStdinAll,
    deps,
  };
}

function runStart(h: Harness, argv: readonly string[]): Promise<number> {
  return runBringUp('start', argv, h.deps);
}
function runUpdate(h: Harness, argv: readonly string[]): Promise<number> {
  return runBringUp('update', argv, h.deps);
}

describe('runBringUp — start', () => {
  beforeEach(() => {
    vi.stubEnv('MUHAVEN_BACKEND_URL', '');
    vi.stubEnv('MUHAVEN_DASHBOARD_URL', '');
    vi.stubEnv('MUHAVEN_BROKER_ENDPOINT', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('not running + valid --session → spawns with key in child env, logs in, returns 0', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    const code = await runStart(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(0);
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
    // The key reaches the daemon ONLY via the spawned child env (Option B).
    const spawnEnv = h.spawnDaemon.mock.calls[0][0].env;
    expect(spawnEnv.MUHAVEN_BROKER_SESSION_KEY).toBe(PROVIDED_KEY);
    expect(spawnEnv.MUHAVEN_BACKEND_URL).toBeTruthy();
    expect(h.runLogin).toHaveBeenCalledTimes(1);
    expect(h.stopDaemon).not.toHaveBeenCalled();
    const out = h.output.join('\n');
    expect(out).toMatch(/not running — starting one/);
    expect(out).toMatch(/Broker started/);
    expect(out).toMatch(new RegExp(`Broker signer: ${SIGNER_ADDR}`));
  });

  it('already running → returns 1 + points at update, never spawns', async () => {
    const h = makeHarness({ helloResults: [{ sessionKeyAddress: SIGNER_ADDR }] });
    const code = await runStart(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(1);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.errOutput.join('\n')).toMatch(/already running/);
    expect(h.errOutput.join('\n')).toMatch(/muhaven-broker update --session/);
  });

  it('reuses an existing JWT (hasJwt true → no login)', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runStart(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(0);
    expect(h.runLogin).not.toHaveBeenCalled();
    expect(h.output.join('\n')).toMatch(/JWT already in keystore \(reused\)/);
  });

  it('--skip-login spawns but never logs in', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: false },
    });
    const code = await runStart(h, ['--session', PROVIDED_KEY, '--skip-login']);
    expect(code).toBe(0);
    expect(h.runLogin).not.toHaveBeenCalled();
    expect(h.output.join('\n')).toMatch(/Login: skipped per --skip-login/);
  });

  it('invalid --session → returns 2 before any spawn', async () => {
    const h = makeHarness();
    const code = await runStart(h, ['--session', '0xdead']);
    expect(code).toBe(2);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.errOutput.join('\n')).toMatch(/32-byte hex/);
  });

  it('no --session + non-TTY → returns 2 (require), never spawns', async () => {
    const h = makeHarness({ isTty: false });
    const code = await runStart(h, []);
    expect(code).toBe(2);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.errOutput.join('\n')).toMatch(/--session/);
  });

  it('no --session + TTY + Yes + valid paste → spawns with pasted key', async () => {
    const h = makeHarness({
      isTty: true,
      promptYesNoResult: true,
      promptSecretResult: PROVIDED_KEY,
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runStart(h, []);
    expect(code).toBe(0);
    expect(h.promptSecret).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon.mock.calls[0][0].env.MUHAVEN_BROKER_SESSION_KEY).toBe(PROVIDED_KEY);
  });

  it('--session - reads the key from stdin', async () => {
    const h = makeHarness({
      stdin: `${PROVIDED_KEY}\n`,
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runStart(h, ['--session', '-']);
    expect(code).toBe(0);
    expect(h.readStdinAll).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon.mock.calls[0][0].env.MUHAVEN_BROKER_SESSION_KEY).toBe(PROVIDED_KEY);
  });

  it('--broker-rpc-url lands in the spawned daemon child env', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runStart(h, [
      '--session',
      PROVIDED_KEY,
      '--broker-rpc-url',
      'https://my-private-rpc.example.test',
    ]);
    expect(code).toBe(0);
    expect(h.spawnDaemon.mock.calls[0][0].env.MUHAVEN_BROKER_RPC_URL).toBe(
      'https://my-private-rpc.example.test',
    );
  });

  it('omits MUHAVEN_BROKER_RPC_URL from the child env when no flag/shell value (daemon defaults it)', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    await runStart(h, ['--session', PROVIDED_KEY]);
    expect(h.spawnDaemon.mock.calls[0][0].env).not.toHaveProperty('MUHAVEN_BROKER_RPC_URL');
  });

  it('rejects --broker-rpc-url http://<non-loopback> before spawn', async () => {
    const h = makeHarness();
    const code = await runStart(h, [
      '--session',
      PROVIDED_KEY,
      '--broker-rpc-url',
      'http://evil.example.com',
    ]);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/must use https/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it('rejects --backend-base-url http://<non-loopback> before spawn', async () => {
    const h = makeHarness();
    const code = await runStart(h, ['--session', PROVIDED_KEY, '--backend-base-url', 'http://evil.example.com']);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/must use https/);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
  });

  it('returns 1 (READ-ONLY posture) when the daemon came up WITHOUT the key', async () => {
    // The post-ready hello reports hasSessionKey:false → the key didn't
    // reach the daemon → it cannot sign → start/update must NOT report
    // success. (The signer also returns the zero address in this posture.)
    const h = makeHarness({
      helloResults: [
        new Error('ECONNREFUSED'),
        { sessionKeyAddress: '0x' + '00'.repeat(20), hasSessionKey: false },
      ],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runStart(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/READ-ONLY posture/);
    // It still spawned (the key was injected); the failure is detected after.
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('returns 1 when wait-for-broker times out', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED')],
      waitForBrokerResult: new Error('did not become reachable within 8000ms'),
    });
    const code = await runStart(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(1);
    expect(h.errOutput.join('\n')).toMatch(/did not become reachable/);
    expect(h.runLogin).not.toHaveBeenCalled();
  });

  it('NEVER echoes the session key to stdout / stderr', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: false },
      loginExitCode: 0,
    });
    await runStart(h, ['--session', PROVIDED_KEY]);
    const all = [...h.output, ...h.errOutput].join('\n');
    expect(all).not.toContain('bb'.repeat(32));
    expect(all).not.toContain(PROVIDED_KEY);
  });

  it('closing summary uses Stop-Process on win32, kill on POSIX', async () => {
    const hWin = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
      platformId: 'win32',
    });
    await runStart(hWin, ['--session', PROVIDED_KEY]);
    expect(hWin.output.join('\n')).toMatch(/Stop-Process -Id 99999/);

    const hPosix = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
      platformId: 'linux',
    });
    await runStart(hPosix, ['--session', PROVIDED_KEY]);
    expect(hPosix.output.join('\n')).toMatch(/Stop daemon: kill 99999/);
  });
});

describe('runBringUp — update', () => {
  beforeEach(() => {
    vi.stubEnv('MUHAVEN_BACKEND_URL', '');
    vi.stubEnv('MUHAVEN_DASHBOARD_URL', '');
    vi.stubEnv('MUHAVEN_BROKER_ENDPOINT', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('running daemon → stops it, spawns with NEW key, reuses JWT, returns 0', async () => {
    const h = makeHarness({
      // probe (running), then post-ready signer hello
      helloResults: [{ sessionKeyAddress: SIGNER_ADDR }, { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
      stopExitCode: 0,
    });
    const code = await runUpdate(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(0);
    expect(h.stopDaemon).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon.mock.calls[0][0].env.MUHAVEN_BROKER_SESSION_KEY).toBe(PROVIDED_KEY);
    // JWT reuse — the whole point of update vs a fresh login.
    expect(h.runLogin).not.toHaveBeenCalled();
    const out = h.output.join('\n');
    expect(out).toMatch(/stopping it before installing the new key/);
    expect(out).toMatch(/Session key rotated/);
  });

  it('not running → no stop, starts a fresh daemon, returns 0', async () => {
    const h = makeHarness({
      helloResults: [new Error('ECONNREFUSED'), { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
    });
    const code = await runUpdate(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(0);
    expect(h.stopDaemon).not.toHaveBeenCalled();
    expect(h.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(h.output.join('\n')).toMatch(/not running — `update` will start a fresh one/);
  });

  it('stop failure → returns the stop code, never spawns a second daemon', async () => {
    const h = makeHarness({
      helloResults: [{ sessionKeyAddress: SIGNER_ADDR }],
      stopExitCode: 1,
    });
    const code = await runUpdate(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(1);
    expect(h.stopDaemon).toHaveBeenCalledTimes(1);
    expect(h.spawnDaemon).not.toHaveBeenCalled();
    expect(h.errOutput.join('\n')).toMatch(/refusing to start a second daemon/);
  });

  it('logs in when there is genuinely no JWT after restart', async () => {
    const h = makeHarness({
      helloResults: [{ sessionKeyAddress: SIGNER_ADDR }, { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: false },
      stopExitCode: 0,
      loginExitCode: 0,
    });
    const code = await runUpdate(h, ['--session', PROVIDED_KEY]);
    expect(code).toBe(0);
    expect(h.runLogin).toHaveBeenCalledTimes(1);
  });

  it('NEVER echoes the session key', async () => {
    const h = makeHarness({
      helloResults: [{ sessionKeyAddress: SIGNER_ADDR }, { sessionKeyAddress: SIGNER_ADDR }],
      waitForBrokerResult: { hasJwt: true },
      stopExitCode: 0,
    });
    await runUpdate(h, ['--session', PROVIDED_KEY]);
    const all = [...h.output, ...h.errOutput].join('\n');
    expect(all).not.toContain('bb'.repeat(32));
  });
});

describe('runBringUp — flag errors', () => {
  it('unknown flag → returns 2 + usage', async () => {
    const h = makeHarness();
    const code = await runBringUp('start', ['--bogus'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/unknown flag/);
    expect(h.errOutput.join('\n')).toMatch(/usage: muhaven-broker start/);
  });

  it.each(['start', 'update'] as const)('--session with no value → 2 + usage (%s)', async (mode: BringUpMode) => {
    const h = makeHarness();
    const code = await runBringUp(mode, ['--session'], h.deps);
    expect(code).toBe(2);
    expect(h.errOutput.join('\n')).toMatch(/--session requires a value/);
  });
});
