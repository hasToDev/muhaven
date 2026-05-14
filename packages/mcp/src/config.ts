/**
 * Runtime configuration sourced from env vars declared in `manifest.json`.
 *
 * MCPB hosts (Claude Desktop, Cursor, Claude Code) inject these via the
 * STDIO subprocess environment. Per ADR-3 the **JWT itself is no longer
 * an env var** — it is acquired via the device-flow ceremony and lives
 * in the broker-managed keystore. The MCP server fetches it from the
 * broker on each tool call (with a brief in-process cache).
 *
 * Validation is intentionally strict: we fail to start rather than
 * launch with a half-configured signing path. The error messages name
 * the env var so an MCPB user can fix their host config without reading
 * code.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface McpRuntimeConfig {
  /** MuHaven backend base URL (no trailing slash). e.g. https://api.muhaven.app */
  backendBaseUrl: string;
  /** Origin of the MuHaven dashboard (used in AUTH_REQUIRED messages). */
  dashboardBaseUrl: string;
  /** Path / endpoint of the muhaven-broker IPC. */
  brokerEndpoint: string;
  /** When true, the position.* and policy.* toolsets are not registered. */
  readOnly: boolean;
  /** Soft timeout (ms) for backend HTTP calls. Default 15s. */
  requestTimeoutMs: number;
  /** Soft timeout (ms) for broker IPC calls. Default 5s. */
  brokerTimeoutMs: number;
  /** Allowed backend hostnames for URL guard. Derived from baseUrl. */
  allowedBackendHosts: readonly string[];
  /** In-process JWT cache TTL in seconds. Default 30. */
  jwtCacheTtlSec: number;
}

export interface BrokerRuntimeConfig {
  /** Endpoint to bind: socket path on POSIX, named pipe name on Windows. */
  endpoint: string;
  /**
   * 0x-prefixed 32-byte private key, OR undefined for read-only posture.
   * When undefined, the daemon still serves `hello` + the JWT verbs
   * (so MCP read tools work), but any `sign_hash` request returns
   * `session_key_unavailable`. Sensitive when present — keychain-backed.
   */
  sessionKeyHex: `0x${string}` | undefined;
  /** Maximum payload bytes accepted from the IPC peer. */
  maxRequestBytes: number;
  /** Per-request hard timeout (ms). */
  requestTimeoutMs: number;
  /**
   * Effective backend URL the daemon read from its own env at boot. Used
   * to populate `hello.effectiveConfig` so a `muhaven-broker login
   * --from-daemon` call uses the same URL as the daemon, even when the
   * login CLI was launched from a different shell env.
   */
  backendBaseUrl: string;
  /** Effective dashboard URL paired with backendBaseUrl. */
  dashboardBaseUrl: string;
}

const DEFAULT_BACKEND_URL = 'https://api.muhaven.app';
const DEFAULT_DASHBOARD_URL = 'https://muhaven.app';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BROKER_TIMEOUT_MS = 5_000;
const DEFAULT_BROKER_MAX_BYTES = 64 * 1024;
const DEFAULT_JWT_CACHE_TTL_SEC = 30;

/**
 * Compute the default IPC endpoint for the broker. POSIX: a socket file
 * inside the user's home dir. Windows: a per-user named pipe.
 *
 * Both endpoints are bound to the local user only — never exposed over
 * TCP. The TCP transport ban is a hard invariant of the broker.
 */
export function defaultBrokerEndpoint(): string {
  if (platform() === 'win32') {
    const user = process.env.USERNAME ?? 'default';
    const sanitized = user.replace(/[^A-Za-z0-9_-]/g, '_');
    return `\\\\.\\pipe\\muhaven-broker-${sanitized}`;
  }
  return join(homedir(), '.muhaven', 'broker.sock');
}

function readEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  return value;
}

function readEnvBool(name: string, defaultValue: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = readEnv(name, env);
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function readEnvInt(name: string, defaultValue: number, env: NodeJS.ProcessEnv): number {
  const raw = readEnv(name, env);
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

function deriveAllowedHosts(baseUrl: string): readonly string[] {
  try {
    const u = new URL(baseUrl);
    return [u.host];
  } catch {
    throw new Error(`MUHAVEN_BACKEND_URL is not a valid URL (got "${baseUrl}")`);
  }
}

export function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpRuntimeConfig {
  const backendBaseUrl = trimTrailingSlash(env.MUHAVEN_BACKEND_URL ?? DEFAULT_BACKEND_URL);
  const dashboardBaseUrl = trimTrailingSlash(env.MUHAVEN_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL);
  const brokerEndpoint = env.MUHAVEN_BROKER_ENDPOINT ?? defaultBrokerEndpoint();
  const readOnly = readEnvBool('MUHAVEN_READ_ONLY', false, env);
  const requestTimeoutMs = readEnvInt('MUHAVEN_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, env);
  const brokerTimeoutMs = readEnvInt('MUHAVEN_BROKER_TIMEOUT_MS', DEFAULT_BROKER_TIMEOUT_MS, env);
  const jwtCacheTtlSec = readEnvInt('MUHAVEN_JWT_CACHE_TTL_SEC', DEFAULT_JWT_CACHE_TTL_SEC, env);

  return {
    backendBaseUrl,
    dashboardBaseUrl,
    brokerEndpoint,
    readOnly,
    requestTimeoutMs,
    brokerTimeoutMs,
    allowedBackendHosts: deriveAllowedHosts(backendBaseUrl),
    jwtCacheTtlSec,
  };
}

const PRIVKEY_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerRuntimeConfig {
  // Lazy session-key posture: the daemon can boot WITHOUT a session key
  // and still serve `hello` + JWT verbs (so MCP read tools work). Any
  // `sign_hash` request then returns `session_key_unavailable` instead of
  // the daemon dying at startup. Format is still validated when the value
  // is present so a typo doesn't masquerade as the read-only posture.
  // Closes §3e⁶ F-broker-session-key-required-for-reads.
  const sessionKeyHexRaw = env.MUHAVEN_BROKER_SESSION_KEY;
  let sessionKeyHex: `0x${string}` | undefined;
  if (sessionKeyHexRaw && sessionKeyHexRaw.length > 0) {
    if (!PRIVKEY_HEX_RE.test(sessionKeyHexRaw)) {
      throw new Error('MUHAVEN_BROKER_SESSION_KEY must be a 0x-prefixed 32-byte hex string');
    }
    sessionKeyHex = sessionKeyHexRaw as `0x${string}`;
  }

  const endpoint = env.MUHAVEN_BROKER_ENDPOINT ?? defaultBrokerEndpoint();
  const maxRequestBytes = readEnvInt('MUHAVEN_BROKER_MAX_BYTES', DEFAULT_BROKER_MAX_BYTES, env);
  const requestTimeoutMs = readEnvInt('MUHAVEN_BROKER_TIMEOUT_MS', DEFAULT_BROKER_TIMEOUT_MS, env);

  // Resolve effective backend + dashboard URLs from the daemon's OWN env
  // (rather than punning loadMcpConfig). Surfaced via `hello.effectiveConfig`
  // so a later `muhaven-broker login --from-daemon` stays in lockstep with
  // the daemon's view even when the CLI was invoked from a different shell.
  const backendBaseUrl = trimTrailingSlash(env.MUHAVEN_BACKEND_URL ?? DEFAULT_BACKEND_URL);
  const dashboardBaseUrl = trimTrailingSlash(env.MUHAVEN_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL);

  return {
    endpoint,
    sessionKeyHex,
    maxRequestBytes,
    requestTimeoutMs,
    backendBaseUrl,
    dashboardBaseUrl,
  };
}
