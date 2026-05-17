/**
 * `muhaven-broker setup` — one-shot install helper.
 *
 * Replaces the manual ritual of:
 *   1. exporting MUHAVEN_BACKEND_URL / MUHAVEN_DASHBOARD_URL / MUHAVEN_KEYRING,
 *   2. minting a session key,
 *   3. starting the broker in a second terminal,
 *   4. running `muhaven-broker login`.
 *
 * With `muhaven-broker setup` a fresh install becomes:
 *
 *   npm install -g @muhaven/mcp
 *   muhaven-broker setup
 *   # → passkey ceremony in browser
 *   # → "Setup complete."
 *
 * The pure helpers (`applyEnvDefaults`, `decideSetupAction`) are exported
 * so vitest can exercise the decision tree without spawning child
 * processes.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform, release } from 'node:os';
import { BrokerClient } from '../clients/broker-client.js';
import { loadMcpConfig } from '../config.js';

/**
 * Plan-of-record for the env defaults setup will apply. Each entry maps a
 * MUHAVEN_* env var to either a static default or a platform-dependent
 * resolver. The mapping lives here (not inline in `applyEnvDefaults`) so
 * tests can iterate over it.
 */
export interface EnvDefaultsInput {
  /** Snapshot of the env at setup-time. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Platform string — defaults to `process.platform`; injectable for tests. */
  readonly platformId?: NodeJS.Platform;
  /** OS release string — defaults to `os.release()`; injectable for tests. */
  readonly osRelease?: string;
}

export interface EnvDefaultsResult {
  /** Map of env vars to set on the spawned child + login process. */
  readonly toSet: Readonly<Record<string, string>>;
  /** Names of vars that were already present in `env` (kept untouched). */
  readonly preserved: readonly string[];
}

/**
 * Compute the env-default overrides without mutating anything. Pure.
 *
 * Defaults:
 *   - MUHAVEN_BACKEND_URL    → https://api.muhaven.app
 *   - MUHAVEN_DASHBOARD_URL  → https://muhaven.app
 *   - MUHAVEN_KEYRING        → 'file' on Windows / WSL / SSH / devcontainer
 *                              (per existing detectEnvironment heuristics);
 *                              left unset on native macOS / Linux desktop
 *                              so the OS keychain is preferred.
 */
export function applyEnvDefaults(input: EnvDefaultsInput): EnvDefaultsResult {
  const { env } = input;
  const platformId = input.platformId ?? process.platform;
  const osRelease = input.osRelease ?? release();

  const toSet: Record<string, string> = {};
  const preserved: string[] = [];

  const defaultIfUnset = (name: string, value: string): void => {
    if (env[name] && env[name]!.length > 0) {
      preserved.push(name);
    } else {
      toSet[name] = value;
    }
  };

  defaultIfUnset('MUHAVEN_BACKEND_URL', 'https://api.muhaven.app');
  defaultIfUnset('MUHAVEN_DASHBOARD_URL', 'https://muhaven.app');

  // Keyring auto-default: only set when we have high confidence the OS
  // keychain won't work. The cli.ts `detectEnvironment` already flags
  // WSL2 + devcontainer + Codespaces + SSH; mirror those checks here.
  const wantFileKeyring =
    platformId === 'win32' ||
    (platformId === 'linux' &&
      (env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(osRelease))) ||
    env.REMOTE_CONTAINERS === 'true' ||
    env.CODESPACES === 'true' ||
    env.SSH_CONNECTION !== undefined;

  if (wantFileKeyring) {
    defaultIfUnset('MUHAVEN_KEYRING', 'file');
  } else if (env.MUHAVEN_KEYRING) {
    preserved.push('MUHAVEN_KEYRING');
  }

  return { toSet, preserved };
}

/**
 * Returns a freshly minted 32-byte session key in 0x-prefixed hex form.
 * Caller decides whether to use this — `applyEnvDefaults` does not mint
 * keys (it never reaches into crypto).
 */
export function mintSessionKey(): string {
  return '0x' + randomBytes(32).toString('hex');
}

export type SetupActionKind =
  /** No broker running — spawn one + login. */
  | 'spawn_and_login'
  /** Broker running but no JWT — just run login. */
  | 'login_only'
  /** Broker running AND has a JWT — nothing to do. */
  | 'already_ready';

export interface SetupActionDecisionInput {
  /** Result of probing the broker; `null` means it was unreachable. */
  readonly hello:
    | {
        readonly hasJwt: boolean;
      }
    | null;
}

/**
 * Decide which path setup should take. Pure — given the broker probe
 * result, returns the action enum without doing any IO.
 */
export function decideSetupAction(input: SetupActionDecisionInput): SetupActionKind {
  if (input.hello === null) return 'spawn_and_login';
  if (!input.hello.hasJwt) return 'login_only';
  return 'already_ready';
}

export interface SpawnDaemonOptions {
  /** Path to the bin entry the daemon is launched from (process.argv[1]). */
  readonly binPath: string;
  /** Env vars to apply to the spawned daemon (merged over process.env). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Spawn the daemon as a detached child of the current process. Returns the
 * PID so the caller can print it for the operator. Best-effort: on
 * Windows the child runs in its own process group with `windowsHide: true`;
 * on POSIX the child is also detached so the parent can exit cleanly.
 *
 * IO side. `runSetup` is the only intended caller from production code;
 * tests should mock this via dependency-injection at the orchestrator
 * layer rather than calling here.
 */
export function spawnDaemon(options: SpawnDaemonOptions): number {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const child = spawn(process.execPath, [options.binPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: merged,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('failed to spawn muhaven-broker daemon — child pid is undefined');
  }
  return child.pid;
}

export interface WaitForBrokerOptions {
  readonly broker: Pick<BrokerClient, 'hello'>;
  /** Total wait budget in ms. Default 8000. */
  readonly timeoutMs?: number;
  /** Per-attempt sleep between probes in ms. Default 200. */
  readonly intervalMs?: number;
  /** Sleeper, injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the broker until `hello()` succeeds or the timeout elapses. Resolves
 * to the final hello result on success; throws the last error on timeout.
 * Pure-ish: the only side effect is the broker IPC + setTimeout, both
 * injectable.
 */
export async function waitForBroker(
  options: WaitForBrokerOptions,
): Promise<{ hasJwt: boolean }> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const intervalMs = options.intervalMs ?? 200;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const deadline = now() + timeoutMs;
  let lastErr: unknown = null;
  while (now() < deadline) {
    try {
      const hello = await options.broker.hello();
      return { hasJwt: hello.hasJwt };
    } catch (err) {
      lastErr = err;
      // sleep, but only if we still have budget; otherwise fall out so the
      // final throw runs immediately.
      if (now() + intervalMs < deadline) {
        await sleep(intervalMs);
      } else {
        break;
      }
    }
  }
  throw new Error(
    `muhaven-broker daemon did not become reachable within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface SetupFlags {
  /** Skip the background-spawn step; run the daemon attached to this shell
   *  (useful for systemd-style supervisors). When set, setup blocks. */
  foreground: boolean;
  /** Pass through to `runLogin`. */
  noLaunchBrowser: boolean;
  /** Override broker endpoint (mirrors `login --broker-endpoint`). */
  brokerEndpoint?: string;
  /** Override backend base URL. */
  backendBaseUrl?: string;
  /** Override dashboard base URL. */
  dashboardBaseUrl?: string;
  /** Skip the login step (operator will run it later). */
  skipLogin: boolean;
}

export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  let foreground = false;
  let noLaunchBrowser = false;
  let brokerEndpoint: string | undefined;
  let backendBaseUrl: string | undefined;
  let dashboardBaseUrl: string | undefined;
  let skipLogin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--foreground' || a === '-f') foreground = true;
    else if (a === '--no-launch-browser') noLaunchBrowser = true;
    else if (a === '--skip-login') skipLogin = true;
    else if (a === '--broker-endpoint' && i + 1 < argv.length) brokerEndpoint = argv[++i];
    else if (a === '--backend-base-url' && i + 1 < argv.length) backendBaseUrl = argv[++i];
    else if (a === '--dashboard-base-url' && i + 1 < argv.length) dashboardBaseUrl = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return {
    foreground,
    noLaunchBrowser,
    brokerEndpoint,
    backendBaseUrl,
    dashboardBaseUrl,
    skipLogin,
  };
}

export interface SetupDeps {
  /** Print to stdout. */
  print(line: string): void;
  /** Print to stderr. */
  printErr(line: string): void;
  /** Mint a 32-byte session key. */
  mintSessionKey(): string;
  /** Construct a broker client at the given endpoint. */
  newBrokerClient(endpoint: string, timeoutMs: number): Pick<BrokerClient, 'hello'>;
  /** Spawn the daemon as a detached child. Returns PID. */
  spawnDaemon(options: SpawnDaemonOptions): number;
  /** Wait for the daemon's `hello` to succeed. */
  waitForBroker(options: WaitForBrokerOptions): Promise<{ hasJwt: boolean }>;
  /** Run the login subcommand (delegates to existing `runLogin`). */
  runLogin(argv: readonly string[]): Promise<number>;
  /** Run the daemon attached to this shell (--foreground). */
  runForegroundDaemon(): Promise<void>;
  /** Resolve the path to the bin entry that daemon-mode should be spawned from. */
  resolveBinPath(): string;
  /** Snapshot of process env (injectable for tests). */
  env: Readonly<Record<string, string | undefined>>;
  /** Platform string (injectable). */
  platformId: NodeJS.Platform;
  /** OS release (injectable). */
  osRelease: string;
}

/**
 * Orchestrate the setup flow. Returns the process exit code (0 on success).
 *
 * Flow (default mode):
 *   1. Parse flags.
 *   2. Apply env defaults via `applyEnvDefaults`.
 *   3. If MUHAVEN_BROKER_SESSION_KEY not set, mint one.
 *   4. Probe the broker. Three branches per `decideSetupAction`:
 *      - `spawn_and_login`: spawn detached daemon, wait until reachable,
 *        then run login.
 *      - `login_only`: daemon already up, no JWT — just login.
 *      - `already_ready`: nothing to do; print summary + exit 0.
 *   5. Print PID + stop command + endpoint as a closing summary.
 *
 * `--foreground` short-circuits step 4 to run the daemon attached.
 */
export async function runSetup(argv: readonly string[], deps: SetupDeps): Promise<number> {
  let flags: SetupFlags;
  try {
    flags = parseSetupFlags(argv);
  } catch (err) {
    deps.printErr(`error: ${(err as Error).message}`);
    deps.printErr(
      'usage: muhaven-broker setup [--foreground|-f] [--no-launch-browser] [--skip-login]\n' +
        '                            [--broker-endpoint PATH] [--backend-base-url URL]\n' +
        '                            [--dashboard-base-url URL]',
    );
    return 2;
  }

  // 1. Env defaults — these are scoped to the child / the login flow.
  const overrides = applyEnvDefaults({
    env: deps.env,
    platformId: deps.platformId,
    osRelease: deps.osRelease,
  });
  for (const [k, v] of Object.entries(overrides.toSet)) {
    process.env[k] = v;
  }
  // Explicit CLI flag overrides win over auto-default values.
  if (flags.brokerEndpoint) process.env.MUHAVEN_BROKER_ENDPOINT = flags.brokerEndpoint;
  if (flags.backendBaseUrl) process.env.MUHAVEN_BACKEND_URL = flags.backendBaseUrl;
  if (flags.dashboardBaseUrl) process.env.MUHAVEN_DASHBOARD_URL = flags.dashboardBaseUrl;

  for (const name of overrides.preserved) {
    deps.print(`Env preserved: ${name}=${deps.env[name]}`);
  }
  for (const [k, v] of Object.entries(overrides.toSet)) {
    deps.print(`Env defaulted: ${k}=${v}`);
  }

  // 2. Session key. Self-mint if not provided. The minted value is
  // session-scoped (this process tree); the bound JWT is what governs
  // access, so the key itself is single-use authorization material.
  let mintedKey = false;
  if (!process.env.MUHAVEN_BROKER_SESSION_KEY || process.env.MUHAVEN_BROKER_SESSION_KEY === '') {
    process.env.MUHAVEN_BROKER_SESSION_KEY = deps.mintSessionKey();
    mintedKey = true;
    deps.print('Session key: minted fresh (32 random bytes).');
  } else {
    deps.print('Session key: using MUHAVEN_BROKER_SESSION_KEY from env.');
  }

  // 3. Foreground mode short-circuits everything else.
  if (flags.foreground) {
    deps.print('Foreground mode — running daemon attached to this shell. Ctrl-C to stop.');
    await deps.runForegroundDaemon();
    return 0;
  }

  // 4. Probe broker. loadMcpConfig reads from process.env so the defaults
  // we set above are picked up.
  const config = loadMcpConfig(process.env);
  const broker = deps.newBrokerClient(config.brokerEndpoint, config.brokerTimeoutMs);

  let helloProbe: { hasJwt: boolean } | null = null;
  try {
    helloProbe = await broker.hello();
  } catch {
    // Daemon not reachable — that's expected on first run.
  }

  const action = decideSetupAction({ hello: helloProbe });

  let daemonPid: number | null = null;
  if (action === 'spawn_and_login') {
    deps.print('Broker daemon: not running, starting one (detached) ...');
    daemonPid = deps.spawnDaemon({
      binPath: deps.resolveBinPath(),
      env: {
        // Mirror the resolved env onto the child so a future spawn (e.g.
        // restarted shell) inherits the same view.
        ...overrides.toSet,
        ...(flags.brokerEndpoint ? { MUHAVEN_BROKER_ENDPOINT: flags.brokerEndpoint } : {}),
        ...(flags.backendBaseUrl ? { MUHAVEN_BACKEND_URL: flags.backendBaseUrl } : {}),
        ...(flags.dashboardBaseUrl ? { MUHAVEN_DASHBOARD_URL: flags.dashboardBaseUrl } : {}),
        MUHAVEN_BROKER_SESSION_KEY: process.env.MUHAVEN_BROKER_SESSION_KEY!,
      },
    });
    try {
      const readyHello = await deps.waitForBroker({ broker });
      helloProbe = readyHello;
      deps.print(`Broker daemon: ready (PID ${daemonPid}, endpoint ${config.brokerEndpoint}).`);
    } catch (err) {
      deps.printErr((err as Error).message);
      deps.printErr(
        '  hint: re-run `muhaven-broker setup` after checking that no other broker is bound to the same endpoint.',
      );
      return 1;
    }
  } else {
    deps.print(`Broker daemon: already reachable at ${config.brokerEndpoint}.`);
  }

  // 5. Login (unless --skip-login or already authenticated).
  if (flags.skipLogin) {
    deps.print('Login: skipped per --skip-login.');
  } else if (helloProbe && helloProbe.hasJwt) {
    deps.print('Login: skipped — JWT already in keystore.');
  } else {
    const loginArgv: string[] = [];
    if (flags.noLaunchBrowser) loginArgv.push('--no-launch-browser');
    if (flags.brokerEndpoint) {
      loginArgv.push('--broker-endpoint', flags.brokerEndpoint);
    }
    if (flags.backendBaseUrl) {
      loginArgv.push('--backend-base-url', flags.backendBaseUrl);
    }
    if (flags.dashboardBaseUrl) {
      loginArgv.push('--dashboard-base-url', flags.dashboardBaseUrl);
    }
    const code = await deps.runLogin(loginArgv);
    if (code !== 0) {
      deps.printErr('Setup: login step failed — daemon is still running, re-run `muhaven-broker login` to retry.');
      if (daemonPid !== null) {
        deps.printErr(`  (daemon PID ${daemonPid}; stop with: kill ${daemonPid})`);
      }
      return code;
    }
  }

  // 6. Closing summary.
  deps.print('');
  deps.print('================================');
  deps.print('Setup complete.');
  if (daemonPid !== null) {
    deps.print(`  Daemon PID : ${daemonPid}`);
    deps.print(`  Endpoint   : ${config.brokerEndpoint}`);
    deps.print(
      `  Stop later : muhaven-broker logout${
        deps.platformId === 'win32' ? '' : ` && kill ${daemonPid}`
      }`,
    );
    if (deps.platformId === 'win32') {
      deps.print(`               (Windows: kill via Task Manager / Stop-Process -Id ${daemonPid})`);
    }
  }
  if (mintedKey) {
    deps.print('  Session key: ephemeral — minted by setup, lives only in the daemon process.');
  }
  deps.print('================================');
  return 0;
}
