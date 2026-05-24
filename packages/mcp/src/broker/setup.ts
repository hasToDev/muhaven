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
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import { generatePrivateKey } from 'viem/accounts';
import { BrokerClient } from '../clients/broker-client.js';
import { loadMcpConfig } from '../config.js';
import { resolveSessionKey, type SessionPromptDeps } from './session-input.js';

/**
 * Env vars we deliberately strip from the spawned daemon's env, even if the
 * operator's shell has them set. Any one of these lets a same-user attacker
 * hijack the long-lived daemon's execution and exfiltrate the session-key
 * private half:
 *
 *   - `NODE_OPTIONS`: `--require=/tmp/x.js` loads arbitrary JS into the
 *     daemon process.
 *   - `NODE_TLS_REJECT_UNAUTHORIZED=0`: disables TLS-cert verification on
 *     every outbound HTTPS call the daemon makes.
 *   - `NODE_EXTRA_CA_CERTS`: silently adds attacker-controlled CAs to the
 *     trust store.
 *   - `NODE_PATH`: redirects module resolution.
 *
 * Defense-in-depth: the parent setup process inherits these from the
 * operator's shell, but the spawned daemon (which holds the session key)
 * MUST NOT. Stripped at spawn time by `spawnDaemon`. Security review
 * 2026-05-17 (parallel agent pass after the initial setup landing).
 */
const DANGEROUS_NODE_ENV_VARS = [
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
] as const;

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
 * Returns a freshly minted secp256k1-valid private key in 0x-prefixed hex
 * form. Uses viem's `generatePrivateKey` so the result is guaranteed to be
 * in the valid scalar range `[1, n-1]` for secp256k1 — `crypto.randomBytes`
 * alone has a (negligible but nonzero) probability of returning a value
 * that the signer would reject as invalid, surfacing later as a confusing
 * runtime error.
 */
export function mintSessionKey(): string {
  return generatePrivateKey();
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
  // Strip dangerous NODE_* env vars before merging (see DANGEROUS_NODE_ENV_VARS
  // doc-comment above for the threat model). The daemon holds the session-key
  // private half for its lifetime; an attacker who can inject NODE_OPTIONS
  // into the operator's shell would otherwise bypass every other defense.
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!DANGEROUS_NODE_ENV_VARS.includes(k as (typeof DANGEROUS_NODE_ENV_VARS)[number])) {
      sanitized[k] = v;
    }
  }
  const merged: NodeJS.ProcessEnv = { ...sanitized, ...options.env };
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

/**
 * Validate a URL the operator passed via `--backend-base-url` or
 * `--dashboard-base-url`. Returns `null` on valid; an error string on
 * invalid. The check is:
 *
 *   - Parses cleanly via `new URL(value)`.
 *   - Protocol is `https:`, OR `http:` for localhost / 127.0.0.1 (dev carve-out).
 *
 * Refuses `javascript:`, `file:`, `data:`, plain `http:` to non-loopback,
 * and unparseable input. Defense against the OAuth-device-flow phishing
 * vector where a malicious `--backend-base-url` ships the JWT to an attacker.
 */
export function validateHttpUrlFlag(name: string, value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${name} is not a valid URL: ${value}`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return null;
    return `${name} must use https:// (got http:// to ${host} — refusing to ship JWT cleartext)`;
  }
  return `${name} must use https:// (got ${parsed.protocol})`;
}

/**
 * Validate a broker IPC endpoint passed via `--broker-endpoint`. Returns
 * `null` on valid; an error string on invalid. Shape-only check —
 * doesn't probe whether anything is bound at that endpoint.
 */
export function validateBrokerEndpointFlag(
  value: string,
  platformId: NodeJS.Platform,
): string | null {
  if (!value || value.length === 0) {
    return '--broker-endpoint cannot be empty';
  }
  if (platformId === 'win32') {
    // Must be a named pipe path. Accept the two forward-slash spelling some
    // bash-on-Windows installs surface; both normalize to the same kernel
    // object.
    if (value.startsWith('\\\\.\\pipe\\') || value.startsWith('//./pipe/')) {
      return null;
    }
    return '--broker-endpoint on Windows must be a named pipe path (\\\\.\\pipe\\...)';
  }
  // POSIX socket — must be an absolute path. Defense against `--broker-endpoint
  // attacker.sock` resolved against the caller's CWD.
  if (!value.startsWith('/')) {
    return '--broker-endpoint on POSIX must be an absolute path (e.g. /run/muhaven/broker.sock)';
  }
  return null;
}

/**
 * Env vars `runLogin` resolves via `loadMcpConfig()` (which reads
 * `process.env`). The login step is launched in-process, so for setup /
 * start / update to point login at the SAME backend/dashboard/endpoint they
 * resolved (which may include `--backend-base-url` etc. overrides), we
 * temporarily seed these into `process.env` around the call.
 *
 * Deliberately does NOT include `MUHAVEN_BROKER_SESSION_KEY` — the session
 * key must NEVER be written to `process.env` (a sibling child of this
 * process could read it via /proc/<pid>/environ on POSIX or OpenProcess on
 * Windows). The key reaches the daemon only via `spawnDaemon`'s explicit
 * child env.
 */
const LOGIN_SEED_ENV_KEYS = [
  'MUHAVEN_BACKEND_URL',
  'MUHAVEN_DASHBOARD_URL',
  'MUHAVEN_BROKER_ENDPOINT',
] as const;

/**
 * Run `fn` with the login-relevant env vars temporarily seeded into
 * `process.env` from `effectiveEnv`, restoring the originals in a `finally`
 * (deleting keys that were originally unset). Shared by `runSetup` and the
 * `start`/`update` orchestrator so the seed/restore dance — and the
 * "never seed the session key" invariant — lives in exactly one place.
 * Restores correctly whether `fn` resolves, rejects, or returns non-zero.
 */
export async function withSeededLoginEnv<T>(
  effectiveEnv: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalValues: Record<string, string | undefined> = {};
  for (const k of LOGIN_SEED_ENV_KEYS) {
    originalValues[k] = process.env[k];
    if (effectiveEnv[k]) process.env[k] = effectiveEnv[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of LOGIN_SEED_ENV_KEYS) {
      if (originalValues[k] === undefined) delete process.env[k];
      else process.env[k] = originalValues[k];
    }
  }
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

/**
 * Host the operator wants `muhaven-broker setup` to wire the MCP server
 * into automatically. Pre-2026-05-17 setup stopped after `login`; the
 * operator then had to write a `.mcp.json` (or equivalent host-config
 * file) by hand. With `--register claude-code` we shell out to the
 * host's own CLI (`claude mcp add-json`) and the JSON ritual goes away.
 *
 * Initial round: `claude-code` only. `claude-desktop` + `cursor` are
 * reserved names — they parse without error but the register step
 * declines to act + prints a clear "not yet implemented" line so the
 * operator can fall back to the per-host snippet in `mcp/install.md`.
 * Adding a host here is a focused diff: implement the registrar +
 * extend `KNOWN_REGISTER_HOSTS`.
 */
export const KNOWN_REGISTER_HOSTS = [
  'claude-code',
  'claude-desktop',
  'cursor',
] as const;
export type RegisterHost = (typeof KNOWN_REGISTER_HOSTS)[number];

/**
 * Scope passed through to `claude mcp add-json --scope <scope>`. Default
 * is `user` because a per-user MuHaven broker is the model — one
 * authenticated daemon per machine, accessible from every project. The
 * operator can downgrade to `project` (writes `.mcp.json` at CWD,
 * git-shared) or to `local` (writes `~/.claude.json` per-project
 * user-only entry — Claude Code's `claude mcp add` default).
 */
export const KNOWN_REGISTER_SCOPES = ['user', 'project', 'local'] as const;
export type RegisterScope = (typeof KNOWN_REGISTER_SCOPES)[number];

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
  /** Host(s) to register the MCP server with after login. Repeatable;
   *  comma-separated values also accepted (e.g. `--register claude-code,cursor`).
   *  Empty array = no host registration (legacy behavior). */
  register: RegisterHost[];
  /** Scope for the `claude mcp add-json` call. Defaults to `user`. */
  registerScope: RegisterScope;
}

export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  let foreground = false;
  let noLaunchBrowser = false;
  let brokerEndpoint: string | undefined;
  let backendBaseUrl: string | undefined;
  let dashboardBaseUrl: string | undefined;
  let skipLogin = false;
  const register: RegisterHost[] = [];
  let registerScope: RegisterScope = 'user';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--foreground' || a === '-f') foreground = true;
    else if (a === '--no-launch-browser') noLaunchBrowser = true;
    else if (a === '--skip-login') skipLogin = true;
    else if (a === '--broker-endpoint' && i + 1 < argv.length) brokerEndpoint = argv[++i];
    else if (a === '--backend-base-url' && i + 1 < argv.length) backendBaseUrl = argv[++i];
    else if (a === '--dashboard-base-url' && i + 1 < argv.length) dashboardBaseUrl = argv[++i];
    else if (a === '--register' && i + 1 < argv.length) {
      // Accept repeated `--register X --register Y` AND a single comma-
      // separated `--register X,Y`. Parsed values go through the
      // KNOWN_REGISTER_HOSTS allowlist so an unknown name fails fast
      // (typo / future-host) instead of silently no-op'ing inside the
      // register step.
      // Non-null assertion: `i + 1 < argv.length` above guarantees the
      // index exists at runtime, but TS narrowing through `++i` doesn't
      // propagate.
      const value = argv[++i]!;
      for (const raw of value.split(',')) {
        const host = raw.trim().toLowerCase();
        if (host === '') continue;
        if (!(KNOWN_REGISTER_HOSTS as readonly string[]).includes(host)) {
          throw new Error(
            `unknown --register host: ${JSON.stringify(host)} (expected one of ${KNOWN_REGISTER_HOSTS.join(', ')})`,
          );
        }
        if (!register.includes(host as RegisterHost)) {
          register.push(host as RegisterHost);
        }
      }
    } else if (a === '--register-scope' && i + 1 < argv.length) {
      // Same non-null assertion rationale as the --register branch.
      const value = argv[++i]!;
      if (!(KNOWN_REGISTER_SCOPES as readonly string[]).includes(value)) {
        throw new Error(
          `unknown --register-scope: ${JSON.stringify(value)} (expected one of ${KNOWN_REGISTER_SCOPES.join(', ')})`,
        );
      }
      registerScope = value as RegisterScope;
    } else throw new Error(`unknown flag: ${a}`);
  }
  return {
    foreground,
    noLaunchBrowser,
    brokerEndpoint,
    backendBaseUrl,
    dashboardBaseUrl,
    skipLogin,
    register,
    registerScope,
  };
}

export interface ShellResult {
  /** Process exit code. 0 = success. */
  readonly exitCode: number;
  /** Captured stdout (utf-8). */
  readonly stdout: string;
  /** Captured stderr (utf-8). */
  readonly stderr: string;
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
  /** Run a child process to completion and capture stdout/stderr. Used by
   *  the host-register step to shell out to `claude mcp add-json`.
   *  Implementations should NOT inherit stdio — capture only — so the
   *  setup transcript stays clean. Returns the exit code + captured
   *  streams; never throws on non-zero exit (caller decides). */
  shellOut(cmd: string, argv: readonly string[]): Promise<ShellResult>;
  /**
   * Wave 5 Option D OPEN-D — interactive session-key prompt deps. Optional:
   * when omitted (or non-TTY), setup falls back to self-mint exactly as
   * before. When the operator has a dashboard-minted key, setup asks
   * "Do you have a session key from the dashboard?" → paste (masked) → use
   * it; otherwise mints a fresh one (the fresh-install path). The
   * `MUHAVEN_BROKER_SESSION_KEY` env var still wins over the prompt for
   * scripted setup runs.
   */
  sessionInput?: SessionPromptDeps;
}

/**
 * Pure: project the effective env down to the subset that should land in
 * the host's `mcpServers.muhaven.env` block. We deliberately exclude
 * `MUHAVEN_BROKER_SESSION_KEY` (lives in the daemon process, NOT the
 * client subprocess the host spawns) and `MUHAVEN_BROKER_ENDPOINT`
 * (default is fine for the client — overriding from the host JSON would
 * desync from the daemon if the operator ever re-ran setup with a
 * different endpoint). Backend / dashboard URLs + keyring choice are
 * the load-bearing trio.
 */
/**
 * 0.2.0 hardening (Security M-1): reject env values containing shell
 * metacharacters before packaging them into the JSON argv we pass to
 * `claude mcp add-json`. Today's three known vars
 * (`MUHAVEN_BACKEND_URL`, `MUHAVEN_DASHBOARD_URL`, `MUHAVEN_KEYRING`)
 * are operator-controlled and the URL ones are URL-validated by
 * `loadMcpConfig` / `--backend-base-url` / `--dashboard-base-url`. But
 * `MUHAVEN_KEYRING` had NO validation and would happily forward a
 * crafted value like `'file" & calc.exe & "'` into the JSON. On
 * Windows, `defaultShellOut` uses `shell: true` which routes argv
 * through `cmd.exe /d /s /c` — `cmd.exe`'s parser differs from
 * `CreateProcess` and metacharacters inside an arg can bite.
 *
 * Sanitization posture: reject (not escape) so the operator notices.
 * Forbidden bytes: `"` / `\\` / `\n` / `\r` / `&` / `|` / `;` /
 * `` ` `` / `<` / `>` / `(` / `)` / `%` / `$`. Anything else passes.
 * Each rejection appends to `warnings` so the caller can surface them
 * to the operator without throwing — a malformed env var shouldn't
 * abort the whole register step.
 */
const SHELL_METACHAR_RE = /["\\\n\r&|;`<>()%$]/;
const SAFE_KEYRING_VALUES = new Set(['file', 'os']);

export interface BuildRegisterEnvResult {
  readonly env: Record<string, string>;
  readonly warnings: readonly string[];
}

export function buildRegisterEnv(
  effectiveEnv: Readonly<Record<string, string>>,
): BuildRegisterEnvResult {
  const env: Record<string, string> = {};
  const warnings: string[] = [];

  function acceptOrWarn(name: string, value: string | undefined): void {
    if (!value) return;
    if (SHELL_METACHAR_RE.test(value)) {
      warnings.push(
        `${name} contains shell metacharacters and was dropped from the host config — set a clean value in your env if you need a non-default.`,
      );
      return;
    }
    env[name] = value;
  }

  acceptOrWarn('MUHAVEN_BACKEND_URL', effectiveEnv.MUHAVEN_BACKEND_URL);
  acceptOrWarn('MUHAVEN_DASHBOARD_URL', effectiveEnv.MUHAVEN_DASHBOARD_URL);

  // MUHAVEN_KEYRING is the highest-risk field — pre-2026-05-18 it had
  // no validation. Now: must be one of `file` / `os`. Anything else
  // gets dropped + a warning so the host config doesn't carry a
  // crafted value into `cmd.exe`'s parser on Windows.
  const keyring = effectiveEnv.MUHAVEN_KEYRING;
  if (keyring) {
    if (!SAFE_KEYRING_VALUES.has(keyring)) {
      warnings.push(
        `MUHAVEN_KEYRING="${keyring}" is not one of the recognized values (file, os) — dropped from the host config.`,
      );
    } else {
      env.MUHAVEN_KEYRING = keyring;
    }
  }

  return { env, warnings };
}

/**
 * Pure: build the JSON config payload that gets passed to
 * `claude mcp add-json <name> <json>`. Stable key order (type → command
 * → env) so the serialised form is deterministic across runs — easier
 * to diff if the operator inspects `.mcp.json` / `~/.claude.json`
 * afterwards.
 */
export function buildClaudeMcpRegisterJson(
  registerEnv: Readonly<Record<string, string>>,
): string {
  const payload: Record<string, unknown> = {
    type: 'stdio',
    command: 'muhaven-mcp',
  };
  if (Object.keys(registerEnv).length > 0) {
    payload.env = registerEnv;
  }
  return JSON.stringify(payload);
}

/**
 * Pure: build the argv for `claude mcp add-json muhaven '<json>' --scope <scope>`.
 * Exposed so tests can assert the argv shape without spawning a child.
 */
export function buildClaudeMcpAddJsonArgv(
  serverName: string,
  json: string,
  scope: RegisterScope,
): string[] {
  return ['mcp', 'add-json', serverName, json, '--scope', scope];
}

/** Pure: argv for the idempotent `claude mcp remove <name>` pre-step. */
export function buildClaudeMcpRemoveArgv(
  serverName: string,
  scope: RegisterScope,
): string[] {
  return ['mcp', 'remove', serverName, '--scope', scope];
}

export interface RegisterHostOptions {
  readonly host: RegisterHost;
  readonly scope: RegisterScope;
  readonly serverName: string;
  readonly registerEnv: Readonly<Record<string, string>>;
}

export type RegisterHostOutcome =
  /** Successfully wired into the host. `warnings` carries non-fatal
   *  notes the operator should see (e.g. `claude mcp remove` returned
   *  an unexpected non-found error before the add succeeded — useful
   *  forensic info if a duplicate ever appears). */
  | {
      readonly status: 'registered';
      readonly host: RegisterHost;
      readonly scope: RegisterScope;
      readonly warnings?: readonly string[];
    }
  /** Host's CLI wasn't found on PATH — register skipped. */
  | { readonly status: 'cli_missing'; readonly host: RegisterHost; readonly cmd: string }
  /** Host is recognized but no registrar is implemented yet. */
  | { readonly status: 'not_implemented'; readonly host: RegisterHost }
  /** Register step errored — surfaced as a warning, doesn't unwind setup. */
  | { readonly status: 'failed'; readonly host: RegisterHost; readonly reason: string };

/**
 * Match the stderr shape of `claude mcp remove` when the named server
 * isn't registered — the only failure mode we silently swallow. Anything
 * else (perm denied, lockfile, parse error) surfaces as a warning on
 * the successful-add path so a future operator can diagnose split-brain
 * configs without re-running setup blind.
 *
 * Patterns cover the wording variations Claude Code has shipped across
 * versions ("not found", "does not exist", "no server named X").
 * Conservative — if we don't match, we WARN; we never escalate to a
 * failure for the remove step alone (the add step is the boundary).
 */
const CLAUDE_REMOVE_NOT_FOUND_RE = /(no.*server|not found|does not exist|no MCP server)/i;

/**
 * Best-effort: wire the MCP server into one host. The contract:
 *
 *   - If the host's CLI isn't on PATH → 'cli_missing'. Operator falls
 *     back to the per-host JSON snippet in `mcp/install.md`.
 *   - If the host's registrar isn't implemented yet → 'not_implemented'.
 *   - Otherwise, run the host's registration command(s) and surface the
 *     outcome.
 *
 * Idempotency: for `claude-code`, the orchestrator runs `claude mcp remove
 * <name> --scope <scope>` first (ignoring failure — the entry may not
 * exist) so a re-run of setup doesn't trip Claude Code's "server already
 * exists" error. The remove + add pair is the recommended pattern per
 * claude-code docs (no native --force on `mcp add`).
 *
 * Never throws — every failure mode resolves to a structured outcome.
 * Setup's exit code stays 0 even when register fails: the broker + JWT
 * are already in place, and an operator who explicitly opted into
 * `--register` can re-run that step in isolation later.
 */
export async function registerWithHost(
  deps: Pick<SetupDeps, 'shellOut'>,
  options: RegisterHostOptions,
): Promise<RegisterHostOutcome> {
  if (options.host === 'claude-code') {
    return registerWithClaudeCode(deps, options);
  }
  // Reserved hosts that parse cleanly today but don't have a registrar yet.
  // `claude-desktop` would need to write the JSON to
  // `~/Library/Application Support/Claude/claude_desktop_config.json` (mac)
  // or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). `cursor`
  // would write `~/.cursor/mcp.json`. Both are tracked as Wave 5 hosts —
  // file-edit registrars need merge-then-write semantics + dedicated tests
  // beyond the scope of the claude-code-first round.
  return { status: 'not_implemented', host: options.host };
}

async function registerWithClaudeCode(
  deps: Pick<SetupDeps, 'shellOut'>,
  options: RegisterHostOptions,
): Promise<RegisterHostOutcome> {
  // Probe for `claude` on PATH. We use `--version` instead of `--help`
  // because (a) it short-circuits, (b) it returns exit 0 on every
  // claude-code release since the bin existed. Falls into 'cli_missing'
  // if the binary isn't on PATH OR errors out for some other reason
  // (PATH-locked environment, permissions). Either way the operator can
  // still copy the JSON snippet from the docs.
  let probe: ShellResult;
  try {
    probe = await deps.shellOut('claude', ['--version']);
  } catch (err) {
    return {
      status: 'cli_missing',
      host: options.host,
      cmd: `claude --version (${(err as Error).message})`,
    };
  }
  if (probe.exitCode !== 0) {
    return {
      status: 'cli_missing',
      host: options.host,
      cmd: 'claude --version',
    };
  }

  // Idempotent remove. Pre-2026-05-18 swallowed the exit code wholesale,
  // which masked a class of operator-confusing failure modes (Code
  // Reviewer H2 / Security M-3): if the remove returned non-zero for a
  // reason OTHER than "no such server" (perm-locked scope, stale
  // ~/.claude.json lockfile, ENOENT on the config file), the subsequent
  // add could either fail with the same root cause OR succeed in a
  // different shadow scope leaving two `muhaven` entries on disk.
  // Now we capture the exit code + stderr and pass forensic info up
  // through the outcome's `warnings` field so the operator sees the
  // remove anomaly even when the add succeeds.
  const warnings: string[] = [];
  let removeResult: ShellResult | null = null;
  try {
    removeResult = await deps.shellOut(
      'claude',
      buildClaudeMcpRemoveArgv(options.serverName, options.scope),
    );
  } catch (err) {
    warnings.push(
      `claude mcp remove threw before exit: ${(err as Error).message}. ` +
        `If the add below succeeds but you see duplicates in ~/.claude.json, ` +
        `inspect file permissions.`,
    );
  }
  if (removeResult && removeResult.exitCode !== 0) {
    const stderr = removeResult.stderr.trim();
    const stdout = removeResult.stdout.trim();
    const combined = [stderr, stdout].filter((s) => s.length > 0).join(' | ');
    if (!CLAUDE_REMOVE_NOT_FOUND_RE.test(combined)) {
      warnings.push(
        `claude mcp remove returned exit ${removeResult.exitCode}: ${combined || '(no stderr)'}. ` +
          `Continuing with add. If you see duplicate muhaven entries afterwards, ` +
          `inspect ~/.claude.json or the project's .mcp.json manually.`,
      );
    }
    // else: "not found" / "does not exist" — the expected first-run
    // case. Silently swallow.
  }

  const json = buildClaudeMcpRegisterJson(options.registerEnv);
  const addArgv = buildClaudeMcpAddJsonArgv(options.serverName, json, options.scope);
  let add: ShellResult;
  try {
    add = await deps.shellOut('claude', addArgv);
  } catch (err) {
    return {
      status: 'failed',
      host: options.host,
      reason: `spawn claude failed: ${(err as Error).message}`,
    };
  }
  if (add.exitCode !== 0) {
    // Combine stderr + stdout for the operator-facing reason — `claude
    // mcp add-json` writes some failure detail to each stream depending
    // on version. Also fold in any remove warnings so the operator sees
    // the full forensic trail when diagnosing a failed add.
    const addReason = [add.stderr, add.stdout]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' | ') || `exit ${add.exitCode}`;
    const reason = warnings.length > 0
      ? `${addReason} (preceding remove also surfaced: ${warnings.join('; ')})`
      : addReason;
    return { status: 'failed', host: options.host, reason };
  }
  return warnings.length > 0
    ? { status: 'registered', host: options.host, scope: options.scope, warnings }
    : { status: 'registered', host: options.host, scope: options.scope };
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
        '                            [--dashboard-base-url URL]\n' +
        '                            [--register HOST[,HOST...]] [--register-scope user|project|local]',
    );
    return 2;
  }

  // Validate URL + endpoint flags BEFORE spawning anything. A bad
  // `--backend-base-url` value would otherwise ship the JWT to an attacker
  // host via the device-flow ceremony.
  if (flags.backendBaseUrl) {
    const err = validateHttpUrlFlag('--backend-base-url', flags.backendBaseUrl);
    if (err) {
      deps.printErr(`error: ${err}`);
      return 2;
    }
  }
  if (flags.dashboardBaseUrl) {
    const err = validateHttpUrlFlag('--dashboard-base-url', flags.dashboardBaseUrl);
    if (err) {
      deps.printErr(`error: ${err}`);
      return 2;
    }
  }
  if (flags.brokerEndpoint) {
    const err = validateBrokerEndpointFlag(flags.brokerEndpoint, deps.platformId);
    if (err) {
      deps.printErr(`error: ${err}`);
      return 2;
    }
  }

  // 1. Env defaults. Build an effective-env snapshot locally INSTEAD of
  // mutating process.env — that mutation would leak the session key (and
  // backend URLs) into any subsequent process the operator's shell
  // spawns. Security review 2026-05-17.
  const overrides = applyEnvDefaults({
    env: deps.env,
    platformId: deps.platformId,
    osRelease: deps.osRelease,
  });
  const effectiveEnv: Record<string, string> = {};
  // Seed with caller-provided env (only string values; node typings allow
  // undefined which loadMcpConfig handles, but our local map shouldn't carry
  // them).
  for (const [k, v] of Object.entries(deps.env)) {
    if (typeof v === 'string') effectiveEnv[k] = v;
  }
  // Apply defaults.
  for (const [k, v] of Object.entries(overrides.toSet)) {
    effectiveEnv[k] = v;
  }
  // Explicit CLI flag overrides win over auto-default values.
  if (flags.brokerEndpoint) effectiveEnv.MUHAVEN_BROKER_ENDPOINT = flags.brokerEndpoint;
  if (flags.backendBaseUrl) effectiveEnv.MUHAVEN_BACKEND_URL = flags.backendBaseUrl;
  if (flags.dashboardBaseUrl) effectiveEnv.MUHAVEN_DASHBOARD_URL = flags.dashboardBaseUrl;

  // Print env state. Names only for preserved vars (the value belongs to the
  // operator — don't echo it into shell history / CI logs). Values shown for
  // defaulted vars because *we* chose them and they're public.
  for (const name of overrides.preserved) {
    deps.print(`Env preserved: ${name} (set in your shell)`);
  }
  for (const [k, v] of Object.entries(overrides.toSet)) {
    deps.print(`Env defaulted: ${k}=${v}`);
  }

  // 2. Session key. Self-mint if not provided. The minted value is
  // session-scoped (this process tree); the bound JWT is what governs
  // access, so the key itself is single-use authorization material.
  // Keep in a local var — NEVER mutate process.env, or any later
  // child of this shell sees the key in its env (POSIX
  // /proc/<pid>/environ; Windows OpenProcess).
  let sessionKey = effectiveEnv.MUHAVEN_BROKER_SESSION_KEY;
  let mintedKey = false;
  if (sessionKey && sessionKey.length > 0) {
    // Scripted / power-user path: the env var wins over the prompt.
    deps.print('Session key: using MUHAVEN_BROKER_SESSION_KEY from env.');
  } else {
    // No env key — OPEN-D: ask interactively whether the operator has a
    // dashboard-minted key (paste it) or wants a fresh self-mint. Non-TTY
    // / no prompt deps → self-mint (legacy fresh-install behavior).
    const sessionInput: SessionPromptDeps = deps.sessionInput ?? {
      isTty: false,
      readStdinAll: async () => '',
      promptYesNo: async () => false,
      promptSecret: async () => '',
    };
    const resolution = await resolveSessionKey({
      sessionFlag: undefined,
      policy: 'mint-fallback',
      deps: sessionInput,
    });
    if (resolution.kind === 'error') {
      deps.printErr(`error: ${resolution.message}`);
      return 2;
    }
    if (resolution.kind === 'key') {
      sessionKey = resolution.key;
      deps.print('Session key: using the pasted dashboard key.');
    } else {
      sessionKey = deps.mintSessionKey();
      mintedKey = true;
      deps.print('Session key: minted fresh (secp256k1, ephemeral to this daemon).');
    }
  }
  effectiveEnv.MUHAVEN_BROKER_SESSION_KEY = sessionKey;

  // 3. Foreground mode short-circuits everything else. The foreground
  // daemon reads from process.env (it's a separate call into
  // runBrokerDaemonCli), so we DO need to mutate here — but bracket the
  // mutation with a try/finally that restores the original values when
  // the daemon exits.
  if (flags.foreground) {
    deps.print('Foreground mode — running daemon attached to this shell. Ctrl-C to stop.');
    const restorationKeys = [
      ...Object.keys(overrides.toSet),
      'MUHAVEN_BROKER_SESSION_KEY',
      ...(flags.brokerEndpoint ? ['MUHAVEN_BROKER_ENDPOINT'] : []),
      ...(flags.backendBaseUrl ? ['MUHAVEN_BACKEND_URL'] : []),
      ...(flags.dashboardBaseUrl ? ['MUHAVEN_DASHBOARD_URL'] : []),
    ];
    const originalValues: Record<string, string | undefined> = {};
    for (const k of restorationKeys) {
      originalValues[k] = process.env[k];
      process.env[k] = effectiveEnv[k];
    }
    try {
      await deps.runForegroundDaemon();
    } finally {
      // Restore env on exit so a re-run of setup doesn't inherit stale
      // values, and so the operator's shell env stays clean.
      for (const k of restorationKeys) {
        if (originalValues[k] === undefined) delete process.env[k];
        else process.env[k] = originalValues[k];
      }
    }
    return 0;
  }

  // 4. Probe broker. loadMcpConfig accepts an explicit env — we pass our
  // local effectiveEnv so we don't depend on process.env mutation.
  const config = loadMcpConfig(effectiveEnv);
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
        // Explicit env for the spawned daemon. Includes every var that the
        // daemon's loadBrokerConfig will read, sourced from our resolved
        // effectiveEnv (NOT from process.env). spawnDaemon will sanitize
        // process.env-inherited values further (strips NODE_OPTIONS etc.).
        ...overrides.toSet,
        MUHAVEN_BROKER_ENDPOINT: config.brokerEndpoint,
        MUHAVEN_BACKEND_URL: effectiveEnv.MUHAVEN_BACKEND_URL!,
        MUHAVEN_DASHBOARD_URL: effectiveEnv.MUHAVEN_DASHBOARD_URL!,
        MUHAVEN_BROKER_SESSION_KEY: sessionKey,
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

  // 5. Login (unless --skip-login or already authenticated). The login
  // step needs env to find the right backend — temporarily seed process.env
  // for the call duration, then restore (login internally reads
  // process.env via loadMcpConfig).
  const needsLogin = !flags.skipLogin && !(helloProbe && helloProbe.hasJwt);
  if (flags.skipLogin) {
    deps.print('Login: skipped per --skip-login.');
  } else if (helloProbe && helloProbe.hasJwt) {
    deps.print('Login: skipped — JWT already in keystore.');
  }

  if (needsLogin) {
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
    // login reads loadMcpConfig() which defaults to process.env. Seed +
    // restore around the call so we don't pollute the operator's shell
    // (shared helper — keeps the dance + the "never seed the session key"
    // invariant in one place).
    const code = await withSeededLoginEnv(effectiveEnv, () => deps.runLogin(loginArgv));
    if (code !== 0) {
      deps.printErr(
        'Setup: login step failed — daemon is still running, re-run `muhaven-broker login` to retry.',
      );
      if (daemonPid !== null) {
        const killCmd =
          deps.platformId === 'win32'
            ? `Stop-Process -Id ${daemonPid}`
            : `kill ${daemonPid}`;
        deps.printErr(`  (daemon PID ${daemonPid}; stop with: ${killCmd})`);
      }
      return code;
    }
  }

  // 5b. Host register. Opt-in (`--register HOST[,HOST...]`). Best-effort:
  // a registrar failure prints a warning + the per-host fallback hint
  // but does NOT change the setup exit code, because the broker + JWT
  // (the load-bearing artifacts) are already in place. An operator who
  // hit a transient `claude` outage can re-run the step in isolation.
  const registerOutcomes: RegisterHostOutcome[] = [];
  if (flags.register.length > 0) {
    const { env: registerEnv, warnings: envWarnings } = buildRegisterEnv(effectiveEnv);
    // Surface env-sanitization warnings BEFORE the register step so the
    // operator sees them even on a CLI-missing outcome that prints
    // nothing else. Security M-1 hardening: MUHAVEN_KEYRING / URL env
    // values containing shell metacharacters are dropped rather than
    // packaged into the JSON argv.
    for (const w of envWarnings) {
      deps.printErr(`Host register env: ${w}`);
    }
    for (const host of flags.register) {
      const outcome = await registerWithHost(deps, {
        host,
        scope: flags.registerScope,
        serverName: 'muhaven',
        registerEnv,
      });
      registerOutcomes.push(outcome);
      switch (outcome.status) {
        case 'registered':
          deps.print(
            `Host register: ${outcome.host} wired (scope: ${outcome.scope}). ` +
              `Restart the host to pick up the new MCP server.`,
          );
          // Surface forensic warnings from `claude mcp remove` anomalies
          // even though the overall register succeeded — closes the
          // split-brain operator-confusion failure mode (Code Reviewer
          // H2 / Security M-3).
          if (outcome.warnings) {
            for (const w of outcome.warnings) {
              deps.printErr(`Host register warning: ${w}`);
            }
          }
          break;
        case 'cli_missing':
          deps.printErr(
            `Host register: ${outcome.host} CLI not found on PATH (${outcome.cmd}). ` +
              `Install Claude Code and re-run \`muhaven-broker setup --register ${outcome.host}\`, ` +
              `or copy the JSON snippet from https://docs.muhaven.app/mcp/install#step-3-wire-your-host`,
          );
          break;
        case 'not_implemented':
          deps.printErr(
            `Host register: ${outcome.host} registrar not implemented yet (Wave 5). ` +
              `Use the JSON snippet from https://docs.muhaven.app/mcp/install#step-3-wire-your-host for now.`,
          );
          break;
        case 'failed':
          deps.printErr(
            `Host register: ${outcome.host} failed — ${outcome.reason}. ` +
              `Setup continues; re-run \`muhaven-broker setup --register ${outcome.host}\` after fixing.`,
          );
          break;
      }
    }
  }

  // 6. Closing summary. Always print the endpoint (so the idempotent
  // already-ready path still surfaces where the daemon lives). PID + stop
  // command are scoped to the spawn path because we don't know the PID
  // of a pre-existing daemon.
  deps.print('');
  deps.print('================================');
  deps.print('Setup complete.');
  if (daemonPid !== null) {
    deps.print(`  Daemon PID : ${daemonPid}`);
    const killCmd =
      deps.platformId === 'win32'
        ? `Stop-Process -Id ${daemonPid}`
        : `kill ${daemonPid}`;
    deps.print(`  Stop daemon: ${killCmd}`);
  } else {
    deps.print('  Daemon     : already running');
  }
  deps.print(`  Endpoint   : ${config.brokerEndpoint}`);
  deps.print('  Sign out   : muhaven-broker logout   (clears JWT, leaves daemon running)');
  if (mintedKey) {
    deps.print('  Session key: ephemeral — minted by setup, lives only in the daemon process.');
  }
  deps.print('================================');
  return 0;
}
