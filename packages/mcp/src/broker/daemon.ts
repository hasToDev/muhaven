/**
 * `muhaven-broker` daemon — the single-purpose process that holds the
 * session-key private half AND the device-flow JWT, exposing only IPC
 * primitives for `sign_hash` + `store_jwt` / `get_jwt` / `clear_jwt`.
 *
 * Design constraints (ranked):
 *  1. Never speak TCP. Reachable only via local socket / named pipe.
 *  2. Never reach out to the network. No fetch, no RPC, no bundler —
 *     even after ADR-3 the broker remains zero-egress; the *MCP server*
 *     speaks HTTPS to the backend and hands the JWT to the broker for
 *     storage via `store_jwt`.
 *  3. Peer access is enforced by filesystem permissions on POSIX (parent
 *     dir 0700 / socket file 0600). Windows named pipe inherits the
 *     creating user's ACL by default.
 *  4. Survive a malformed peer: each request size-capped, JSON parse
 *     failure → structured error response (not a crash), hung peer
 *     force-disconnected after `requestTimeoutMs`.
 *
 * See `development/DEV_WAVE_4/ADR_LOG.md` ADR-3 for the device-flow
 * design that motivates the JWT verbs.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { loadBrokerConfig, type BrokerRuntimeConfig } from '../config.js';
import {
  BROKER_PROTOCOL_VERSION,
  parseBrokerRequest,
  serializeResponse,
  type BrokerErrorCode,
  type BrokerErrorResponse,
  type BrokerRequest,
  type BrokerResponse,
} from './protocol.js';
import { MissingSessionKeyError, NullSigner, ViemSigner, type ISigner } from './signer.js';
import { openKeystore, type IKeystore } from './keystore.js';
import { checkPolicy, FilePolicyStore, PolicyStoreError, type IPolicyStore } from './policy-snapshot.js';

export { BROKER_PROTOCOL_VERSION };

export interface BrokerDaemonOptions {
  config: BrokerRuntimeConfig;
  signer?: ISigner;
  /** Inject a keystore for tests; default opens the configured backend. */
  keystore?: IKeystore;
  /**
   * Inject a policy store for tests; defaults to a `FilePolicyStore` rooted
   * at `~/.muhaven/policy-snapshots/`. The store is consulted by
   * `sign_userop` (validate before signing) and exposed via the
   * `store_policy_snapshot` / `get_policy_snapshot` / `clear_policy_snapshot`
   * verbs added in Wave 5 Path D Slice 1 (protocol 0.4.0).
   */
  policyStore?: IPolicyStore;
  /** Override for the connection-handler logger; defaults to silent. */
  logger?: (event: BrokerLogEvent) => void;
}

export interface BrokerLogEvent {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

const noopLogger = (_e: BrokerLogEvent): void => {
  /* silent — caller can opt into a logger */
};

/**
 * Pure-function request handler — given a parsed request, signer, and
 * keystore, returns the response object. Easy to unit-test without
 * spawning a socket.
 */
export interface HandleBrokerRequestOptions {
  /**
   * Whether the daemon was booted with a session-key private half. Drives
   * the `hello.hasSessionKey` field + the `session_key_unavailable` error
   * mapping. Defaults to `true` when omitted (current-runtime back-compat
   * — older callers that don't know about the read-only posture still
   * get the pre-0.3.0 behaviour).
   */
  hasSessionKey?: boolean;
  /**
   * Effective backend + dashboard URLs the daemon resolved from its env
   * at boot. Surfaced via `hello.effectiveConfig` so the `--from-daemon`
   * login path can use the daemon's view of these URLs (not the CLI's).
   */
  effectiveConfig?: {
    readonly backendBaseUrl: string;
    readonly dashboardBaseUrl: string;
  };
  /**
   * The daemon's own OS PID. Injectable so unit tests can pin a value;
   * production callers pass `process.pid` from the daemon process at
   * handler-construction time. Surfaced via `hello.pid` so
   * `muhaven-broker stop` can SIGTERM by PID. Added in @muhaven/mcp@0.1.5.
   */
  pid?: number;
}

export async function handleBrokerRequest(
  req: BrokerRequest,
  signer: ISigner,
  keystore: IKeystore,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
  options: HandleBrokerRequestOptions = {},
  policyStore?: IPolicyStore,
): Promise<BrokerResponse> {
  switch (req.type) {
    case 'hello': {
      let hasJwt = false;
      try {
        const record = await keystore.get();
        hasJwt = record !== null;
      } catch {
        // hello must always succeed; keystore failures surface on get/store
        hasJwt = false;
      }
      const hasSessionKey = options.hasSessionKey ?? true;
      return {
        type: 'hello',
        version: BROKER_PROTOCOL_VERSION,
        sessionKeyAddress: signer.address,
        hasJwt,
        hasSessionKey,
        ...(options.effectiveConfig ? { effectiveConfig: options.effectiveConfig } : {}),
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
      };
    }
    case 'sign_hash': {
      try {
        const signature = await signer.signHash(req.hash);
        return { type: 'sign_hash', signature, signerAddress: signer.address };
      } catch (err) {
        if (err instanceof MissingSessionKeyError) {
          return errorResponse('session_key_unavailable', err.message);
        }
        throw err;
      }
    }
    case 'store_jwt': {
      try {
        await keystore.set({
          jwt: req.jwt,
          expiresAtSec: req.expiresAtSec ?? null,
          storedAtSec: nowSec(),
        });
        return { type: 'store_jwt', stored: true };
      } catch (err) {
        return errorResponse(
          'keystore_unavailable',
          err instanceof Error ? err.message : 'keystore write failed',
        );
      }
    }
    case 'get_jwt': {
      try {
        const record = await keystore.get();
        return {
          type: 'get_jwt',
          jwt: record?.jwt ?? null,
          expiresAtSec: record?.expiresAtSec ?? null,
        };
      } catch (err) {
        return errorResponse(
          'keystore_unavailable',
          err instanceof Error ? err.message : 'keystore read failed',
        );
      }
    }
    case 'clear_jwt': {
      try {
        await keystore.clear();
        return { type: 'clear_jwt', cleared: true };
      } catch (err) {
        return errorResponse(
          'keystore_unavailable',
          err instanceof Error ? err.message : 'keystore clear failed',
        );
      }
    }
    case 'sign_userop': {
      // Wave 5 Path D Slice 1 — policy-gated UserOp signature.
      if (!policyStore) {
        return errorResponse(
          'internal',
          'broker daemon is not configured with a policy store',
        );
      }
      // Read clock once; reuse for store TTL filter + checkPolicy expiry
      // check so the two never disagree about "now" (Code Reviewer LOW-2).
      const now = nowSec();
      let snapshot;
      try {
        snapshot = await policyStore.get(req.sessionId, now);
      } catch (err) {
        return errorResponse(
          'internal',
          err instanceof Error ? err.message : 'policy store read failed',
        );
      }
      if (!snapshot) {
        return errorResponse(
          'no_active_snapshot',
          `no active snapshot for session ${req.sessionId}`,
        );
      }
      const check = checkPolicy({
        snapshot,
        innerCall: req.innerCall,
        activeSigner: signer.address,
        nowSec: now,
      });
      if (!check.ok) {
        return errorResponse(check.code, check.message);
      }
      try {
        const signature = await signer.signHash(req.userOpHash);
        return {
          type: 'sign_userop',
          signature,
          signerAddress: signer.address,
          sessionId: req.sessionId,
        };
      } catch (err) {
        if (err instanceof MissingSessionKeyError) {
          return errorResponse('session_key_unavailable', err.message);
        }
        throw err;
      }
    }
    case 'store_policy_snapshot': {
      if (!policyStore) {
        return errorResponse(
          'internal',
          'broker daemon is not configured with a policy store',
        );
      }
      try {
        await policyStore.put(req.snapshot);
        return {
          type: 'store_policy_snapshot',
          stored: true,
          sessionId: req.snapshot.sessionId,
        };
      } catch (err) {
        if (err instanceof PolicyStoreError) {
          return errorResponse('internal', err.message);
        }
        return errorResponse(
          'internal',
          err instanceof Error ? err.message : 'policy store write failed',
        );
      }
    }
    case 'get_policy_snapshot': {
      if (!policyStore) {
        return errorResponse(
          'internal',
          'broker daemon is not configured with a policy store',
        );
      }
      try {
        const snapshot = await policyStore.get(req.sessionId, nowSec());
        return { type: 'get_policy_snapshot', snapshot };
      } catch (err) {
        if (err instanceof PolicyStoreError) {
          return errorResponse('internal', err.message);
        }
        return errorResponse(
          'internal',
          err instanceof Error ? err.message : 'policy store read failed',
        );
      }
    }
    case 'clear_policy_snapshot': {
      if (!policyStore) {
        return errorResponse(
          'internal',
          'broker daemon is not configured with a policy store',
        );
      }
      try {
        await policyStore.delete(req.sessionId);
        return {
          type: 'clear_policy_snapshot',
          cleared: true,
          sessionId: req.sessionId,
        };
      } catch (err) {
        if (err instanceof PolicyStoreError) {
          return errorResponse('internal', err.message);
        }
        return errorResponse(
          'internal',
          err instanceof Error ? err.message : 'policy store clear failed',
        );
      }
    }
    case 'get_active_session_id': {
      if (!policyStore) {
        return errorResponse(
          'internal',
          'broker daemon is not configured with a policy store',
        );
      }
      try {
        const sessionId = await policyStore.activeSessionId(signer.address, nowSec());
        return { type: 'get_active_session_id', sessionId };
      } catch (err) {
        if (err instanceof PolicyStoreError) {
          return errorResponse('internal', err.message);
        }
        return errorResponse(
          'internal',
          err instanceof Error ? err.message : 'policy store enumerate failed',
        );
      }
    }
  }
}

function errorResponse(code: BrokerErrorCode, message: string): BrokerErrorResponse {
  return { type: 'error', code, message };
}

/**
 * Bind the daemon's IPC endpoint, applying POSIX file-permission ACLs.
 * On Windows the named-pipe ACL is inherited from the user; we don't
 * enforce mode bits there.
 */
async function prepareEndpoint(endpoint: string): Promise<void> {
  if (platform() === 'win32') return;

  const parent = dirname(endpoint);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask on existing dirs — re-apply.
  await chmod(parent, 0o700);

  // Stale socket cleanup: a previous broker may have left a file behind.
  try {
    const s = await stat(endpoint);
    if (s.isSocket() || s.isFIFO()) {
      await unlink(endpoint);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function applySocketPermissions(endpoint: string): Promise<void> {
  if (platform() === 'win32') return;
  await chmod(endpoint, 0o600);
}

export class BrokerDaemon {
  private readonly server: Server;
  private readonly signer: ISigner;
  private readonly log: (e: BrokerLogEvent) => void;
  private readonly config: BrokerRuntimeConfig;
  private keystore: IKeystore | null;
  private readonly policyStore: IPolicyStore;

  /**
   * Whether a session-key private half is actually loaded. `false` =
   * daemon booted in read-only posture (no `MUHAVEN_BROKER_SESSION_KEY`
   * at env-load time) and uses a `NullSigner` whose `signHash` throws.
   */
  private readonly hasSessionKey: boolean;

  constructor(options: BrokerDaemonOptions) {
    this.config = options.config;
    // Tests inject a signer directly; the runtime path lazy-constructs
    // either a ViemSigner or a NullSigner depending on whether the env
    // supplied a session key. When the test injects a signer we treat
    // hasSessionKey as `true` — the NullSigner case is only exercised by
    // the production loader.
    if (options.signer) {
      this.signer = options.signer;
      this.hasSessionKey = true;
    } else if (options.config.sessionKeyHex) {
      this.signer = new ViemSigner(options.config.sessionKeyHex);
      this.hasSessionKey = true;
    } else {
      this.signer = new NullSigner();
      this.hasSessionKey = false;
    }
    this.keystore = options.keystore ?? null;
    // Policy store is constructed eagerly because the Slice 1 file-backed
    // impl has no async setup (dir is created lazily on first put). Slice 5
    // spend-ledger will add an async `init()` to seed the SHA-256 chain;
    // start() awaits the optional init so the asymmetry stays paper-thin
    // (Backend Architect M-1). Tests pass a memory impl via options.policyStore.
    this.policyStore = options.policyStore ?? new FilePolicyStore(FilePolicyStore.defaultDir());
    this.log = options.logger ?? noopLogger;
    this.server = createServer((socket) => this.onConnection(socket));
  }

  async start(): Promise<string> {
    if (!this.keystore) {
      const { keystore, fallbackReason } = await openKeystore();
      this.keystore = keystore;
      if (fallbackReason) {
        this.log({
          level: 'warn',
          msg: 'OS keychain unavailable — falling back to file-backed keystore',
          meta: { reason: fallbackReason },
        });
      }
    }
    // Optional one-shot async setup for the policy store (no-op for the
    // file-backed Slice 1 impl; seeds the chain for Slice 5 spend-ledger).
    if (this.policyStore.init) await this.policyStore.init();
    await prepareEndpoint(this.config.endpoint);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.endpoint);
    });
    await applySocketPermissions(this.config.endpoint);
    this.log({
      level: 'info',
      msg: 'broker daemon listening',
      meta: {
        endpoint: this.config.endpoint,
        signer: this.signer.address,
        hasSessionKey: this.hasSessionKey,
        keystore: this.keystore.backend,
        version: BROKER_PROTOCOL_VERSION,
      },
    });
    return this.config.endpoint;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    if (platform() !== 'win32') {
      try {
        await unlink(this.config.endpoint);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log({ level: 'warn', msg: 'failed to unlink socket on stop', meta: { err } });
        }
      }
    }
    this.log({ level: 'info', msg: 'broker daemon stopped' });
  }

  private onConnection(socket: Socket): void {
    let buffer = '';
    let bytesReceived = 0;
    const timeout = setTimeout(() => {
      this.log({ level: 'warn', msg: 'connection timeout — closing socket' });
      socket.destroy();
    }, this.config.requestTimeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeAllListeners('data');
      socket.removeAllListeners('end');
      socket.removeAllListeners('error');
    };

    socket.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > this.config.maxRequestBytes) {
        const res = errorResponse('payload_too_large', 'request exceeded maxRequestBytes');
        socket.end(serializeResponse(res));
        cleanup();
        return;
      }
      buffer += chunk.toString('utf8');

      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) return;

      // Single-shot protocol: reject extra bytes after the first
      // newline rather than silently dropping them. A future buggy
      // client that pipelines requests will see the error and stop;
      // a malicious peer learns nothing because they get the same
      // close + error a sloppy peer would.
      const trailing = buffer.slice(newlineIdx + 1);
      if (trailing.length > 0) {
        const res = errorResponse(
          'invalid_request',
          'broker is single-shot — extra bytes after first newline',
        );
        socket.end(serializeResponse(res));
        cleanup();
        return;
      }

      const line = buffer.slice(0, newlineIdx);
      const parsed = parseBrokerRequest(line);

      void this.runAndRespond(parsed, socket).finally(() => {
        cleanup();
      });
    });

    socket.on('error', (err) => {
      this.log({ level: 'warn', msg: 'socket error', meta: { err: err.message } });
      cleanup();
    });

    socket.on('end', () => {
      cleanup();
    });
  }

  private async runAndRespond(
    parsed: BrokerRequest | BrokerErrorResponse,
    socket: Socket,
  ): Promise<void> {
    if ('type' in parsed && parsed.type === 'error') {
      socket.end(serializeResponse(parsed));
      return;
    }
    if (!this.keystore) {
      socket.end(
        serializeResponse(errorResponse('internal', 'keystore not initialized')),
      );
      return;
    }
    try {
      const res = await handleBrokerRequest(
        parsed as BrokerRequest,
        this.signer,
        this.keystore,
        undefined,
        {
          hasSessionKey: this.hasSessionKey,
          effectiveConfig: {
            backendBaseUrl: this.config.backendBaseUrl,
            dashboardBaseUrl: this.config.dashboardBaseUrl,
          },
          pid: process.pid,
        },
        this.policyStore,
      );
      socket.end(serializeResponse(res));
    } catch (err) {
      this.log({
        level: 'error',
        msg: 'handler failed',
        meta: { err: err instanceof Error ? err.message : String(err) },
      });
      socket.end(
        serializeResponse(errorResponse('internal', 'broker handler failed; check broker logs')),
      );
    }
  }
}

/**
 * CLI entrypoint when invoked as `muhaven-broker` (no subcommand) — runs
 * the daemon. Subcommand routing (`login`, `logout`, `doctor`) lives in
 * `src/broker/cli.ts` and is dispatched by `bin/muhaven-broker.cjs`.
 */
export async function runBrokerDaemonCli(): Promise<void> {
  const config = loadBrokerConfig();
  if (!config.sessionKeyHex) {
    // One-line operator-visible breadcrumb so the read-only posture isn't
    // a silent surprise. Write paths will surface `session_key_unavailable`
    // from `sign_hash`; reads + JWT verbs work normally.
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'broker booting in read-only posture (no MUHAVEN_BROKER_SESSION_KEY)',
      }) + '\n',
    );
  }
  const daemon = new BrokerDaemon({
    config,
    logger: (e) => {
      // STDERR is the safe channel — STDOUT is reserved for IPC frames
      // in case anyone repurposes the binary.
      const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
      process.stderr.write(line + '\n');
    },
  });
  await daemon.start();

  const shutdown = async (): Promise<void> => {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // bin/muhaven-broker.cjs wraps this call in `.then(code => process.exit(code))`,
  // which would fire the moment we resolve. Park forever so the only escape
  // is the SIGINT/SIGTERM-driven shutdown() above (or process.kill from outside).
  await new Promise<never>(() => {});
}
