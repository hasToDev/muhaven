/**
 * Tiny line-based IPC client used by the MCP server to talk to a
 * running `muhaven-broker` daemon. Mirrors the protocol in
 * `src/broker/protocol.ts`.
 *
 * One request per connection; response is a single line. Connection
 * timeouts surface as `BrokerClientError` with a stable `code` string so
 * the MCP tool layer can map to host-friendly error responses without
 * inspecting message strings.
 */

import { connect, type Socket } from 'node:net';
import {
  BROKER_PROTOCOL_VERSION,
  type BrokerClearPolicySnapshotResponse,
  type BrokerErrorCode,
  type BrokerGetActiveSessionIdResponse,
  type BrokerGetJwtResponse,
  type BrokerGetPolicySnapshotResponse,
  type BrokerHelloResponse,
  type BrokerResponse,
  type BrokerSignHashResponse,
  type BrokerSignUserOpResponse,
  type BrokerStoreJwtResponse,
  type BrokerStorePolicySnapshotResponse,
  type PolicySnapshotWire,
} from '../broker/protocol.js';

export type BrokerClientErrorCode =
  | 'connect_failed'
  | 'timeout'
  | 'protocol_error'
  | 'broker_error';

export class BrokerClientError extends Error {
  constructor(
    readonly code: BrokerClientErrorCode,
    message: string,
    readonly cause?: unknown,
    /**
     * When `code === 'broker_error'`, this carries the typed upstream
     * error code from the daemon (e.g. `unsupported_type`,
     * `policy_violation`, `no_active_snapshot`). Callers in the tool
     * handler layer use it to map to fine-grained fallback reasons
     * without substring-matching on the message. Undefined for non-
     * broker_error variants (connect_failed / timeout / protocol_error)
     * since they never carry a daemon-side code.
     *
     * Added in Wave 5 Path D Slice 1 Commit 3 to close the
     * MCP-Builder H-1: a 0.3.x daemon returning `unsupported_type` for
     * `get_active_session_id` was previously mapped to the generic
     * `broker_internal` Path D fallback — operator-confusing. With
     * `brokerCode`, callers can route `unsupported_type` to
     * `version_too_old` explicitly.
     */
    readonly brokerCode?: BrokerErrorCode,
  ) {
    super(message);
    this.name = 'BrokerClientError';
  }
}

export interface BrokerClientOptions {
  endpoint: string;
  timeoutMs: number;
}

/**
 * Result of `BrokerClient.preflight()`. Discriminated on `supported`.
 * The unsupported variants carry enough structured info that the host
 * LLM can render an actionable remediation message — semver-mismatch
 * tells the operator to upgrade the broker; broker-unreachable tells
 * them to start it; session-key-unavailable tells them to rotate env.
 */
export type PreflightResult =
  | {
      readonly supported: true;
      readonly daemonVersion: string;
      readonly signerAddress: `0x${string}`;
    }
  | {
      readonly supported: false;
      readonly reason: 'version_too_old';
      readonly daemonVersion: string;
      readonly requiredVersion: string;
    }
  | {
      readonly supported: false;
      readonly reason: 'session_key_unavailable';
      readonly daemonVersion: string;
      readonly requiredVersion: string;
    }
  | {
      readonly supported: false;
      readonly reason: 'broker_unreachable';
      readonly message: string;
      readonly requiredVersion: string;
    };

/**
 * Tiny semver-gte for "is X ≥ Y". Both inputs MUST be M.m.p (no
 * pre-release / build-metadata suffixes) — the broker protocol version
 * is locked to that shape. Non-conforming inputs throw rather than
 * silently mis-compare.
 *
 * Kept inline to avoid adding a `semver` dep just for one three-segment
 * comparison; the broker's version space is small enough that a regex
 * + numeric compare is bulletproof.
 */
export function semverGte(a: string, b: string): boolean {
  // SemVer 2.0 §2: numeric identifiers MUST NOT have leading zeros.
  // `(0|[1-9]\d*)` enforces "0 alone OR a non-zero leading digit
  // followed by any digits." Rejects "01.0.0" / "0.04.0" etc. — these
  // would compare numerically the same but signal operator
  // misconfiguration (or a non-broker version string) so we surface
  // them as malformed instead of silently accepting (CR M-1).
  const re = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) {
    throw new BrokerClientError(
      'protocol_error',
      `semverGte: malformed version (got ${JSON.stringify(a)} vs ${JSON.stringify(b)})`,
    );
  }
  for (let i = 1; i <= 3; i++) {
    const ai = Number(ma[i]);
    const bi = Number(mb[i]);
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

export class BrokerClient {
  constructor(private readonly options: BrokerClientOptions) {}

  async hello(): Promise<BrokerHelloResponse> {
    const res = await this.exchange({ type: 'hello' });
    if (res.type !== 'hello') {
      throw new BrokerClientError('protocol_error', `expected hello response, got ${res.type}`);
    }
    return res;
  }

  async signHash(
    hash: `0x${string}`,
    intent?: { tool: string; summary?: string },
  ): Promise<BrokerSignHashResponse> {
    const res = await this.exchange({
      type: 'sign_hash',
      hash,
      ...(intent ? { intent } : {}),
    });
    if (res.type !== 'sign_hash') {
      throw new BrokerClientError(
        'protocol_error',
        `expected sign_hash response, got ${res.type}`,
      );
    }
    return res;
  }

  async storeJwt(jwt: string, expiresAtSec?: number): Promise<BrokerStoreJwtResponse> {
    const res = await this.exchange({
      type: 'store_jwt',
      jwt,
      ...(expiresAtSec === undefined ? {} : { expiresAtSec }),
    });
    if (res.type !== 'store_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected store_jwt response, got ${res.type}`,
      );
    }
    return res;
  }

  async getJwt(): Promise<BrokerGetJwtResponse> {
    const res = await this.exchange({ type: 'get_jwt' });
    if (res.type !== 'get_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected get_jwt response, got ${res.type}`,
      );
    }
    return res;
  }

  async clearJwt(): Promise<void> {
    const res = await this.exchange({ type: 'clear_jwt' });
    if (res.type !== 'clear_jwt') {
      throw new BrokerClientError(
        'protocol_error',
        `expected clear_jwt response, got ${res.type}`,
      );
    }
  }

  // ── Wave 5 Path D Slice 1 (Commit 3) — policy snapshot CRUD + sign_userop ──

  async signUserOp(args: {
    sessionId: string;
    userOpHash: `0x${string}`;
    innerCall: { target: `0x${string}`; callData: `0x${string}` };
    intent?: { tool: string; summary?: string };
  }): Promise<BrokerSignUserOpResponse> {
    const res = await this.exchange({
      type: 'sign_userop',
      sessionId: args.sessionId,
      userOpHash: args.userOpHash,
      innerCall: args.innerCall,
      ...(args.intent ? { intent: args.intent } : {}),
    });
    if (res.type !== 'sign_userop') {
      throw new BrokerClientError(
        'protocol_error',
        `expected sign_userop response, got ${res.type}`,
      );
    }
    return res;
  }

  async storePolicySnapshot(
    snapshot: PolicySnapshotWire,
  ): Promise<BrokerStorePolicySnapshotResponse> {
    const res = await this.exchange({ type: 'store_policy_snapshot', snapshot });
    if (res.type !== 'store_policy_snapshot') {
      throw new BrokerClientError(
        'protocol_error',
        `expected store_policy_snapshot response, got ${res.type}`,
      );
    }
    return res;
  }

  async getPolicySnapshot(sessionId: string): Promise<BrokerGetPolicySnapshotResponse> {
    const res = await this.exchange({ type: 'get_policy_snapshot', sessionId });
    if (res.type !== 'get_policy_snapshot') {
      throw new BrokerClientError(
        'protocol_error',
        `expected get_policy_snapshot response, got ${res.type}`,
      );
    }
    return res;
  }

  async clearPolicySnapshot(sessionId: string): Promise<BrokerClearPolicySnapshotResponse> {
    const res = await this.exchange({ type: 'clear_policy_snapshot', sessionId });
    if (res.type !== 'clear_policy_snapshot') {
      throw new BrokerClientError(
        'protocol_error',
        `expected clear_policy_snapshot response, got ${res.type}`,
      );
    }
    return res;
  }

  async getActiveSessionId(): Promise<BrokerGetActiveSessionIdResponse> {
    const res = await this.exchange({ type: 'get_active_session_id' });
    if (res.type !== 'get_active_session_id') {
      throw new BrokerClientError(
        'protocol_error',
        `expected get_active_session_id response, got ${res.type}`,
      );
    }
    return res;
  }

  /**
   * Detect whether the running daemon speaks Path D (protocol 0.4.0+).
   * Wraps `hello()` with a semver-gte comparison so the MCP tool layer
   * can short-circuit to Path C with a clear `version_too_old` reason
   * instead of surfacing the opaque `unsupported_type` error a stale
   * 0.3.0 daemon would emit on `sign_userop` / `get_active_session_id`
   * (Backend Architect H-2, round 2).
   *
   * Returns `{ supported: false }` on broker connect failure too — the
   * caller treats "daemon down" identically to "version too old": Path D
   * not available, fall through to Path C.
   */
  async preflight(): Promise<PreflightResult> {
    let hello: BrokerHelloResponse;
    try {
      hello = await this.hello();
    } catch (err) {
      return {
        supported: false,
        reason: 'broker_unreachable',
        message:
          err instanceof BrokerClientError
            ? `broker.${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'broker unreachable',
        requiredVersion: BROKER_PROTOCOL_VERSION,
      };
    }
    if (!semverGte(hello.version, BROKER_PROTOCOL_VERSION)) {
      return {
        supported: false,
        reason: 'version_too_old',
        daemonVersion: hello.version,
        requiredVersion: BROKER_PROTOCOL_VERSION,
      };
    }
    if (hello.hasSessionKey === false) {
      // Path D requires a loaded session key; a read-only-posture broker
      // can't sign UserOps. Distinct from version_too_old so the host's
      // remediation message is "rotate broker env" not "upgrade broker".
      return {
        supported: false,
        reason: 'session_key_unavailable',
        daemonVersion: hello.version,
        requiredVersion: BROKER_PROTOCOL_VERSION,
      };
    }
    return {
      supported: true,
      daemonVersion: hello.version,
      signerAddress: hello.sessionKeyAddress,
    };
  }

  private exchange(request: Record<string, unknown>): Promise<BrokerResponse> {
    return new Promise<BrokerResponse>((resolve, reject) => {
      let socket: Socket | undefined;
      let buffer = '';
      let settled = false;

      const settleErr = (err: BrokerClientError): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        reject(err);
      };

      const settleOk = (res: BrokerResponse): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        resolve(res);
      };

      const timer = setTimeout(() => {
        settleErr(new BrokerClientError('timeout', 'broker IPC timeout'));
      }, this.options.timeoutMs);

      try {
        socket = connect(this.options.endpoint);
      } catch (err) {
        clearTimeout(timer);
        settleErr(new BrokerClientError('connect_failed', 'cannot connect to broker', err));
        return;
      }

      socket.once('connect', () => {
        socket!.write(JSON.stringify(request) + '\n');
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx < 0) return;
        const line = buffer.slice(0, newlineIdx);
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line) as BrokerResponse;
          if (parsed.type === 'error') {
            settleErr(
              new BrokerClientError(
                'broker_error',
                `${parsed.code}: ${parsed.message}`,
                undefined,
                parsed.code,
              ),
            );
            return;
          }
          settleOk(parsed);
        } catch (err) {
          settleErr(new BrokerClientError('protocol_error', 'invalid JSON from broker', err));
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        settleErr(new BrokerClientError('connect_failed', err.message, err));
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settleErr(new BrokerClientError('protocol_error', 'broker closed without response'));
        }
      });
    });
  }
}
