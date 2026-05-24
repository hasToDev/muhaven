/**
 * `muhaven-broker start` / `muhaven-broker update` — install a
 * DASHBOARD-minted Scoped session key onto the broker daemon in one shot.
 *
 * Wave 5 Option D OPEN-D (2026-05-24). Replaces the manual last mile after
 * a dashboard mint / revoke:
 *
 *   start  — bring the daemon UP on a provided key (daemon NOT running).
 *   update — ROTATE the key on a (possibly) running daemon: stop → swap →
 *            restart → REUSE the existing JWT (a key rotation must not
 *            force a device-code re-login).
 *
 * Both resolve the key via the shared precedence (`--session` flag >
 * interactive masked prompt > error — see `session-input.ts`). Both
 * REQUIRE a key (unlike `setup`, which self-mints on the fresh-install
 * path). The key is injected ONLY into the spawned daemon's child env
 * (**Option B** — operator decision 2026-05-24); it never touches disk,
 * so the daemon (`loadBrokerConfig`) and the keystore stay unchanged.
 *
 * The orchestrator is pure-ish: all IO (broker IPC, daemon spawn, stop,
 * login, prompts) is injected via `BringUpDeps` so the decision tree is
 * unit-testable without spawning real processes — mirrors the
 * `runSetup` / `runStop` style.
 */

import type { BrokerClient } from '../clients/broker-client.js';
import { loadMcpConfig } from '../config.js';
import {
  applyEnvDefaults,
  validateBrokerEndpointFlag,
  validateHttpUrlFlag,
  type SpawnDaemonOptions,
  type WaitForBrokerOptions,
} from './setup.js';
import { resolveSessionKey, type SessionPromptDeps } from './session-input.js';

export type BringUpMode = 'start' | 'update';

export interface BringUpFlags {
  /** `--session <key|->`. Undefined → resolve via interactive prompt. */
  session?: string;
  /** Pass-through to `runLogin`. */
  noLaunchBrowser: boolean;
  /** Skip the login step (operator runs it later). */
  skipLogin: boolean;
  /** Override broker endpoint. */
  brokerEndpoint?: string;
  /** Override backend base URL. */
  backendBaseUrl?: string;
  /** Override dashboard base URL. */
  dashboardBaseUrl?: string;
}

export function parseBringUpFlags(argv: readonly string[]): BringUpFlags {
  let session: string | undefined;
  let noLaunchBrowser = false;
  let skipLogin = false;
  let brokerEndpoint: string | undefined;
  let backendBaseUrl: string | undefined;
  let dashboardBaseUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch-browser') noLaunchBrowser = true;
    else if (a === '--skip-login') skipLogin = true;
    else if (a === '--session') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--session requires a value (a 0x… key, or `-` to read from stdin)');
      }
      // A session key is always 0x-prefixed and `-` is the stdin sentinel —
      // a flag-like token (`--skip-login`) is never a valid value, so
      // reject it with a clear message instead of a confusing
      // "must be 0x-prefixed" shape error one layer down.
      if (next !== '-' && next.startsWith('-')) {
        throw new Error(`--session requires a key value (or \`-\` for stdin), got flag: ${next}`);
      }
      session = argv[++i];
    } else if (a === '--broker-endpoint' && i + 1 < argv.length) brokerEndpoint = argv[++i];
    else if (a === '--backend-base-url' && i + 1 < argv.length) backendBaseUrl = argv[++i];
    else if (a === '--dashboard-base-url' && i + 1 < argv.length) dashboardBaseUrl = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return { session, noLaunchBrowser, skipLogin, brokerEndpoint, backendBaseUrl, dashboardBaseUrl };
}

export interface BringUpDeps {
  print(line: string): void;
  printErr(line: string): void;
  /** Construct a broker client at the given endpoint. */
  newBrokerClient(endpoint: string, timeoutMs: number): Pick<BrokerClient, 'hello'>;
  /** Spawn the daemon as a detached child. Returns PID. */
  spawnDaemon(options: SpawnDaemonOptions): number;
  /** Wait for the daemon's `hello` to succeed. */
  waitForBroker(options: WaitForBrokerOptions): Promise<{ hasJwt: boolean }>;
  /**
   * Stop a running daemon (used by `update` only). MUST preserve the
   * keystore JWT — a key rotation should not force a device-code
   * re-login. The cli wires this to `runStop` with `clearJwtOnStop:
   * false`. Takes the RESOLVED endpoint + timeout (which honour a
   * `--broker-endpoint` override) so update stops the same daemon it
   * probed + is about to respawn. Returns the stop exit code.
   */
  stopDaemon(endpoint: string, brokerTimeoutMs: number): Promise<number>;
  /** Run the login subcommand (device-code flow → JWT into keystore). */
  runLogin(argv: readonly string[]): Promise<number>;
  /** Resolve the path to the bin entry the daemon is spawned from. */
  resolveBinPath(): string;
  /** Snapshot of process env (injectable for tests). */
  env: Readonly<Record<string, string | undefined>>;
  /** Platform string (injectable). */
  platformId: NodeJS.Platform;
  /** OS release (injectable). */
  osRelease: string;
  /** Interactive session-key prompt deps (TTY-aware). */
  sessionPrompt: SessionPromptDeps;
}

function usageLine(mode: BringUpMode): string {
  return (
    `usage: muhaven-broker ${mode} --session <key|-> [--no-launch-browser] [--skip-login]\n` +
    '                            [--broker-endpoint PATH] [--backend-base-url URL]\n' +
    '                            [--dashboard-base-url URL]\n' +
    '       (omit --session to be asked interactively; pipe the key with `--session -`)'
  );
}

/**
 * Orchestrate `start` / `update`. Returns the process exit code (0 on
 * success). Pure-ish — only injected IO.
 */
export async function runBringUp(
  mode: BringUpMode,
  argv: readonly string[],
  deps: BringUpDeps,
): Promise<number> {
  let flags: BringUpFlags;
  try {
    flags = parseBringUpFlags(argv);
  } catch (err) {
    deps.printErr(`error: ${(err as Error).message}`);
    deps.printErr(usageLine(mode));
    return 2;
  }

  // Validate URL + endpoint flags BEFORE spawning anything (a bad
  // --backend-base-url would otherwise ship the JWT to an attacker host
  // via the device-flow ceremony — same guard as `setup`).
  if (flags.backendBaseUrl) {
    const e = validateHttpUrlFlag('--backend-base-url', flags.backendBaseUrl);
    if (e) {
      deps.printErr(`error: ${e}`);
      return 2;
    }
  }
  if (flags.dashboardBaseUrl) {
    const e = validateHttpUrlFlag('--dashboard-base-url', flags.dashboardBaseUrl);
    if (e) {
      deps.printErr(`error: ${e}`);
      return 2;
    }
  }
  if (flags.brokerEndpoint) {
    const e = validateBrokerEndpointFlag(flags.brokerEndpoint, deps.platformId);
    if (e) {
      deps.printErr(`error: ${e}`);
      return 2;
    }
  }

  // Resolve the session key. start + update both REQUIRE one (no self-mint).
  const resolution = await resolveSessionKey({
    sessionFlag: flags.session,
    policy: 'require',
    deps: deps.sessionPrompt,
  });
  if (resolution.kind !== 'key') {
    // policy 'require' yields only 'key' or 'error'; treat anything else
    // (defensively) as an error so a future policy change can't silently
    // fall through to a keyless spawn.
    const message = resolution.kind === 'error' ? resolution.message : 'no session key resolved';
    deps.printErr(`error: ${message}`);
    return 2;
  }
  const sessionKey = resolution.key;

  // Build the effective env locally (mirror setup) — NEVER mutate
  // process.env, which would leak the key + URLs into later children.
  const overrides = applyEnvDefaults({
    env: deps.env,
    platformId: deps.platformId,
    osRelease: deps.osRelease,
  });
  const effectiveEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) {
    if (typeof v === 'string') effectiveEnv[k] = v;
  }
  for (const [k, v] of Object.entries(overrides.toSet)) effectiveEnv[k] = v;
  if (flags.brokerEndpoint) effectiveEnv.MUHAVEN_BROKER_ENDPOINT = flags.brokerEndpoint;
  if (flags.backendBaseUrl) effectiveEnv.MUHAVEN_BACKEND_URL = flags.backendBaseUrl;
  if (flags.dashboardBaseUrl) effectiveEnv.MUHAVEN_DASHBOARD_URL = flags.dashboardBaseUrl;

  // Names only for preserved vars (operator-owned — don't echo values);
  // values for defaulted vars (we chose them, they're public).
  for (const name of overrides.preserved) deps.print(`Env preserved: ${name} (set in your shell)`);
  for (const [k, v] of Object.entries(overrides.toSet)) deps.print(`Env defaulted: ${k}=${v}`);

  const config = loadMcpConfig(effectiveEnv);
  const broker = deps.newBrokerClient(config.brokerEndpoint, config.brokerTimeoutMs);

  // Probe whether a daemon is already bound to the endpoint.
  let running = false;
  try {
    await broker.hello();
    running = true;
  } catch {
    running = false;
  }

  if (mode === 'start') {
    if (running) {
      // Don't silently leave a stale-key daemon running — point the
      // operator at `update`, which performs the stop → swap → restart.
      deps.printErr(
        `Broker daemon is already running at ${config.brokerEndpoint}. ` +
          'To rotate its key use:  muhaven-broker update --session <key>',
      );
      return 1;
    }
    deps.print('Broker daemon: not running — starting one (detached) on the provided key ...');
  } else {
    // update: fully stop the old daemon BEFORE the new one binds the
    // endpoint (no two daemons racing the same socket).
    if (running) {
      deps.print('Broker daemon: running — stopping it before installing the new key ...');
      const stopCode = await deps.stopDaemon(config.brokerEndpoint, config.brokerTimeoutMs);
      if (stopCode !== 0) {
        deps.printErr(
          `Broker daemon stop returned ${stopCode}; refusing to start a second daemon on the ` +
            'same endpoint. Resolve the running daemon (muhaven-broker doctor) and retry.',
        );
        return stopCode;
      }
    } else {
      deps.print('Broker daemon: not running — `update` will start a fresh one on the provided key.');
    }
  }

  // Spawn the detached daemon with the key in its CHILD ENV only (Option B
  // — never written to disk). spawnDaemon strips dangerous NODE_* vars.
  const daemonPid = deps.spawnDaemon({
    binPath: deps.resolveBinPath(),
    env: {
      ...overrides.toSet,
      MUHAVEN_BROKER_ENDPOINT: config.brokerEndpoint,
      MUHAVEN_BACKEND_URL: effectiveEnv.MUHAVEN_BACKEND_URL!,
      MUHAVEN_DASHBOARD_URL: effectiveEnv.MUHAVEN_DASHBOARD_URL!,
      MUHAVEN_BROKER_SESSION_KEY: sessionKey,
    },
  });

  let ready: { hasJwt: boolean };
  try {
    ready = await deps.waitForBroker({ broker });
  } catch (err) {
    deps.printErr((err as Error).message);
    deps.printErr(
      '  hint: check that no other broker is bound to the same endpoint (muhaven-broker doctor).',
    );
    return 1;
  }
  deps.print(`Broker daemon: ready (PID ${daemonPid}, endpoint ${config.brokerEndpoint}).`);

  // Verify the daemon actually LOADED the key. A daemon that boots with an
  // empty/absent MUHAVEN_BROKER_SESSION_KEY comes up in read-only posture
  // SILENTLY (`spawnDaemon` uses `stdio: 'ignore'`, so its breadcrumb is
  // discarded) and `sign_userop` would fail later with
  // `session_key_unavailable`. `hello.hasSessionKey` is the authoritative
  // aliveness check (per protocol.ts); a read-only daemon also returns the
  // ZERO address as `sessionKeyAddress`, so the signer line must be gated
  // on it too. The whole point of start/update is a TRUSTWORTHY one-paste
  // re-arm — it must not report success on a daemon that can't sign.
  // This hello is otherwise best-effort: a transient IPC failure here
  // (the daemon IS up — waitForBroker just succeeded) skips the signer
  // line rather than failing the command.
  try {
    const h = (await broker.hello()) as {
      sessionKeyAddress?: string;
      hasSessionKey?: boolean;
    };
    // `?? true`: a pre-0.3.0 daemon omits the field and always had a key.
    // Our freshly-spawned daemon is same-version, so it's always present.
    const hasKey = h.hasSessionKey ?? true;
    if (!hasKey) {
      deps.printErr(
        'Broker came up in READ-ONLY posture — the session key did not reach the daemon, ' +
          'so it cannot sign. Stop it (muhaven-broker stop) and retry.',
      );
      return 1;
    }
    if (h.sessionKeyAddress) deps.print(`Broker signer: ${h.sessionKeyAddress}`);
  } catch {
    /* non-fatal — the daemon is up; the signer line is a convenience */
  }

  // JWT handling. REUSE the keystore JWT when present (the JWT is
  // broker-identity, independent of the session key — a key rotation must
  // not force a fresh device-code flow). Only login when there genuinely
  // isn't one (and --skip-login wasn't passed).
  if (flags.skipLogin) {
    deps.print('Login: skipped per --skip-login.');
  } else if (ready.hasJwt) {
    deps.print('Login: skipped — JWT already in keystore (reused).');
  } else {
    const loginArgv: string[] = [];
    if (flags.noLaunchBrowser) loginArgv.push('--no-launch-browser');
    if (flags.brokerEndpoint) loginArgv.push('--broker-endpoint', flags.brokerEndpoint);
    if (flags.backendBaseUrl) loginArgv.push('--backend-base-url', flags.backendBaseUrl);
    if (flags.dashboardBaseUrl) loginArgv.push('--dashboard-base-url', flags.dashboardBaseUrl);
    // login reads loadMcpConfig() from process.env — seed + restore around
    // the call so we don't pollute the operator's shell.
    const restorationKeys = [
      'MUHAVEN_BACKEND_URL',
      'MUHAVEN_DASHBOARD_URL',
      'MUHAVEN_BROKER_ENDPOINT',
    ];
    const originalValues: Record<string, string | undefined> = {};
    for (const k of restorationKeys) {
      originalValues[k] = process.env[k];
      if (effectiveEnv[k]) process.env[k] = effectiveEnv[k];
    }
    let code: number;
    try {
      code = await deps.runLogin(loginArgv);
    } finally {
      for (const k of restorationKeys) {
        if (originalValues[k] === undefined) delete process.env[k];
        else process.env[k] = originalValues[k];
      }
    }
    if (code !== 0) {
      deps.printErr(
        'Login step failed — the daemon is running on the new key; re-run ' +
          '`muhaven-broker login` to retry.',
      );
      return code;
    }
  }

  // Closing summary.
  deps.print('');
  deps.print('================================');
  deps.print(mode === 'start' ? 'Broker started.' : 'Session key rotated.');
  deps.print(`  Daemon PID : ${daemonPid}`);
  const killCmd =
    deps.platformId === 'win32' ? `Stop-Process -Id ${daemonPid}` : `kill ${daemonPid}`;
  deps.print(`  Stop daemon: ${killCmd}   (or: muhaven-broker stop)`);
  deps.print(`  Endpoint   : ${config.brokerEndpoint}`);
  deps.print('  Rotate key : muhaven-broker update --session <new-key>');
  deps.print('================================');
  return 0;
}
