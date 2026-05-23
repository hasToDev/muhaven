/**
 * Wave 5 Option D Commit 3 — broker outbound-egress module.
 *
 * The broker daemon was zero-egress through Wave 5 Option D Commit 2.
 * C3 introduces two narrow outbound capabilities:
 *
 *   1. `currentNonce(accountAddress)` — read-only `eth_call` against
 *      the kernel's `currentNonce()` view. Used by the MCP server's
 *      MODE.ENABLE pre-check (mirror's stored `validatorNonce` MUST
 *      match the live on-chain nonce; mismatch → `enable_sig_stale`).
 *
 *   2. `enqueueValidatorEnabledCallback(...)` — fire-and-forget POST
 *      to the backend's `validator-enabled` route with exponential
 *      backoff retry. The backend chain indexer is the authoritative
 *      source of truth; this callback is fast-path optimization.
 *
 * **Threat-model relaxation** (R2 design call, operator-approved at
 * handoff): the broker carries `BROKER_CALLBACK_SERVICE_SECRET` and
 * makes outbound HTTPS calls + `eth_call` reads. See `protocol.ts`
 * JSDoc for the load-bearing rationale. The MCP server does NOT need
 * the callback secret in this design — it only needs to call the
 * `notify_userop_landed` IPC verb, which is gated on the broker's
 * local socket permissions (the same gate that protects `sign_userop`).
 *
 * All outbound calls use `node:fetch` with explicit `Origin` headers
 * (per [[feedback-zerodev-bundler-origin-header]] — ZeroDev's bundler
 * rejects bare Node fetches with 403 if the Origin isn't set to the
 * dashboard's domain).
 */

import {
  decodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from 'viem';

/**
 * Wave 5 Option D Commit 3 — kernel.currentNonce() ABI. Mirrors the
 * MCP server's `KERNEL_V3_CURRENT_NONCE_ABI` (kept here as a separate
 * declaration so the broker doesn't depend on the MCP tool surface).
 *
 * Source: `@zerodev/sdk/accounts/kernel/abi/kernel_v_3_1/KernelAccountAbi.ts:44-50`.
 */
const KERNEL_V3_CURRENT_NONCE_ABI = parseAbi([
  'function currentNonce() view returns (uint32)',
]);

export class ChainRpcError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ChainRpcError';
  }
}

export class CallbackError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CallbackError';
  }
}

export interface OutboundConfig {
  readonly chainRpcUrl?: string;
  readonly backendBaseUrl: string;
  readonly callbackServiceSecret?: string;
  /** Origin header stamped on outbound bundler / RPC calls. */
  readonly outboundOriginHeader: string;
  /** Per-fetch timeout in ms. Defaults to 15s. */
  readonly fetchTimeoutMs?: number;
  /**
   * Injectable fetch impl for tests. Defaults to global `fetch`. The
   * shape matches the standard Fetch API — no node-specific quirks.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Setter/clearer for the retry timer. Tests inject a fake-timer
   * pair so they can advance virtual time without `await new
   * Promise(setTimeout)`. Production passes Node's globals.
   */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/**
 * Exponential-backoff schedule for the callback retry loop. Mirrors the
 * plan: 5s/15s/60s/5m, max 1h elapsed.
 */
const CALLBACK_RETRY_SCHEDULE_MS: readonly number[] = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
];
const CALLBACK_MAX_ELAPSED_MS = 60 * 60_000; // 1 hour

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export class BrokerOutbound {
  private readonly fetchImpl: typeof fetch;
  private readonly fetchTimeoutMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  /**
   * Wave 5 Option D Commit 3 (multi-agent review SecEng-MED-3) —
   * in-process dedup of `notify_userop_landed` callbacks. Map of
   * `<sessionId>:<txHash>` → the in-flight retry loop's Promise.
   * Repeated IPC calls with the same key fold into the existing
   * loop instead of spawning a parallel POST. Defends against a
   * local-socket peer flooding the broker with replay attempts +
   * caps the retry-budget waste at one loop per real install.
   */
  private readonly inflightCallbacks = new Map<
    string,
    Promise<{ ok: boolean; attempts: number; lastError?: string }>
  >();

  constructor(
    private readonly config: OutboundConfig,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void = () => {
      /* silent */
    },
  ) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.setTimeoutImpl = (config.setTimeout ?? setTimeout) as typeof setTimeout;
    this.clearTimeoutImpl = (config.clearTimeout ?? clearTimeout) as typeof clearTimeout;
  }

  /**
   * Read the kernel's `currentNonce()` view via `eth_call` against the
   * configured chain RPC. Returns a uint32. Throws `ChainRpcError` when
   * unconfigured / network failed / RPC returned non-decodable bytes.
   */
  async currentNonce(accountAddress: `0x${string}`): Promise<number> {
    if (!this.config.chainRpcUrl) {
      throw new ChainRpcError(
        'broker chain RPC unconfigured — set MUHAVEN_BROKER_RPC_URL or MUHAVEN_BUNDLER_URL',
      );
    }
    const data = encodeFunctionData({
      abi: KERNEL_V3_CURRENT_NONCE_ABI,
      functionName: 'currentNonce',
    });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: accountAddress, data }, 'latest'],
    });
    let res: Response;
    const ac = new AbortController();
    const timer = this.setTimeoutImpl(() => ac.abort(), this.fetchTimeoutMs);
    try {
      res = await this.fetchImpl(this.config.chainRpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: this.config.outboundOriginHeader,
        },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      throw new ChainRpcError(
        `chain RPC fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      this.clearTimeoutImpl(timer);
    }
    if (!res.ok) {
      throw new ChainRpcError(
        `chain RPC returned HTTP ${res.status}`,
      );
    }
    let parsed: { result?: string; error?: { message?: string } };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch (err) {
      throw new ChainRpcError(
        `chain RPC returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed.error) {
      throw new ChainRpcError(
        `chain RPC error: ${parsed.error.message ?? 'unknown'}`,
      );
    }
    if (typeof parsed.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(parsed.result)) {
      throw new ChainRpcError(
        `chain RPC returned non-hex result: ${JSON.stringify(parsed.result).slice(0, 80)}`,
      );
    }
    let nonce: number;
    try {
      const decoded = decodeAbiParameters(
        [{ type: 'uint32' }],
        parsed.result as Hex,
      );
      // viem decodes uint32 as a plain `number` (≤ 2^53), NOT a
      // bigint — see viem/_types/utils/abi/decodeAbiParameters.d.ts.
      nonce = Number(decoded[0]);
    } catch (err) {
      throw new ChainRpcError(
        `failed to decode currentNonce result: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Number.isFinite(nonce) || nonce < 0 || nonce > 0xffff_ffff) {
      throw new ChainRpcError(`currentNonce out of uint32 range: ${nonce}`);
    }
    return nonce;
  }

  /**
   * Whether the callback path is wired (both secret + backend URL set).
   * The `notify_userop_landed` daemon handler checks this and returns
   * `callback_unconfigured` when false so the operator sees the gap.
   */
  isCallbackConfigured(): boolean {
    return Boolean(this.config.callbackServiceSecret) && Boolean(this.config.backendBaseUrl);
  }

  /**
   * Queue a `validator-enabled` callback POST to the backend. Returns
   * immediately; the retry loop runs in the background (5s / 15s / 60s
   * / 5m, max 1h elapsed). Failures are logged but do NOT propagate to
   * the IPC caller — the chain indexer is the authoritative safety
   * net.
   *
   * Idempotency: every POST carries an `Idempotency-Key` header
   * `<sessionId>:validator-enabled`. The backend route is no-op if the
   * mirror row's `enable_status` is already `'enabled'` (because the
   * chain indexer raced ahead).
   *
   * Returns a Promise resolved when the loop terminates (success or
   * max-elapsed). Callers don't need to await; tests use it for
   * deterministic assertions.
   */
  enqueueValidatorEnabledCallback(args: {
    readonly sessionId: string;
    readonly userId?: string;
    readonly accountAddress: `0x${string}`;
    readonly permissionId: `0x${string}`;
    readonly txHash: `0x${string}`;
    readonly blockNumber: number;
    readonly logIndex: number;
  }): Promise<{ ok: boolean; attempts: number; lastError?: string }> {
    if (!this.isCallbackConfigured()) {
      return Promise.resolve({
        ok: false,
        attempts: 0,
        lastError: 'callback_unconfigured',
      });
    }
    // SecEng-MED-3 dedup: per-(sessionId, txHash, accountAddress)
    // in-flight folding. Including `accountAddress` defends against
    // an IPC peer that crafts two notify calls with the same
    // (sessionId, txHash) but different `accountAddress` — the
    // backend route's emitter-vs-accountAddress cross-check would
    // reject one, but only AFTER both are queued. Including the
    // address in the dedup key forces the second call to spawn a
    // separate loop, where its 422 surfaces cleanly to the operator
    // log channel.
    const dedupKey = `${args.sessionId}:${args.txHash.toLowerCase()}:${args.accountAddress.toLowerCase()}`;
    const existing = this.inflightCallbacks.get(dedupKey);
    if (existing) {
      this.log('info', 'validator-enabled callback already in flight — folded', {
        sessionId: args.sessionId,
      });
      return existing;
    }
    const promise = this.runCallbackLoop(args).finally(() => {
      // Free the slot when the loop terminates (success or budget
      // exhaustion). A subsequent retry from a different broker
      // session (rare) would then spawn a fresh loop.
      this.inflightCallbacks.delete(dedupKey);
    });
    this.inflightCallbacks.set(dedupKey, promise);
    return promise;
  }

  private async runCallbackLoop(args: {
    readonly sessionId: string;
    readonly userId?: string;
    readonly accountAddress: `0x${string}`;
    readonly permissionId: `0x${string}`;
    readonly txHash: `0x${string}`;
    readonly blockNumber: number;
    readonly logIndex: number;
  }): Promise<{ ok: boolean; attempts: number; lastError?: string }> {
    const url = `${this.config.backendBaseUrl.replace(/\/+$/, '')}/api/v1/agent/policy/scoped-session/${encodeURIComponent(args.sessionId)}/validator-enabled`;
    const body = JSON.stringify({
      userId: args.userId,
      accountAddress: args.accountAddress,
      permissionId: args.permissionId,
      txHash: args.txHash,
      blockNumber: args.blockNumber,
      logIndex: args.logIndex,
    });
    const startedAt = Date.now();
    let attempts = 0;
    let lastError: string | undefined;
    // Initial attempt + retries per schedule.
    for (let i = 0; i <= CALLBACK_RETRY_SCHEDULE_MS.length; i++) {
      if (i > 0) {
        const delay = CALLBACK_RETRY_SCHEDULE_MS[i - 1] ?? 0;
        const elapsed = Date.now() - startedAt;
        if (elapsed + delay > CALLBACK_MAX_ELAPSED_MS) {
          lastError = `retry budget exhausted after ${attempts} attempts (last error: ${lastError ?? 'unknown'})`;
          this.log('error', 'validator-enabled callback abandoned', {
            sessionId: args.sessionId,
            attempts,
            lastError,
          });
          return { ok: false, attempts, lastError };
        }
        await this.sleep(delay);
      }
      attempts++;
      try {
        const ok = await this.postCallback(url, body, args.sessionId);
        if (ok) {
          this.log('info', 'validator-enabled callback succeeded', {
            sessionId: args.sessionId,
            attempts,
          });
          return { ok: true, attempts };
        }
        lastError = 'non-2xx response';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log('warn', 'validator-enabled callback attempt failed', {
          sessionId: args.sessionId,
          attempt: attempts,
          err: lastError,
        });
      }
    }
    this.log('error', 'validator-enabled callback retry budget exhausted', {
      sessionId: args.sessionId,
      attempts,
      lastError,
    });
    return { ok: false, attempts, lastError };
  }

  private async postCallback(
    url: string,
    body: string,
    sessionId: string,
  ): Promise<boolean> {
    const ac = new AbortController();
    const timer = this.setTimeoutImpl(() => ac.abort(), this.fetchTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.callbackServiceSecret!}`,
          'Idempotency-Key': `${sessionId}:validator-enabled`,
          Origin: this.config.outboundOriginHeader,
        },
        body,
        signal: ac.signal,
      });
    } finally {
      this.clearTimeoutImpl(timer);
    }
    // 2xx and 409-Conflict (idempotent re-post; row already enabled)
    // are both treated as terminal-success. Non-2xx other than 409
    // surfaces as a retryable failure.
    if (res.status === 409) {
      this.log('info', 'callback returned 409 (row already enabled — idempotent)', {
        sessionId,
      });
      return true;
    }
    if (res.ok) return true;
    // Bubble up a structured error message so the retry-loop log
    // captures the status code.
    throw new CallbackError(
      `backend callback returned HTTP ${res.status}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeoutImpl(() => resolve(), ms);
    });
  }
}
