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
import { decodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';

export type BundlerClientErrorCode =
  | 'config'
  | 'network'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  | 'rpc_error'
  | 'receipt_timeout'
  | 'chain_mismatch';

/**
 * Canonical EntryPoint v0.7 deployment address (same across every EVM
 * chain — verified against
 * https://github.com/eth-infinitism/account-abstraction/releases v0.7.0).
 * Pinned here so the MCP server never has to look it up at runtime.
 *
 * Used by the bundler-client's nonce read (`getNonce` calls
 * `entryPoint.getNonce(sender, key)` via `eth_call`) and by the
 * handler-side userOp builder when calling viem's
 * `getUserOperationHash`. Operators on a future entry-point rotation
 * override via `MUHAVEN_ENTRY_POINT` env (Wave 5 Path D Slice 1 Commit
 * 3.5 wiring).
 */
export const ENTRY_POINT_07_ADDRESS =
  '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as `0x${string}`;

const ENTRY_POINT_GET_NONCE_ABI = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);

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
 * Wave 5 Path D Slice 1 Commit 3.5 — the unsigned UserOp shape passed
 * to `pm_sponsorUserOperation`. ZeroDev's paymaster fills in the gas
 * limits + paymaster fields and returns them; the caller then composes
 * the full `UserOperationV07Wire` with the placeholder signature
 * replaced by the broker's session-key signature.
 *
 * Optional fields the bundler tolerates being absent: gas + paymaster
 * fields. `signature` is required (use a non-zero high-entropy
 * placeholder so the bundler simulates a worst-case verifier cost).
 */
export interface PartialUserOpForSponsorship {
  readonly sender: `0x${string}`;
  readonly nonce: `0x${string}`;
  readonly callData: `0x${string}`;
  readonly maxFeePerGas: `0x${string}`;
  readonly maxPriorityFeePerGas: `0x${string}`;
  /** Worst-case placeholder so paymaster simulates realistic gas. */
  readonly signature: `0x${string}`;
}

export interface SponsoredUserOpFields {
  readonly paymaster: `0x${string}`;
  readonly paymasterVerificationGasLimit: `0x${string}`;
  readonly paymasterPostOpGasLimit: `0x${string}`;
  readonly paymasterData: `0x${string}`;
  readonly callGasLimit: `0x${string}`;
  readonly verificationGasLimit: `0x${string}`;
  readonly preVerificationGas: `0x${string}`;
}

export interface EstimatedUserOpGas {
  readonly callGasLimit: `0x${string}`;
  readonly verificationGasLimit: `0x${string}`;
  readonly preVerificationGas: `0x${string}`;
}

export interface FeeData {
  readonly maxFeePerGas: `0x${string}`;
  readonly maxPriorityFeePerGas: `0x${string}`;
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
  /**
   * Wave 5 Path D 0.2.3 — `Origin` header sent on every bundler RPC.
   *
   * Why: ZeroDev's bundler URLs gate access via an IP+domain allowlist.
   * Browser requests from `https://muhaven.app` pass because the
   * project's allowlist includes that domain; Node `fetch` (the MCP
   * server's transport) sends no `Origin` header by default and so
   * hits a 403 "Neither IP nor domain is on the allowlist". Sending
   * an `Origin` matching the project's allowlisted domain unblocks
   * the MCP server without requiring an operator-side ZeroDev
   * dashboard edit. Mirrors how ethers.js + viem's HTTP transports
   * stamp a default `Origin` against EVM RPC providers.
   *
   * Defaults to `https://muhaven.app` at the call site
   * (`server.ts::buildMcpServer`) — operators on a custom dashboard
   * URL override via `MUHAVEN_DASHBOARD_URL`.
   */
  readonly originHeader?: string;
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
   * Wave 5 Path D Slice 1 Commit 3.5 — `pm_sponsorUserOperation`.
   * ZeroDev's bundler URL serves both bundler RPCs AND paymaster RPCs
   * at the same endpoint, so we don't need a separate paymaster URL.
   * Returns the paymaster fields + the gas limits the paymaster's
   * simulation computed (the caller doesn't need a separate
   * `estimateUserOpGas` round-trip on the happy path).
   */
  async sponsorUserOp(
    userOp: PartialUserOpForSponsorship,
    entryPoint: `0x${string}`,
  ): Promise<SponsoredUserOpFields> {
    const result = await this.rpc('pm_sponsorUserOperation', [userOp, entryPoint]);
    return parseSponsoredFields(result);
  }

  /**
   * Wave 5 Path D Slice 1 Commit 3.5 — `eth_estimateUserOperationGas`.
   * Not used in the happy path (sponsorship returns gas), but lives as
   * a fallback for unsponsored flows OR if the operator's paymaster
   * goes down. Reading gas separately also makes the failure modes
   * distinguishable for the LLM-facing fallback reasons.
   */
  async estimateUserOpGas(
    userOp: PartialUserOpForSponsorship,
    entryPoint: `0x${string}`,
  ): Promise<EstimatedUserOpGas> {
    const result = await this.rpc('eth_estimateUserOperationGas', [userOp, entryPoint]);
    if (typeof result !== 'object' || result === null) {
      throw new BundlerClientError(
        'invalid_response',
        'eth_estimateUserOperationGas returned non-object',
      );
    }
    const obj = result as Record<string, unknown>;
    return {
      callGasLimit: assertHex(obj.callGasLimit, 'estimateUserOpGas.callGasLimit'),
      verificationGasLimit: assertHex(
        obj.verificationGasLimit,
        'estimateUserOpGas.verificationGasLimit',
      ),
      preVerificationGas: assertHex(
        obj.preVerificationGas,
        'estimateUserOpGas.preVerificationGas',
      ),
    };
  }

  /**
   * Wave 5 Path D Slice 1 Commit 3.5 — `eth_call` against the
   * EntryPoint's `getNonce(sender, key)`. Uses the bundler URL as a
   * full Arb Sepolia node (ZeroDev's bundler accepts read-side RPCs).
   *
   * Pass `key = 0n` for the default nonce key — Path D never uses a
   * non-default key in Slice 1; reserved for batched UserOps in
   * later slices.
   */
  async getNonce(
    sender: `0x${string}`,
    entryPoint: `0x${string}`,
    key: bigint = 0n,
  ): Promise<bigint> {
    const data = encodeFunctionData({
      abi: ENTRY_POINT_GET_NONCE_ABI,
      functionName: 'getNonce',
      args: [sender, key],
    });
    const result = await this.rpc('eth_call', [
      { to: entryPoint, data },
      'latest',
    ]);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
      throw new BundlerClientError(
        'invalid_response',
        `eth_call returned non-hex: ${JSON.stringify(result).slice(0, 80)}`,
      );
    }
    // eth_call returns a uint256 (32 bytes) — decode via abi.
    const [nonce] = decodeAbiParameters([{ type: 'uint256' }], result as Hex);
    return nonce as bigint;
  }

  /**
   * Wave 5 Path D Slice 1 Commit 3.5 — fetch the fee market via
   * `eth_gasPrice` (returns a single value the bundler will accept for
   * both maxFee + maxPriorityFee on Arb Sepolia, which has effectively
   * no priority-vs-base distinction).
   *
   * Simple-on-purpose: a full EIP-1559 fee market read would need two
   * RPCs (`eth_maxPriorityFeePerGas` + `eth_getBlock`); Arb Sepolia's
   * fee dynamics don't require that precision and the paymaster pays
   * either way. A future caller wanting EIP-1559 precision can add a
   * sibling method.
   */
  async getFeeData(): Promise<FeeData> {
    const result = await this.rpc('eth_gasPrice', []);
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
      throw new BundlerClientError(
        'invalid_response',
        `eth_gasPrice returned non-hex: ${JSON.stringify(result).slice(0, 80)}`,
      );
    }
    // 2x safety margin (sponsor pays; Arb Sepolia fee oscillations are
    // small but the safety margin defends against a fee spike between
    // estimate and submit).
    const base = BigInt(result);
    const margined = base * 2n;
    const hex = `0x${margined.toString(16)}` as `0x${string}`;
    return { maxFeePerGas: hex, maxPriorityFeePerGas: hex };
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
      // The `Origin` header is the load-bearing piece for ZeroDev's
      // domain-allowlist (see `BundlerClientOptions.originHeader`
      // JSDoc). Omitted only if the caller explicitly disables it via
      // `originHeader: ''` — empty string falls through to the bare
      // headers shape, matching ethers.js's behaviour for tests.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (this.options.originHeader) {
        headers['origin'] = this.options.originHeader;
      }
      res = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers,
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

/**
 * Wave 5 Path D Slice 1 Commit 3.5 — strict parser for
 * `pm_sponsorUserOperation` results. ZeroDev returns the seven gas +
 * paymaster fields together; we refuse to proceed if any are missing
 * so a future paymaster shape drift surfaces as `invalid_response`
 * rather than a downstream `AA23 reverted`.
 */
function parseSponsoredFields(raw: unknown): SponsoredUserOpFields {
  if (typeof raw !== 'object' || raw === null) {
    throw new BundlerClientError(
      'invalid_response',
      'pm_sponsorUserOperation returned non-object',
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    paymaster: assertHexAddress(obj.paymaster, 'sponsoredFields.paymaster'),
    paymasterVerificationGasLimit: assertHexNonZero(
      obj.paymasterVerificationGasLimit,
      'sponsoredFields.paymasterVerificationGasLimit',
      MAX_PAYMASTER_GAS_LIMIT,
    ),
    paymasterPostOpGasLimit: assertHexNonZero(
      obj.paymasterPostOpGasLimit,
      'sponsoredFields.paymasterPostOpGasLimit',
      MAX_PAYMASTER_GAS_LIMIT,
    ),
    // paymasterData is the only sponsored field that can legitimately
    // be empty (`0x`) — paymasters with no per-op data return that.
    paymasterData: assertHex(obj.paymasterData, 'sponsoredFields.paymasterData'),
    callGasLimit: assertHexNonZero(
      obj.callGasLimit,
      'sponsoredFields.callGasLimit',
      MAX_CALL_GAS_LIMIT,
    ),
    verificationGasLimit: assertHexNonZero(
      obj.verificationGasLimit,
      'sponsoredFields.verificationGasLimit',
      MAX_VERIFICATION_GAS_LIMIT,
    ),
    preVerificationGas: assertHexNonZero(
      obj.preVerificationGas,
      'sponsoredFields.preVerificationGas',
      MAX_PRE_VERIFICATION_GAS,
    ),
  };
}

function assertHex(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    // `JSON.stringify(undefined)` is undefined and would throw on `.slice`
    // — surface a stable string for both undefined AND structured values.
    // Regex also enforces EVEN hex length (each byte = 2 hex chars) —
    // an odd-length hex string is malformed (Code Reviewer L-3).
    const repr =
      value === undefined ? 'undefined' : JSON.stringify(value);
    const safe = typeof repr === 'string' ? repr.slice(0, 80) : 'unknown';
    throw new BundlerClientError(
      'invalid_response',
      `${label} must be a 0x-prefixed hex string (got ${safe})`,
    );
  }
  return value as `0x${string}`;
}

/**
 * Wave 5 Path D Slice 1 Commit 3.5 (Code Reviewer M-3) — gas-limit
 * fields must be non-empty AND parse to a non-zero bigint. The bundler
 * returning `0x` or `0x0` for a gas limit would cause `AA23 reverted`
 * on submit; surface as `invalid_response` here instead.
 *
 * `maxValue` (SecEng round-2 MED-3) — refuse implausibly-large gas
 * values that a malicious/buggy bundler might return. Per-buy realistic
 * ceiling on Arb Sepolia is ~500k-2M; 10x headroom is enough for any
 * future expansion. Without a cap, the userOp could spike into a
 * guaranteed-revert range OR cause the operator's paymaster credit to
 * burn faster than expected.
 */
function assertHexNonZero(
  value: unknown,
  label: string,
  maxValue?: bigint,
): `0x${string}` {
  const hex = assertHex(value, label);
  // Reject empty (`0x`) AND all-zero hex strings.
  if (hex.length === 2 || BigInt(hex) === 0n) {
    throw new BundlerClientError(
      'invalid_response',
      `${label} must be a non-zero hex value (got "${hex}")`,
    );
  }
  if (maxValue !== undefined && BigInt(hex) > maxValue) {
    throw new BundlerClientError(
      'invalid_response',
      `${label} = ${BigInt(hex)} exceeds plausible ceiling ${maxValue} — refusing to sign + submit`,
    );
  }
  return hex;
}

/**
 * SecEng round-2 MED-3 plausibility ceilings on bundler-returned gas
 * fields. Per-buy realistic gas on Arb Sepolia: call ~500k-2M,
 * verification ~500k-2M, preVerification ~50k-200k. 10x ceilings here.
 * Paymaster fields are typically much smaller.
 */
const MAX_CALL_GAS_LIMIT = 20_000_000n;
const MAX_VERIFICATION_GAS_LIMIT = 20_000_000n;
const MAX_PRE_VERIFICATION_GAS = 5_000_000n;
const MAX_PAYMASTER_GAS_LIMIT = 5_000_000n;

/**
 * Wave 5 Path D Slice 1 Commit 3.5 — paymaster address must be a
 * proper 20-byte hex (not `0x` or some other shape that `assertHex`
 * would accept).
 */
function assertHexAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const repr =
      value === undefined ? 'undefined' : JSON.stringify(value);
    const safe = typeof repr === 'string' ? repr.slice(0, 80) : 'unknown';
    throw new BundlerClientError(
      'invalid_response',
      `${label} must be a 0x-prefixed 20-byte hex address (got ${safe})`,
    );
  }
  return value as `0x${string}`;
}
