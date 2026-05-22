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
  /**
   * Wave 5 Path D Slice 1 (Commit 3) — ERC-4337 v0.7 bundler JSON-RPC URL.
   * Undefined → Path D autonomous-buy mode disabled (position tools fall
   * back to Path C deep-link). Validated via the same https-or-loopback
   * rule as backend/dashboard URLs.
   */
  bundlerUrl: string | undefined;
  /** Path D request timeout for bundler RPC calls. Default 20s
   *  (slightly higher than backend default to absorb head-of-line block
   *  delays). */
  bundlerTimeoutMs: number;
  /** Wave 5 Path D — expected chain id (Arb Sepolia = 421614). Sourced
   *  from env so a future mainnet rollout doesn't require a code change.
   *  Default 421614. */
  chainId: number;
  /**
   * Wave 5 Path D Slice 1 (Commit 3.5) — the
   * `MuHavenSubscription.purchase` target the autonomous-buy UserOp
   * calls into. Undefined → Path D's UserOp build path is disabled
   * (handler falls back to Path C with reason
   * `subscription_address_unset`). Lives in env (NOT a contract
   * deployment lookup) so the MCP package stays free of the deployment
   * JSON files. Source of truth: `deployments/arb-sepolia-v2.json`
   * (prod) / `deployments/arb-sepolia-v2.staging.json` (stage) →
   * `subscription` field.
   */
  subscriptionAddress: `0x${string}` | undefined;
  /**
   * Wave 5 Path D Slice 1 (Commit 3.5) — ERC-4337 EntryPoint v0.7
   * address. Defaults to the canonical deployment
   * `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (same on every EVM
   * chain). Operators on a future EntryPoint rotation override via
   * `MUHAVEN_ENTRY_POINT`.
   */
  entryPointAddress: `0x${string}`;
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
/** Wave 5 Path D — bundler RPC timeout. Higher than backend (15s) because
 *  bundler `eth_sendUserOperation` performs simulation before accepting
 *  the userOp, which can stall under network load. 20s is the ZeroDev
 *  reference default. */
const DEFAULT_BUNDLER_TIMEOUT_MS = 20_000;
/** Arbitrum Sepolia chain id — the only network MuHaven currently
 *  targets. Operators on a different chain MUST override
 *  MUHAVEN_CHAIN_ID alongside MUHAVEN_BUNDLER_URL. */
const DEFAULT_CHAIN_ID = 421614;
/** ERC-4337 EntryPoint v0.7 canonical address. Same on every EVM chain. */
const DEFAULT_ENTRY_POINT_ADDRESS =
  '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as `0x${string}`;
const ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;

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

/**
 * Validate a public-URL env var (backend / dashboard). Returns null on
 * valid, an error string on invalid. Mirrors the shape of
 * `validateHttpUrlFlag` in `broker/setup.ts` — same logic, applied at
 * boot-time config load so a misconfigured env can't ship attacker-
 * controlled URLs into position deep-links.
 *
 * Rules:
 *  - Must parse cleanly as a URL.
 *  - Protocol must be `https:` OR `http:` to a loopback host
 *    (localhost / 127.0.0.1 / [::1]) — dev carve-out only.
 *  - Refuses `javascript:`, `file:`, `data:`, plain `http:` to non-loopback.
 *
 * Closes Security review M-2: a malicious sibling npm dep or attacker
 * with write access to `~/.claude.json` could otherwise inject
 * `MUHAVEN_DASHBOARD_URL=https://muhaven-app.com` (typosquat) and have
 * every position deep-link route the user to a phishing clone. The
 * RP-ID binding on `muhaven.app` prevents WebAuthn credential reuse,
 * but the clone can phish for OAuth secondaries / recovery phrases /
 * fresh passkey re-registration ceremonies.
 */
export function validatePublicUrlEnv(name: string, value: string): string | null {
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
    return `${name} must use https:// (got http:// to ${host} — refusing to route MCP deep-links over cleartext to a non-loopback host)`;
  }
  return `${name} must use https:// (got ${parsed.protocol})`;
}

/**
 * Resolve + validate a public URL env value, applying the trim-trailing-
 * slash convention and hard-failing at boot when the value violates the
 * https-or-loopback rule (Security M-2). Wraps `validatePublicUrlEnv`
 * so every loader path (loadMcpConfig + loadBrokerConfig) uses the
 * same checks without duplicating the throw site.
 */
function resolvePublicUrlEnv(
  name: string,
  rawValue: string | undefined,
  defaultValue: string,
): string {
  const value = rawValue ?? defaultValue;
  const err = validatePublicUrlEnv(name, value);
  if (err) throw new Error(err);
  return trimTrailingSlash(value);
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpRuntimeConfig {
  const backendBaseUrl = resolvePublicUrlEnv(
    'MUHAVEN_BACKEND_URL',
    env.MUHAVEN_BACKEND_URL,
    DEFAULT_BACKEND_URL,
  );
  const dashboardBaseUrl = resolvePublicUrlEnv(
    'MUHAVEN_DASHBOARD_URL',
    env.MUHAVEN_DASHBOARD_URL,
    DEFAULT_DASHBOARD_URL,
  );
  const brokerEndpoint = env.MUHAVEN_BROKER_ENDPOINT ?? defaultBrokerEndpoint();
  const readOnly = readEnvBool('MUHAVEN_READ_ONLY', false, env);
  const requestTimeoutMs = readEnvInt('MUHAVEN_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, env);
  const brokerTimeoutMs = readEnvInt('MUHAVEN_BROKER_TIMEOUT_MS', DEFAULT_BROKER_TIMEOUT_MS, env);
  const jwtCacheTtlSec = readEnvInt('MUHAVEN_JWT_CACHE_TTL_SEC', DEFAULT_JWT_CACHE_TTL_SEC, env);
  // Wave 5 Path D — bundler URL is OPTIONAL. Unset → Path D disabled,
  // position tools fall back to Path C deep-link (existing behaviour).
  // Set → validated by the same https-or-loopback rule as the other
  // public URLs (Security M-2 generalization).
  const bundlerUrlRaw = readEnv('MUHAVEN_BUNDLER_URL', env);
  let bundlerUrl: string | undefined;
  if (bundlerUrlRaw !== undefined) {
    const validationErr = validatePublicUrlEnv('MUHAVEN_BUNDLER_URL', bundlerUrlRaw);
    if (validationErr) throw new Error(validationErr);
    bundlerUrl = trimTrailingSlash(bundlerUrlRaw);
  }
  const bundlerTimeoutMs = readEnvInt('MUHAVEN_BUNDLER_TIMEOUT_MS', DEFAULT_BUNDLER_TIMEOUT_MS, env);
  const chainId = readEnvInt('MUHAVEN_CHAIN_ID', DEFAULT_CHAIN_ID, env);

  // Wave 5 Path D Slice 1 (Commit 3.5) — optional subscription
  // contract address. Undefined → Path D's UserOp build path stays
  // dormant + position tools fall back to Path C deep-link with a
  // structured reason. Defensive shape check so a typo doesn't
  // silently mis-route the autonomous buy.
  const subscriptionAddressRaw = readEnv('MUHAVEN_SUBSCRIPTION_ADDRESS', env);
  let subscriptionAddress: `0x${string}` | undefined;
  if (subscriptionAddressRaw !== undefined) {
    if (!ADDRESS_HEX_RE.test(subscriptionAddressRaw)) {
      throw new Error(
        `MUHAVEN_SUBSCRIPTION_ADDRESS must be a 0x-prefixed 20-byte hex string (got ${JSON.stringify(subscriptionAddressRaw)})`,
      );
    }
    subscriptionAddress = subscriptionAddressRaw.toLowerCase() as `0x${string}`;
  }

  // ERC-4337 EntryPoint v0.7 address. Defaults to the canonical
  // deployment; operators on a future EntryPoint rotation override via
  // `MUHAVEN_ENTRY_POINT`.
  const entryPointAddressRaw = readEnv('MUHAVEN_ENTRY_POINT', env);
  let entryPointAddress: `0x${string}` = DEFAULT_ENTRY_POINT_ADDRESS;
  if (entryPointAddressRaw !== undefined) {
    if (!ADDRESS_HEX_RE.test(entryPointAddressRaw)) {
      throw new Error(
        `MUHAVEN_ENTRY_POINT must be a 0x-prefixed 20-byte hex string (got ${JSON.stringify(entryPointAddressRaw)})`,
      );
    }
    entryPointAddress = entryPointAddressRaw.toLowerCase() as `0x${string}`;
  }

  return {
    backendBaseUrl,
    dashboardBaseUrl,
    brokerEndpoint,
    readOnly,
    requestTimeoutMs,
    brokerTimeoutMs,
    allowedBackendHosts: deriveAllowedHosts(backendBaseUrl),
    jwtCacheTtlSec,
    bundlerUrl,
    bundlerTimeoutMs,
    chainId,
    subscriptionAddress,
    entryPointAddress,
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
  // Same boot-time https-or-loopback validation as loadMcpConfig closes
  // the env-poisoning vector for daemon-resolved URLs (Security M-2).
  const backendBaseUrl = resolvePublicUrlEnv(
    'MUHAVEN_BACKEND_URL',
    env.MUHAVEN_BACKEND_URL,
    DEFAULT_BACKEND_URL,
  );
  const dashboardBaseUrl = resolvePublicUrlEnv(
    'MUHAVEN_DASHBOARD_URL',
    env.MUHAVEN_DASHBOARD_URL,
    DEFAULT_DASHBOARD_URL,
  );

  return {
    endpoint,
    sessionKeyHex,
    maxRequestBytes,
    requestTimeoutMs,
    backendBaseUrl,
    dashboardBaseUrl,
  };
}
