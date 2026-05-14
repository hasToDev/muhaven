/**
 * Wire protocol between the MCP server (`@muhaven/mcp` STDIO subprocess)
 * and the long-running `muhaven-broker` daemon.
 *
 * Newline-delimited JSON over a Unix socket (POSIX) or named pipe
 * (Windows). Each request is a single JSON object; each response is a
 * single JSON object. No request pipelining, no streaming.
 *
 * **Protocol version 0.3.0** — additive bump from 0.2.0 in @muhaven/mcp@0.1.3
 * to add `hello.hasSessionKey` + `hello.effectiveConfig` (so a daemon
 * booted without `MUHAVEN_BROKER_SESSION_KEY` can serve read paths AND
 * surface its effective backend/dashboard URLs to `muhaven-broker login
 * --from-daemon`). The 0.2.0 bump from 0.1.0 (Wave 4 P3 ADR-3) added the
 * `store_jwt` / `get_jwt` / `clear_jwt` triple — the broker is the single
 * keeper of the device-flow JWT (per ADR-3 D1 "polling, not loopback
 * callback") in addition to the session-key private half.
 *
 * Threat-model invariants:
 *  - The broker NEVER reaches out to the network. It only:
 *      (a) signs hashes that the MCP server received from the backend,
 *      (b) stores / returns / clears a JWT that the MCP server
 *          received from the backend.
 *    Splitting network egress (MCP server) from signing + secret
 *    storage (broker) is the lethal-trifecta mitigation in
 *    `THREAT_MODEL_P0.md` §"Lethal-trifecta self-audit".
 *  - Requests are size-capped (`maxRequestBytes`) — a malformed peer
 *    cannot exhaust broker memory by sending an unbounded JSON blob.
 */

export const BROKER_PROTOCOL_VERSION = '0.3.0';

// ---------- requests ----------

export interface BrokerHelloRequest {
  readonly type: 'hello';
}

export interface BrokerSignHashRequest {
  readonly type: 'sign_hash';
  /** 0x-prefixed 32-byte hex (e.g., a UserOp hash to be ECDSA-signed). */
  readonly hash: `0x${string}`;
  /** Free-form context for the audit log. NOT trusted as policy input. */
  readonly intent?: {
    readonly tool: string;
    readonly summary?: string;
  };
}

export interface BrokerStoreJwtRequest {
  readonly type: 'store_jwt';
  /** A scoped device-flow JWT (mcp.read.*, mcp.propose.*) per ADR-3 D2. */
  readonly jwt: string;
  /** Optional issuer-stated expiry (epoch seconds). Used for proactive
   *  re-login UX; not for trust decisions. */
  readonly expiresAtSec?: number;
}

export interface BrokerGetJwtRequest {
  readonly type: 'get_jwt';
}

export interface BrokerClearJwtRequest {
  readonly type: 'clear_jwt';
}

// ---------- responses ----------

export interface BrokerHelloResponse {
  readonly type: 'hello';
  readonly version: string;
  /**
   * 0x-prefixed checksummed address derived from the session key. When
   * the daemon was booted without `MUHAVEN_BROKER_SESSION_KEY` (read-only
   * posture; see `hasSessionKey`), this is the zero address.
   *
   * **DO NOT** use address-equality (`sessionKeyAddress !== ZERO_ADDRESS`)
   * as a proxy for "session key is loaded" — that's a soft signal that
   * future changes (e.g. allowing custom EOA-bound dev posture) could
   * break silently. The authoritative aliveness check is `hasSessionKey`.
   */
  readonly sessionKeyAddress: `0x${string}`;
  /** Whether a JWT is currently in the keystore. Useful for `doctor`. */
  readonly hasJwt: boolean;
  /**
   * Whether a session-key private half is loaded into the daemon. False
   * when the daemon was booted without `MUHAVEN_BROKER_SESSION_KEY` — in
   * that posture read tools still work (the broker serves JWT verbs), but
   * any `sign_hash` request returns `session_key_unavailable`. Field added
   * in protocol 0.3.0; absence implies `true` for back-compat with
   * 0.2.0 daemons.
   */
  readonly hasSessionKey?: boolean;
  /**
   * Effective backend + dashboard URLs the daemon resolved from its own
   * process env at boot. Surfaced so `muhaven-broker login --from-daemon`
   * can stay in lockstep with the daemon's view rather than re-reading
   * the CLI's env (which may diverge — e.g. login invoked over ssh inherits
   * a different shell env than the systemd-launched daemon). Field added
   * in protocol 0.3.0; absent on older daemons.
   */
  readonly effectiveConfig?: {
    readonly backendBaseUrl: string;
    readonly dashboardBaseUrl: string;
  };
}

export interface BrokerSignHashResponse {
  readonly type: 'sign_hash';
  /** 0x-prefixed 65-byte ECDSA signature (r || s || v). */
  readonly signature: `0x${string}`;
  readonly signerAddress: `0x${string}`;
}

export interface BrokerStoreJwtResponse {
  readonly type: 'store_jwt';
  readonly stored: true;
}

export interface BrokerGetJwtResponse {
  readonly type: 'get_jwt';
  /** Null when no JWT in keystore — caller must trigger device-flow. */
  readonly jwt: string | null;
  readonly expiresAtSec: number | null;
}

export interface BrokerClearJwtResponse {
  readonly type: 'clear_jwt';
  readonly cleared: true;
}

export interface BrokerErrorResponse {
  readonly type: 'error';
  readonly code: BrokerErrorCode;
  readonly message: string;
}

export type BrokerErrorCode =
  | 'invalid_request'
  | 'payload_too_large'
  | 'unsupported_type'
  | 'internal'
  | 'forbidden'
  | 'keystore_unavailable'
  | 'session_key_unavailable';

export type BrokerRequest =
  | BrokerHelloRequest
  | BrokerSignHashRequest
  | BrokerStoreJwtRequest
  | BrokerGetJwtRequest
  | BrokerClearJwtRequest;

export type BrokerResponse =
  | BrokerHelloResponse
  | BrokerSignHashResponse
  | BrokerStoreJwtResponse
  | BrokerGetJwtResponse
  | BrokerClearJwtResponse
  | BrokerErrorResponse;

const HASH_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isHashHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && HASH_HEX_RE.test(value);
}

function isJwtShape(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && JWT_RE.test(value);
}

/**
 * Parse a single-line request payload. Returns either the validated
 * request or a structured error — the daemon converts errors to a
 * `BrokerErrorResponse` without raising so a malformed peer cannot crash
 * the daemon process.
 */
export function parseBrokerRequest(line: string): BrokerRequest | BrokerErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: 'error', code: 'invalid_request', message: 'request is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'error', code: 'invalid_request', message: 'request must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case 'hello':
      return { type: 'hello' };
    case 'sign_hash': {
      const hash = obj.hash;
      if (!isHashHex(hash)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_hash.hash must be a 0x-prefixed 32-byte hex string',
        };
      }
      const intent = obj.intent;
      const intentValid =
        intent === undefined ||
        (typeof intent === 'object' &&
          intent !== null &&
          typeof (intent as Record<string, unknown>).tool === 'string');
      if (!intentValid) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_hash.intent.tool must be a string when provided',
        };
      }
      return {
        type: 'sign_hash',
        hash,
        ...(intent === undefined ? {} : { intent: intent as BrokerSignHashRequest['intent'] }),
      };
    }
    case 'store_jwt': {
      const jwt = obj.jwt;
      if (!isJwtShape(jwt)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'store_jwt.jwt must be a JWT-shaped string ≤8192 chars',
        };
      }
      const expiresAtSec = obj.expiresAtSec;
      const expiresValid =
        expiresAtSec === undefined ||
        (typeof expiresAtSec === 'number' && Number.isFinite(expiresAtSec) && expiresAtSec > 0);
      if (!expiresValid) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'store_jwt.expiresAtSec must be a positive number when provided',
        };
      }
      return {
        type: 'store_jwt',
        jwt,
        ...(expiresAtSec === undefined ? {} : { expiresAtSec: expiresAtSec as number }),
      };
    }
    case 'get_jwt':
      return { type: 'get_jwt' };
    case 'clear_jwt':
      return { type: 'clear_jwt' };
    default:
      return {
        type: 'error',
        code: 'unsupported_type',
        message: `unsupported request type: ${String(obj.type)}`,
      };
  }
}

export function serializeResponse(res: BrokerResponse): string {
  return JSON.stringify(res) + '\n';
}
