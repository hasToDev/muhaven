/**
 * ERC-4337 v0.7 bundler JSON-RPC client. Lives in the MCP SERVER (not
 * the broker daemon) because submission is a network-egress action and
 * the broker is bound by the R-1 zero-egress invariant (see
 * `broker/protocol.ts` JSDoc + THREAT_MODEL_P0.md §"Lethal-trifecta
 * self-audit"). The broker signs hashes; the MCP server (which already
 * speaks HTTPS to the backend) speaks JSON-RPC to the bundler.
 *
 * Wave 5 Path D Slice 1 (Commit 3) scope: the BundlerClient surface +
 * tests ship now, even though the actual UserOp build is deferred to
 * Commit 3.5 (the FHE encrypt + kernel-execute encoding pieces have
 * unresolved design points — see PATH_D_PLAN.md Commit 3 scope-cut).
 *
 * Three RPCs in scope:
 *  - `eth_sendUserOperation(userOp, entryPoint)` → returns
 *    `userOpHash: Hex32`.
 *  - `eth_getUserOperationReceipt(userOpHash)` → returns receipt or
 *    `null` when the userOp hasn't been bundled into a block yet.
 *  - `eth_chainId()` → returns the bundler's view of the chain id;
 *    used to detect operator misconfiguration (wrong network).
 *
 * Trust model: the bundler is a network peer; treat its responses as
 * untrusted input. Every parse step throws a structured BundlerClientError
 * on shape mismatch — never silently coerces. RPC errors (`{code, message,
 * data}`) surface as `rpc_error` with the upstream `code` preserved so the
 * host LLM can map known bundler error classes (`AA21`, `AA23`, etc.)
 * without parsing message text.
 */

import { setTimeout as delay } from 'node:timers/promises';

export type BundlerClientErrorCode =
  | 'config'
  | 'network'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  | 'rpc_error'
  | 'receipt_timeout'
  | 'chain_mismatch';

export class BundlerClientError extends Error {
  constructor(
    readonly code: BundlerClientErrorCode,
    message: string,
    /** Optional structured detail — for rpc_error, the upstream JSON-RPC
     *  error object (e.g. `{ code: -32600, message: "AA23 reverted", data: ... }`).
     *  Surface fields that help the LLM steer; never the raw upstream
     *  fields (they may carry implementation-specific data). */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BundlerClientError';
  }
}

/**
 * EIP-4337 v0.7 packed UserOperation as accepted by `eth_sendUserOperation`.
 * Bigint-valued fields are hex strings on the wire (`0x` + ≤64 hex).
 *
 * We accept a permissive shape (Record<string, string>) at the client
 * boundary — the caller (Commit 3.5 UserOp builder) is responsible for
 * stringifying its bigints. The client validates `0x`-prefix shape only;
 * deeper shape correctness is the bundler's job to enforce.
 */
export interface UserOperationV07Wire {
  readonly sender: `0x${string}`;
  readonly nonce: `0x${string}`;
  readonly factory?: `0x${string}`;
  readonly factoryData?: `0x${string}`;
  readonly callData: `0x${string}`;
  readonly callGasLimit: `0x${string}`;
  readonly verificationGasLimit: `0x${string}`;
  readonly preVerificationGas: `0x${string}`;
  readonly maxFeePerGas: `0x${string}`;
  readonly maxPriorityFeePerGas: `0x${string}`;
  readonly paymaster?: `0x${string}`;
  readonly paymasterVerificationGasLimit?: `0x${string}`;
  readonly paymasterPostOpGasLimit?: `0x${string}`;
  readonly paymasterData?: `0x${string}`;
  readonly signature: `0x${string}`;
}

/**
 * Receipt shape as returned by `eth_getUserOperationReceipt`. Subset
 * we depend on; bundlers commonly return additional fields we ignore.
 */
export interface UserOperationReceipt {
  readonly userOpHash: `0x${string}`;
  readonly sender: `0x${string}`;
  readonly success: boolean;
  /** Bundler-reported revert reason (string or hex); present on failure. */
  readonly reason?: string;
  /** The underlying L1/L2 tx that bundled this UserOp. */
  readonly receipt: {
    readonly transactionHash: `0x${string}`;
    readonly blockNumber: `0x${string}`;
    readonly blockHash: `0x${string}`;
  };
}

export interface BundlerClientOptions {
  /** Bundler RPC endpoint — MUHAVEN_BUNDLER_URL. https-or-loopback validated
   *  at config-load time (see `config.ts::validatePublicUrlEnv`). */
  readonly endpoint: string;
  /** Per-RPC HTTP timeout (ms). Default 15s — same as backend client. */
  readonly requestTimeoutMs: number;
  /** Expected chain id (Arb Sepolia = 421614). When set, `assertChainId()`
   *  refuses to proceed if the bundler reports a different chain. */
  readonly expectedChainId?: number;
  /** Inject for tests. */
  readonly fetchImpl?: typeof fetch;
}

export class BundlerClient {
  private readonly fetchImpl: typeof fetch;
  private nextRpcId = 1;

  constructor(private readonly options: BundlerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Submit a signed UserOperation. Returns the userOpHash the bundler
   * computed (which must match the hash the broker signed — caller is
   * responsible for the consistency check; broker policy snapshot
   * captures the signer-binding piece).
   */
  async sendUserOp(
    userOp: UserOperationV07Wire,
    entryPoint: `0x${string}`,
  ): Promise<`0x${string}`> {
    const result = await this.rpc('eth_sendUserOperation', [userOp, entryPoint]);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
      throw new BundlerClientError(
        'invalid_response',
        `eth_sendUserOperation returned non-hash result: ${JSON.stringify(result).slice(0, 80)}`,
      );
    }
    return result.toLowerCase() as `0x${string}`;
  }

  /** Return the receipt for a userOpHash, or null when the UserOp has
   *  not yet been bundled. */
  async getReceipt(
    userOpHash: `0x${string}`,
  ): Promise<UserOperationReceipt | null> {
    const result = await this.rpc('eth_getUserOperationReceipt', [userOpHash]);
    if (result === null || result === undefined) return null;
    return parseReceipt(result);
  }

  /**
   * Poll until the bundler returns a receipt, or `timeoutMs` elapses.
   * Caller decides retry / fallback behaviour on `receipt_timeout`.
   *
   * Poll interval grows linearly from `initialIntervalMs` to
   * `maxIntervalMs` to avoid burning the bundler quota when blocks are
   * slow. Default tuning: 500ms → 2000ms over the first 6 polls; then
   * pinned at 2000ms.
   */
  async waitForReceipt(
    userOpHash: `0x${string}`,
    opts: {
      readonly timeoutMs: number;
      readonly initialIntervalMs?: number;
      readonly maxIntervalMs?: number;
      /** Inject for tests that want deterministic timing. */
      readonly clockMs?: () => number;
      readonly sleep?: (ms: number) => Promise<void>;
    },
  ): Promise<UserOperationReceipt> {
    const clock = opts.clockMs ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms) => delay(ms));
    const initial = opts.initialIntervalMs ?? 500;
    const max = opts.maxIntervalMs ?? 2_000;
    const deadline = clock() + opts.timeoutMs;
    let attempt = 0;
    // First check is immediate — the userOp may already be bundled.
    // Subsequent checks back off.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const receipt = await this.getReceipt(userOpHash);
      if (receipt) return receipt;
      const now = clock();
      if (now >= deadline) {
        throw new BundlerClientError(
          'receipt_timeout',
          `no receipt for userOp ${userOpHash} within ${opts.timeoutMs}ms`,
        );
      }
      const interval = Math.min(max, initial + attempt * 250);
      const remaining = Math.max(0, deadline - now);
      await sleep(Math.min(interval, remaining));
      attempt++;
    }
  }

  /**
   * Verify the bundler's reported chainId matches `expectedChainId`. Cheap
   * to call once at MCP server boot (or lazily before the first send) so
   * a misconfigured bundler URL surfaces as `chain_mismatch` before any
   * user-facing send rather than after a guaranteed-failing submit.
   *
   * Throws `BundlerClientError(config)` if no `expectedChainId` is set —
   * caller asked for an assert without configuring the expectation.
   */
  async assertChainId(): Promise<void> {
    if (this.options.expectedChainId === undefined) {
      throw new BundlerClientError(
        'config',
        'assertChainId called without expectedChainId configured',
      );
    }
    const result = await this.rpc('eth_chainId', []);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
      throw new BundlerClientError(
        'invalid_response',
        `eth_chainId returned non-hex result: ${JSON.stringify(result).slice(0, 80)}`,
      );
    }
    const reported = Number.parseInt(result, 16);
    if (reported !== this.options.expectedChainId) {
      throw new BundlerClientError(
        'chain_mismatch',
        `bundler reports chainId ${reported}, MCP expected ${this.options.expectedChainId}`,
        { reportedChainId: reported, expectedChainId: this.options.expectedChainId },
      );
    }
  }

  private async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.nextRpcId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.options.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        throw new BundlerClientError('timeout', `bundler ${method} timed out`);
      }
      throw new BundlerClientError(
        'network',
        `bundler ${method} network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Drain body for the error message, defensively bounded.
      let text = '';
      try {
        text = (await res.text()).slice(0, 256);
      } catch {
        // ignore
      }
      throw new BundlerClientError(
        'http_error',
        `bundler ${method} → HTTP ${res.status}: ${text}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new BundlerClientError(
        'invalid_response',
        `bundler ${method} returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new BundlerClientError(
        'invalid_response',
        `bundler ${method} returned non-object`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.error !== undefined && obj.error !== null) {
      const err = obj.error as Record<string, unknown>;
      throw new BundlerClientError(
        'rpc_error',
        `bundler ${method} rpc error: ${typeof err.message === 'string' ? err.message : '<no message>'}`,
        { code: err.code, message: err.message, data: err.data },
      );
    }
    return obj.result;
  }
}

/**
 * Strict receipt shape parser. Throws `BundlerClientError` on missing
 * required fields. Keeps the receipt narrow — fields not in our
 * `UserOperationReceipt` shape are intentionally dropped so a future
 * malicious or buggy bundler can't smuggle extra data into the LLM's
 * context.
 */
function parseReceipt(raw: unknown): UserOperationReceipt {
  if (typeof raw !== 'object' || raw === null) {
    throw new BundlerClientError('invalid_response', 'receipt is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const userOpHash = obj.userOpHash;
  if (typeof userOpHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(userOpHash)) {
    throw new BundlerClientError('invalid_response', 'receipt.userOpHash malformed');
  }
  const sender = obj.sender;
  if (typeof sender !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    throw new BundlerClientError('invalid_response', 'receipt.sender malformed');
  }
  if (typeof obj.success !== 'boolean') {
    throw new BundlerClientError('invalid_response', 'receipt.success must be a boolean');
  }
  const inner = obj.receipt;
  if (typeof inner !== 'object' || inner === null) {
    throw new BundlerClientError('invalid_response', 'receipt.receipt missing');
  }
  const innerObj = inner as Record<string, unknown>;
  const txHash = innerObj.transactionHash;
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new BundlerClientError(
      'invalid_response',
      'receipt.receipt.transactionHash malformed',
    );
  }
  const blockNumber = innerObj.blockNumber;
  if (typeof blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(blockNumber)) {
    throw new BundlerClientError(
      'invalid_response',
      'receipt.receipt.blockNumber malformed',
    );
  }
  const blockHash = innerObj.blockHash;
  if (typeof blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new BundlerClientError(
      'invalid_response',
      'receipt.receipt.blockHash malformed',
    );
  }
  return {
    userOpHash: userOpHash.toLowerCase() as `0x${string}`,
    sender: sender.toLowerCase() as `0x${string}`,
    success: obj.success,
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
    receipt: {
      transactionHash: txHash.toLowerCase() as `0x${string}`,
      blockNumber: blockNumber.toLowerCase() as `0x${string}`,
      blockHash: blockHash.toLowerCase() as `0x${string}`,
    },
  };
}
