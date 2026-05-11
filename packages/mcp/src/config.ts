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
  /** 0x-prefixed 32-byte private key. Sensitive — keychain-backed. */
  sessionKeyHex: `0x${string}`;
  /** Maximum payload bytes accepted from the IPC peer. */
  maxRequestBytes: number;
  /** Per-request hard timeout (ms). */
  requestTimeoutMs: number;
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

function trimTrailingSlash(s: string): string {
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
  const sessionKeyHex = env.MUHAVEN_BROKER_SESSION_KEY;
  if (!sessionKeyHex) {
    throw new Error(
      'MUHAVEN_BROKER_SESSION_KEY is required (0x-prefixed 32-byte hex). Mint a session key via the dashboard policy-template install flow.',
    );
  }
  if (!PRIVKEY_HEX_RE.test(sessionKeyHex)) {
    throw new Error('MUHAVEN_BROKER_SESSION_KEY must be a 0x-prefixed 32-byte hex string');
  }

  const endpoint = env.MUHAVEN_BROKER_ENDPOINT ?? defaultBrokerEndpoint();
  const maxRequestBytes = readEnvInt('MUHAVEN_BROKER_MAX_BYTES', DEFAULT_BROKER_MAX_BYTES, env);
  const requestTimeoutMs = readEnvInt('MUHAVEN_BROKER_TIMEOUT_MS', DEFAULT_BROKER_TIMEOUT_MS, env);

  return {
    endpoint,
    sessionKeyHex: sessionKeyHex as `0x${string}`,
    maxRequestBytes,
    requestTimeoutMs,
  };
}
