/**
 * `muhaven-broker` CLI subcommand router.
 *
 * Subcommands:
 *   (none)         → run the daemon (production)
 *   login [flags]  → device-code flow client; stores JWT in keystore
 *   logout         → clear keystore JWT
 *   doctor         → environment + keystore capability report
 *   --help, -h     → usage
 */

import { hostname, platform, release } from 'node:os';
import { exec, spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import {
  defaultBrokerEndpoint,
  loadMcpConfig,
} from '../config.js';
import { BrokerClient } from '../clients/broker-client.js';
import { DeviceFlowClient, DeviceFlowAbortedError } from '../auth/device-flow.js';
import { openKeystore } from './keystore.js';
import { runBrokerDaemonCli } from './daemon.js';
import {
  mintSessionKey,
  runSetup as runSetupOrchestrator,
  spawnDaemon,
  waitForBroker,
  type SetupDeps,
  type ShellResult,
} from './setup.js';
import {
  defaultKillProcess,
  runStop as runStopOrchestrator,
  type StopDeps,
} from './stop.js';

function print(line: string): void {
  process.stdout.write(line + '\n');
}

function printErr(line: string): void {
  process.stderr.write(line + '\n');
}

function detectMcpHost(): string {
  // Best-effort: env vars set by some MCP hosts.
  // Note: `npm_lifecycle_event` is intentionally NOT used as a fallback
  // even though it's always present when run from `npm run …` — it's
  // the npm script name, not an MCP host identity, and ends up surfaced
  // on the dashboard `/link` page's "requesting client" panel where it
  // would mislead the user authorising the device flow.
  return (
    process.env.MCP_HOST_NAME ??
    process.env.CLAUDE_CODE_HOST ??
    'muhaven-broker-cli'
  );
}

function detectEnvironment(): { kind: string; warnings: string[] } {
  const warnings: string[] = [];
  const isWsl =
    platform() === 'linux' &&
    (process.env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(release()));
  if (isWsl) {
    warnings.push('WSL2 detected — Secret Service is usually absent. Use MUHAVEN_KEYRING=file.');
  }
  if (process.env.REMOTE_CONTAINERS === 'true' || process.env.CODESPACES === 'true') {
    warnings.push(
      'devcontainer / Codespace detected — keystore in container FS is ephemeral on rebuild.',
    );
  }
  if (process.env.SSH_CONNECTION) {
    warnings.push('SSH session detected — D-Bus / Secret Service is typically unavailable.');
  }
  return {
    kind: isWsl
      ? 'linux/wsl2'
      : process.env.REMOTE_CONTAINERS === 'true'
        ? 'devcontainer'
        : process.env.CODESPACES === 'true'
          ? 'codespace'
          : `${platform()}/${release()}`,
    warnings,
  };
}

interface LoginFlags {
  noLaunchBrowser: boolean;
  brokerEndpoint?: string;
  backendBaseUrl?: string;
  dashboardBaseUrl?: string;
  /**
   * Resolve `backendBaseUrl` + `dashboardBaseUrl` from the running
   * daemon's view (returned in `hello.effectiveConfig`) rather than the
   * CLI's env. Solves the daemon-vs-CLI env-divergence problem when the
   * CLI is launched from a different shell (ssh, IDE-spawned terminal)
   * than the systemd / launchd-launched daemon. Closes §3e⁶
   * F-broker-env-divergence.
   *
   * Mutually exclusive with explicit `--backend-base-url` /
   * `--dashboard-base-url`; the CLI rejects the combination so the
   * operator picks one source of truth.
   */
  fromDaemon: boolean;
}

export function parseLoginFlags(argv: readonly string[]): LoginFlags {
  let noLaunchBrowser = false;
  let brokerEndpoint: string | undefined;
  let backendBaseUrl: string | undefined;
  let dashboardBaseUrl: string | undefined;
  let fromDaemon = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch-browser') noLaunchBrowser = true;
    else if (a === '--from-daemon') fromDaemon = true;
    else if (a === '--broker-endpoint' && i + 1 < argv.length) {
      brokerEndpoint = argv[++i];
    } else if (a === '--backend-base-url' && i + 1 < argv.length) {
      backendBaseUrl = argv[++i];
    } else if (a === '--dashboard-base-url' && i + 1 < argv.length) {
      dashboardBaseUrl = argv[++i];
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  if (fromDaemon && (backendBaseUrl || dashboardBaseUrl)) {
    throw new Error(
      '--from-daemon is mutually exclusive with --backend-base-url / --dashboard-base-url',
    );
  }
  return { noLaunchBrowser, brokerEndpoint, backendBaseUrl, dashboardBaseUrl, fromDaemon };
}

async function tryLaunchBrowser(url: string): Promise<boolean> {
  // Best-effort browser open. Failure is non-fatal — the URL is also
  // printed so the user can paste it.
  return new Promise<boolean>((resolve) => {
    const cmd =
      platform() === 'win32'
        ? `cmd /c start "" "${url}"`
        : platform() === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, (err) => resolve(err == null));
  });
}

export async function runLogin(argv: readonly string[]): Promise<number> {
  let flags: LoginFlags;
  try {
    flags = parseLoginFlags(argv);
  } catch (err) {
    printErr(`error: ${(err as Error).message}`);
    printErr(
      'usage: muhaven-broker login [--no-launch-browser] [--broker-endpoint PATH] [--from-daemon | (--backend-base-url URL --dashboard-base-url URL)]',
    );
    return 2;
  }

  const env = process.env;
  const config = loadMcpConfig({
    ...env,
    ...(flags.brokerEndpoint ? { MUHAVEN_BROKER_ENDPOINT: flags.brokerEndpoint } : {}),
    ...(flags.backendBaseUrl ? { MUHAVEN_BACKEND_URL: flags.backendBaseUrl } : {}),
    ...(flags.dashboardBaseUrl ? { MUHAVEN_DASHBOARD_URL: flags.dashboardBaseUrl } : {}),
  });

  const broker = new BrokerClient({
    endpoint: config.brokerEndpoint,
    timeoutMs: config.brokerTimeoutMs,
  });

  // Sanity check — broker reachable? Also captures `effectiveConfig` for
  // the `--from-daemon` flag.
  let helloResult;
  try {
    helloResult = await broker.hello();
  } catch (err) {
    printErr(
      `cannot reach muhaven-broker daemon at ${config.brokerEndpoint}: ${(err as Error).message}`,
    );
    printErr('hint: start the daemon first (`muhaven-broker` with no subcommand).');
    return 1;
  }

  // Resolve the URLs the device-flow + token-store ceremonies will hit.
  // Default: CLI's loadMcpConfig view (env + flag overrides).
  // `--from-daemon`: take the daemon's effective view from `hello.effectiveConfig`.
  let backendBaseUrl = config.backendBaseUrl;
  let dashboardBaseUrl = config.dashboardBaseUrl;
  if (flags.fromDaemon) {
    if (!helloResult.effectiveConfig) {
      printErr(
        '--from-daemon requested but broker did not return effectiveConfig (daemon is older than protocol 0.3.0). Upgrade the daemon (`@muhaven/mcp@0.1.3+`) or drop the flag.',
      );
      return 1;
    }
    const daemonBackend = helloResult.effectiveConfig.backendBaseUrl;
    const daemonDashboard = helloResult.effectiveConfig.dashboardBaseUrl;
    // Empty-URL guard — `loadBrokerConfig` always trims + defaults, so an
    // empty string here means the daemon was somehow rebuilt with the
    // contract broken. Refuse to proceed rather than pass `''` into
    // `DeviceFlowClient` and chase a confusing fetch error.
    if (!daemonBackend || !daemonDashboard) {
      printErr(
        '--from-daemon: daemon returned an empty backend/dashboard URL — refusing to proceed.',
      );
      return 1;
    }
    // Defense-in-depth: if the daemon's effective URL diverges from
    // what the CLI sees in its own env, emit a structured warning so a
    // local-daemon impersonation or a misconfigured stage-vs-prod env
    // doesn't silently route the device-flow ceremony to the wrong host.
    // The trust model assumes a same-user, same-machine daemon (the
    // socket is mode 0600); this warning is visibility, not enforcement.
    if (daemonBackend !== config.backendBaseUrl) {
      print(
        `⚠ daemon backend (${daemonBackend}) differs from CLI env (${config.backendBaseUrl}). Using daemon's value per --from-daemon.`,
      );
    }
    if (daemonDashboard !== config.dashboardBaseUrl) {
      print(
        `⚠ daemon dashboard (${daemonDashboard}) differs from CLI env (${config.dashboardBaseUrl}). Using daemon's value per --from-daemon.`,
      );
    }
    backendBaseUrl = daemonBackend;
    dashboardBaseUrl = daemonDashboard;
    print(`Using daemon's effective config:`);
    print(`  backend:   ${backendBaseUrl}`);
    print(`  dashboard: ${dashboardBaseUrl}`);
  }

  const flow = new DeviceFlowClient({
    backendBaseUrl,
    dashboardBaseUrl,
    requesterMetadata: {
      processName: detectMcpHost(),
      hostname: hostname(),
      os: `${platform()}/${release()}`,
    },
  });

  let lastIssuedSec = 0;
  try {
    const generator = flow.run();
    let result: { jwt: string; expiresAtSec: number | null; scope: string[] | null } | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      const event = next.value;
      switch (event.type) {
        case 'code_issued':
          lastIssuedSec = Date.now();
          print('');
          print(`To link this Claude / Cursor / Claude Code install to MuHaven:`);
          print('');
          print(`  1. Open ${event.code.verificationUriComplete}`);
          print(`  2. Verify the device fingerprint shown on that page`);
          print(`  3. Authorize with your passkey`);
          print('');
          print(`Code expires in ${event.code.expiresInSec}s.`);
          if (!flags.noLaunchBrowser) {
            await tryLaunchBrowser(event.code.verificationUriComplete);
          }
          print('Waiting for authorization…');
          break;
        case 'polling':
          // suppressed — too noisy
          void event;
          break;
        case 'denied':
          printErr(`device authorization DENIED${event.reason ? `: ${event.reason}` : ''}`);
          break;
        case 'expired':
          printErr('device code expired — re-run `muhaven-broker login` to issue a new one');
          break;
        case 'authorized':
          print(`Authorized in ${Math.round((Date.now() - lastIssuedSec) / 1000)}s.`);
          break;
      }
    }

    if (!result) return 1;
    await broker.storeJwt(result.jwt, result.expiresAtSec ?? undefined);
    print('JWT stored in keystore. MuHaven MCP tools will use it on next call.');
    return 0;
  } catch (err) {
    if (err instanceof DeviceFlowAbortedError) {
      printErr(`device flow aborted: ${err.detail.code}`);
      return 1;
    }
    printErr(`unexpected error: ${(err as Error).message}`);
    return 1;
  }
}

export async function runLogout(): Promise<number> {
  const config = loadMcpConfig();
  const broker = new BrokerClient({
    endpoint: config.brokerEndpoint,
    timeoutMs: config.brokerTimeoutMs,
  });
  try {
    await broker.clearJwt();
    print('JWT cleared from keystore.');
    return 0;
  } catch (err) {
    printErr(`logout failed: ${(err as Error).message}`);
    return 1;
  }
}

export async function runDoctor(): Promise<number> {
  print('muhaven-broker doctor');
  print('=====================');
  const env = detectEnvironment();
  print(`Environment       : ${env.kind}`);
  for (const w of env.warnings) print(`  warning: ${w}`);
  print(`Default endpoint  : ${defaultBrokerEndpoint()}`);
  print(`Configured endpoint: ${process.env.MUHAVEN_BROKER_ENDPOINT ?? defaultBrokerEndpoint()}`);
  print(`Backend URL       : ${process.env.MUHAVEN_BACKEND_URL ?? '(default https://api.muhaven.app)'}`);
  print(`Dashboard URL     : ${process.env.MUHAVEN_DASHBOARD_URL ?? '(default https://muhaven.app)'}`);

  const wantFile = process.env.MUHAVEN_KEYRING?.toLowerCase() === 'file';
  print(`Keystore preference: ${wantFile ? 'file (env override)' : 'auto (OS keychain → file fallback)'}`);

  // Probe keystore + report which backend is selected.
  const { keystore, fallbackReason } = await openKeystore();
  print(`Keystore backend  : ${keystore.backend}${fallbackReason ? ` (fell back: ${fallbackReason})` : ''}`);

  // H-3 follow-on: exercise the keystore's set→get→clear chain so the
  // doctor catches a write-fails-but-read-succeeds asymmetry that the
  // probe alone wouldn't. Two paths:
  //
  // 1. Already logged in: `keystore.get()` already proved that the
  //    keystore is functional, AND there is real data we'd risk losing
  //    if we wrote a sentinel and the readback throws (the catch block
  //    cannot restore what it never captured atomically). Skip the
  //    sentinel write entirely.
  //
  // 2. Fresh install (get() returns null): set+get+clear with a
  //    sentinel. The sentinel JWT shape (`__doctor_sentinel__.x.y`) is
  //    deliberately malformed-as-JWT so even if `clear()` silently
  //    fails on this OS, the broker would never accept it as a real
  //    JWT — worst case is "doctor leaves an orphan; user runs
  //    muhaven-broker logout". Self-review 2026-05-10 split this from
  //    the prior single-path implementation that overwrote the real
  //    JWT during the round-trip.
  try {
    const original = await keystore.get();
    if (original) {
      print(`Keystore round-trip: ok (existing JWT not disturbed)`);
    } else {
      const sentinel = { jwt: '__doctor_sentinel__.x.y', expiresAtSec: null, storedAtSec: 0 };
      await keystore.set(sentinel);
      const read = await keystore.get();
      await keystore.clear();
      if (read?.jwt !== sentinel.jwt) {
        print(`Keystore round-trip: FAILED (wrote sentinel, read back ${read?.jwt ?? 'null'})`);
      } else {
        print(`Keystore round-trip: ok`);
      }
    }
  } catch (err) {
    print(`Keystore round-trip: FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  // Probe broker reachability.
  const config = loadMcpConfig();
  const broker = new BrokerClient({
    endpoint: config.brokerEndpoint,
    timeoutMs: config.brokerTimeoutMs,
  });
  try {
    const h = await broker.hello();
    // hasSessionKey is optional in the response (added in protocol 0.3.0);
    // an undefined value means a pre-0.3.0 daemon which always had a key.
    const hasKey = h.hasSessionKey ?? true;
    const keyTag = hasKey ? `signer ${h.sessionKeyAddress}` : 'NO SESSION KEY (read-only posture)';
    print(`Broker daemon     : reachable (proto v${h.version}, ${keyTag}, hasJwt=${h.hasJwt})`);
    if (h.effectiveConfig) {
      print(`Daemon backend URL: ${h.effectiveConfig.backendBaseUrl}`);
      print(`Daemon dashboard  : ${h.effectiveConfig.dashboardBaseUrl}`);
    }
    return 0;
  } catch (err) {
    print(`Broker daemon     : NOT reachable (${(err as Error).message})`);
    print('  hint: start it with `muhaven-broker` (no subcommand)');
    return 1;
  }
}

function printUsage(): void {
  print('usage: muhaven-broker [<subcommand>] [options]');
  print('');
  print('  (no subcommand)    Run the daemon (production mode)');
  print('  setup              One-shot install: env defaults + session key + detached daemon + login');
  print('                       [--foreground|-f] keeps the daemon attached (skip background spawn)');
  print('                       [--skip-login] starts the daemon but lets you run login later');
  print('                       [--no-launch-browser] pass-through to login');
  print('                       [--register HOST[,HOST...]] auto-wire the MCP server into the named host');
  print('                         (claude-code today; claude-desktop / cursor reserved for Wave 5)');
  print('                       [--register-scope user|project|local] scope for the host-config write');
  print('                         (default: user — every project sees the server)');
  print('  stop               Cleanly stop a running daemon (SIGTERM with SIGKILL fallback');
  print('                       after 5s). Also clears the keystore JWT as a best effort.');
  print('  login              Acquire a JWT via the device-code flow + store in keystore');
  print('                       [--from-daemon] resolves backend/dashboard URLs from the running daemon');
  print('  logout             Clear the JWT from the keystore (does NOT stop the daemon)');
  print('  doctor             Print environment + keystore + reachability report');
  print('  -h, --help         Show this help');
  print('  -v, --version      Print the @muhaven/mcp package version');
}

/**
 * `__SERVER_VERSION__` is replaced by tsup at build time (see tsup.config.ts
 * `define`) — same constant the MCP server's `serverInfo.version` resolves
 * from. Mirrored here (rather than importing from `../server.js`) because
 * tsup builds `broker.cjs` as a separate entry; importing from server.ts
 * would pull the entire MCP server module + viem + zod + SDK into the
 * broker bundle. The 5-line duplication is cheaper than the ~600KB of
 * inlined deps.
 */
declare const __SERVER_VERSION__: string | undefined;

export function getBrokerPackageVersion(): string {
  if (typeof __SERVER_VERSION__ === 'string' && __SERVER_VERSION__) {
    return __SERVER_VERSION__;
  }
  // Test / unbundled fallback — only reached when cli.ts is imported
  // outside the tsup-built broker.cjs (e.g. vitest direct import).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

function printVersion(): void {
  print(`muhaven-broker @muhaven/mcp@${getBrokerPackageVersion()}`);
}

/**
 * Resolve the absolute path to the `muhaven-broker.cjs` bin entry the
 * daemon should be spawned from. Uses __dirname (provided by tsup's
 * `shims: true` for both ESM and CJS outputs) so the spawn target is
 * deterministic and doesn't depend on `process.argv[1]` — which on
 * Windows global npm installs can be a `.cmd` / `.ps1` shim path that
 * `spawn(node, [shim])` doesn't know how to launch.
 *
 * At runtime, this file is bundled to `<pkg>/dist/broker.cjs`; the bin
 * lives next door at `<pkg>/bin/muhaven-broker.cjs`. Same package,
 * deterministic relative offset.
 */
function resolveBrokerBinPath(): string {
  return resolvePath(__dirname, '..', 'bin', 'muhaven-broker.cjs');
}

/**
 * Default `shellOut` implementation — spawns a child with argv (NOT
 * shell-string interpolation), captures stdout/stderr, returns the
 * three-tuple. Argv passes through verbatim, so a JSON blob containing
 * shell metacharacters (`{`, `"`, `$`) is safe — node's `spawn` does
 * NOT invoke `/bin/sh -c`. On Windows we set `shell: false` and rely on
 * `.cmd` / `.exe` resolution via npm's bin-shim convention; if a host
 * CLI is only available as a `.cmd` shim (typical for npm-global
 * installs on Windows), Node's spawn falls back to invoking it through
 * `cmd.exe` automatically since Node 18.
 */
function defaultShellOut(cmd: string, argv: readonly string[]): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(cmd, argv, {
      // Inherit env so PATH + npm-shim resolution work; explicitly NOT
      // forwarding stdio so the parent's transcript stays clean.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows: .cmd / .ps1 shims under %APPDATA%\npm need cmd.exe
      // to interpret them. Node 18+ auto-routes through cmd.exe when
      // it sees a non-.exe extension, but explicitly setting
      // `shell: true` on Windows is safer for npm-global PATH entries.
      // On POSIX, `shell: false` (the default) is correct + safer.
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Wire `runSetup` against the real cli helpers + IO. Kept here (not in
 * `setup.ts`) so the pure orchestrator stays free of the cli-only
 * `runLogin` import (which would pull device-flow + viem into the test
 * surface unnecessarily).
 */
export async function runSetup(argv: readonly string[]): Promise<number> {
  const deps: SetupDeps = {
    print,
    printErr,
    mintSessionKey,
    newBrokerClient: (endpoint, timeoutMs) => new BrokerClient({ endpoint, timeoutMs }),
    spawnDaemon,
    waitForBroker,
    runLogin,
    runForegroundDaemon: runBrokerDaemonCli,
    resolveBinPath: resolveBrokerBinPath,
    env: process.env,
    platformId: process.platform,
    osRelease: release(),
    shellOut: defaultShellOut,
  };
  return runSetupOrchestrator(argv, deps);
}

/**
 * Wire `runStop` against the real BrokerClient + Node's process.kill.
 */
export async function runStop(): Promise<number> {
  const config = loadMcpConfig();
  const deps: StopDeps = {
    print,
    printErr,
    newBrokerClient: (endpoint, timeoutMs) => new BrokerClient({ endpoint, timeoutMs }),
    killProcess: defaultKillProcess,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    endpoint: config.brokerEndpoint,
    brokerTimeoutMs: config.brokerTimeoutMs,
  };
  return runStopOrchestrator(deps);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
      await runBrokerDaemonCli();
      return 0;
    case 'setup':
      return runSetup(rest);
    case 'stop':
      return runStop();
    case 'login':
      return runLogin(rest);
    case 'logout':
      return runLogout();
    case 'doctor':
      return runDoctor();
    case '-h':
    case '--help':
      printUsage();
      return 0;
    case '-v':
    case '--version':
      printVersion();
      return 0;
    default:
      printErr(`unknown subcommand: ${sub}`);
      printUsage();
      return 2;
  }
}
