/**
 * Wave 5 Path D Slice 1 Commit 3 — unit tests for the new ERC-4337
 * bundler JSON-RPC client. Uses a mock fetch (queued response or
 * function impl) so tests don't depend on a real bundler.
 *
 * Coverage:
 *  - sendUserOp happy + non-hash response
 *  - getReceipt null (not bundled) + populated
 *  - waitForReceipt: succeeds, times out
 *  - assertChainId: match / mismatch / missing expectedChainId
 *  - JSON-RPC error envelope → rpc_error
 *  - HTTP non-2xx → http_error
 *  - Non-JSON body → invalid_response
 *  - Receipt shape validation (rejects missing fields)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BundlerClient,
  BundlerClientError,
  ENTRY_POINT_07_ADDRESS,
  type PartialUserOpForSponsorship,
  type UserOperationV07Wire,
} from '../src/clients/bundler-client.js';

const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rawResponse(text: string, init?: { status?: number; contentType?: string }): Response {
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { 'content-type': init?.contentType ?? 'text/plain' },
  });
}

function makeMockFetch(impl: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const req = new Request(url, init);
    return impl(req);
  }) as typeof fetch;
}

function userOpFixture(): UserOperationV07Wire {
  return {
    sender: ('0x' + 'a'.repeat(40)) as `0x${string}`,
    nonce: '0x1',
    callData: '0x',
    callGasLimit: '0x186a0',
    verificationGasLimit: '0x186a0',
    preVerificationGas: '0x5208',
    maxFeePerGas: '0x59682f00',
    maxPriorityFeePerGas: '0x59682f00',
    signature: ('0x' + 'b'.repeat(130)) as `0x${string}`,
  };
}

function receiptFixture(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    userOpHash: '0x' + '1'.repeat(64),
    sender: '0x' + 'a'.repeat(40),
    success: true,
    receipt: {
      transactionHash: '0x' + 'c'.repeat(64),
      blockNumber: '0x10',
      blockHash: '0x' + 'd'.repeat(64),
    },
    ...overrides,
  };
}

describe('BundlerClient.sendUserOp', () => {
  it('returns the userOpHash on success', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string; params: unknown[] };
      expect(body.method).toBe('eth_sendUserOperation');
      expect(body.params[1]).toBe(ENTRY_POINT);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' + '1'.repeat(64) });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const hash = await client.sendUserOp(userOpFixture(), ENTRY_POINT);
    expect(hash).toBe('0x' + '1'.repeat(64));
  });

  it('rejects non-hash result with invalid_response', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'not-a-hash' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(client.sendUserOp(userOpFixture(), ENTRY_POINT)).rejects.toMatchObject({
      name: 'BundlerClientError',
      code: 'invalid_response',
    });
  });

  it('surfaces JSON-RPC error envelope as rpc_error with upstream detail', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'AA23 reverted', data: 'something' },
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    try {
      await client.sendUserOp(userOpFixture(), ENTRY_POINT);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BundlerClientError);
      const e = err as BundlerClientError;
      expect(e.code).toBe('rpc_error');
      expect(e.detail).toMatchObject({ code: -32602, message: 'AA23 reverted' });
    }
  });

  it('returns http_error on non-2xx', async () => {
    const fetchImpl = makeMockFetch(async () =>
      rawResponse('upstream down', { status: 503 }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(client.sendUserOp(userOpFixture(), ENTRY_POINT)).rejects.toMatchObject({
      code: 'http_error',
    });
  });

  it('returns invalid_response on non-JSON body', async () => {
    const fetchImpl = makeMockFetch(async () =>
      rawResponse('<html>oops</html>', { status: 200, contentType: 'text/html' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(client.sendUserOp(userOpFixture(), ENTRY_POINT)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('returns timeout when the bundler stalls past requestTimeoutMs', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      // Simulate a stall by waiting on the signal then "throwing" an
      // AbortError the way real fetch does on timeout.
      await new Promise<void>((_, reject) => {
        req.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      // unreachable
      return jsonResponse({});
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 30,
      fetchImpl,
    });
    await expect(client.sendUserOp(userOpFixture(), ENTRY_POINT)).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('BundlerClient.getReceipt', () => {
  it('returns null when bundler reports null (not bundled yet)', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: null }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const r = await client.getReceipt(('0x' + '1'.repeat(64)) as `0x${string}`);
    expect(r).toBeNull();
  });

  it('parses a well-formed receipt', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: receiptFixture() }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const r = await client.getReceipt(('0x' + '1'.repeat(64)) as `0x${string}`);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.receipt.transactionHash).toBe('0x' + 'c'.repeat(64));
    expect(r!.receipt.blockNumber).toBe('0x10');
  });

  it('lowercases hex fields in the parsed receipt', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          userOpHash: '0x' + 'A'.repeat(64),
          sender: '0x' + 'B'.repeat(40),
          success: true,
          receipt: {
            transactionHash: '0x' + 'C'.repeat(64),
            blockNumber: '0xAB',
            blockHash: '0x' + 'D'.repeat(64),
          },
        },
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const r = await client.getReceipt(('0x' + '1'.repeat(64)) as `0x${string}`);
    expect(r!.userOpHash).toMatch(/^0x[a-f0-9]+$/);
    expect(r!.receipt.transactionHash).toMatch(/^0x[a-f0-9]+$/);
    expect(r!.receipt.blockNumber).toBe('0xab');
  });

  it('rejects receipt missing transactionHash', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: receiptFixture({ receipt: { blockNumber: '0x10', blockHash: '0x' + 'd'.repeat(64) } }),
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(
      client.getReceipt(('0x' + '1'.repeat(64)) as `0x${string}`),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects receipt with non-boolean success', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: receiptFixture({ success: 'maybe' }),
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(
      client.getReceipt(('0x' + '1'.repeat(64)) as `0x${string}`),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('BundlerClient.waitForReceipt', () => {
  it('returns the receipt as soon as it appears', async () => {
    let calls = 0;
    const fetchImpl = makeMockFetch(async () => {
      calls++;
      if (calls < 3) {
        return jsonResponse({ jsonrpc: '2.0', id: calls, result: null });
      }
      return jsonResponse({ jsonrpc: '2.0', id: calls, result: receiptFixture() });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    // Mocked clock + sleep so the test runs synchronously.
    let now = 0;
    const sleeps: number[] = [];
    const receipt = await client.waitForReceipt(
      ('0x' + '1'.repeat(64)) as `0x${string}`,
      {
        timeoutMs: 10_000,
        initialIntervalMs: 100,
        maxIntervalMs: 500,
        clockMs: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );
    expect(receipt.success).toBe(true);
    // 2 null polls before the receipt → 2 sleeps.
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
  });

  it('throws receipt_timeout when no receipt appears within the deadline', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: null }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    let now = 0;
    await expect(
      client.waitForReceipt(('0x' + '1'.repeat(64)) as `0x${string}`, {
        timeoutMs: 200,
        clockMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toMatchObject({ code: 'receipt_timeout' });
  });
});

describe('BundlerClient.assertChainId', () => {
  it('returns when bundler reports the expected chainId', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string };
      expect(body.method).toBe('eth_chainId');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' /* 421614 */ });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(client.assertChainId()).resolves.toBeUndefined();
  });

  it('throws chain_mismatch with structured detail on wrong chain', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' /* 1 = mainnet */ }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    try {
      await client.assertChainId();
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BundlerClientError);
      const e = err as BundlerClientError;
      expect(e.code).toBe('chain_mismatch');
      expect(e.detail).toMatchObject({ reportedChainId: 1, expectedChainId: 421614 });
    }
  });

  it('throws config when expectedChainId is not set', async () => {
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl: makeMockFetch(async () => jsonResponse({})),
    });
    await expect(client.assertChainId()).rejects.toMatchObject({ code: 'config' });
  });

  it('rejects non-hex chainId result with invalid_response', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'not-hex' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(client.assertChainId()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

// ── Wave 5 Path D Slice 1 Commit 3.5 — new sponsor / estimate / nonce / fee surface ──

function partialUserOpFixture(): PartialUserOpForSponsorship {
  return {
    sender: ('0x' + 'a'.repeat(40)) as `0x${string}`,
    nonce: '0x1',
    callData: '0xdeadbeef',
    maxFeePerGas: '0x59682f00',
    maxPriorityFeePerGas: '0x59682f00',
    signature: ('0x' + 'fe'.repeat(86)) as `0x${string}`,
  };
}

function sponsoredFixture(): Record<string, string> {
  return {
    paymaster: '0x' + '99'.repeat(20),
    paymasterVerificationGasLimit: '0x0186a0',
    paymasterPostOpGasLimit: '0x0186a0',
    paymasterData: '0xabcd',
    callGasLimit: '0x030d40',
    verificationGasLimit: '0x030d40',
    preVerificationGas: '0x5208',
  };
}

describe('BundlerClient.sponsorUserOp', () => {
  // 0.2.4: sponsorUserOp now calls `zd_sponsorUserOperation` (ZeroDev's
  // RPC name) with the wrapped param shape `[{chainId, userOp,
  // entryPointAddress, shouldOverrideFee, shouldConsume}]`. The legacy
  // `pm_sponsorUserOperation` method is not exposed by ZeroDev v3
  // endpoints (they proxy through Alchemy which returns "Unsupported
  // method"). Verified 2026-05-23 via direct curl against
  // `https://rpc.zerodev.app/api/v3/<id>/chain/<chain>`.

  it('calls zd_sponsorUserOperation with the wrapped param shape', async () => {
    const captured: { method?: string; params?: unknown[] } = {};
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string; params: unknown[] };
      captured.method = body.method;
      captured.params = body.params;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: sponsoredFixture() });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    const out = await client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS);
    expect(captured.method).toBe('zd_sponsorUserOperation');
    // Wrapped envelope (NOT positional [userOp, entryPoint]).
    expect(captured.params).toHaveLength(1);
    const env = captured.params![0] as Record<string, unknown>;
    expect(env.chainId).toBe(421614);
    expect(env.entryPointAddress).toBe(ENTRY_POINT_07_ADDRESS);
    expect(env.shouldOverrideFee).toBe(false);
    expect(env.shouldConsume).toBe(true);
    expect(env.userOp).toMatchObject({ sender: partialUserOpFixture().sender });
    expect(out.paymaster).toBe('0x' + '99'.repeat(20));
    expect(out.callGasLimit).toBe('0x030d40');
  });

  it('defaults the gas-limit fields on the userOp envelope when the caller omits them', async () => {
    // ZeroDev's request-side Zod validator requires callGasLimit /
    // verificationGasLimit / preVerificationGas to be present even
    // though it recomputes them in simulation. The fixture's
    // PartialUserOpForSponsorship shape doesn't carry them — the
    // client must inject conservative placeholders so the request
    // shape validates.
    const captured: { userOp?: Record<string, string> } = {};
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { params: { userOp: Record<string, string> }[] };
      captured.userOp = body.params[0].userOp;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: sponsoredFixture() });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    // Use the minimal partial (no gas fields).
    await client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS);
    expect(captured.userOp?.callGasLimit).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(captured.userOp?.verificationGasLimit).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(captured.userOp?.preVerificationGas).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('refuses to call when expectedChainId is not configured (config error)', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: sponsoredFixture() }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      // expectedChainId intentionally omitted.
      fetchImpl,
    });
    await expect(
      client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS),
    ).rejects.toMatchObject({ code: 'config' });
  });

  it('rejects a sponsored response missing a required field', async () => {
    const fetchImpl = makeMockFetch(async () => {
      const fields = sponsoredFixture();
      delete (fields as Record<string, unknown>).paymasterData;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: fields });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(
      client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts paymasterData = "0x" (paymasters with no per-op data return empty)', async () => {
    // CR round-2 M-6 — symmetric test that the assertHex-vs-
    // assertHexNonZero split is correctly applied. paymasterData uses
    // assertHex (lax: empty 0x is fine), the gas fields use
    // assertHexNonZero (strict: must be non-empty + non-zero).
    const fetchImpl = makeMockFetch(async () => {
      const fields = { ...sponsoredFixture(), paymasterData: '0x' };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: fields });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    const out = await client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS);
    expect(out.paymasterData).toBe('0x');
  });

  it('refuses a sponsored response whose callGasLimit exceeds the plausibility ceiling', async () => {
    // SecEng round-2 MED-3 — a malicious / buggy bundler can return a
    // gas limit beyond reasonable per-buy headroom. Refuse before
    // signing the hash that includes those fields.
    const fetchImpl = makeMockFetch(async () => {
      const fields = {
        ...sponsoredFixture(),
        callGasLimit: ('0x' + (50_000_000n).toString(16).padStart(2, '0')) as `0x${string}`,
      };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: fields });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(
      client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('surfaces upstream zd_sponsorUserOperation rpc errors as rpc_error with the code preserved', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32500, message: 'project rate-limited', data: null },
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    try {
      await client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS);
      expect.fail('expected throw');
    } catch (err) {
      const e = err as BundlerClientError;
      expect(e.code).toBe('rpc_error');
      expect(e.detail).toMatchObject({ code: -32500 });
    }
  });
});

describe('BundlerClient.estimateUserOpGas', () => {
  it('returns the three gas fields on success', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string };
      expect(body.method).toBe('eth_estimateUserOperationGas');
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          callGasLimit: '0x030d40',
          verificationGasLimit: '0x030d40',
          preVerificationGas: '0x5208',
        },
      });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const gas = await client.estimateUserOpGas(
      partialUserOpFixture(),
      ENTRY_POINT_07_ADDRESS,
    );
    expect(gas.callGasLimit).toBe('0x030d40');
    expect(gas.preVerificationGas).toBe('0x5208');
  });

  it('rejects a non-object response', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'not-an-object' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(
      client.estimateUserOpGas(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('BundlerClient.getNonce', () => {
  it('decodes a uint256 nonce from eth_call', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string; params: unknown[] };
      expect(body.method).toBe('eth_call');
      expect(body.params[1]).toBe('latest');
      // 5 as uint256 (zero-padded big-endian)
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: '0x' + '0'.repeat(63) + '5',
      });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const nonce = await client.getNonce(
      ('0x' + 'a'.repeat(40)) as `0x${string}`,
      ENTRY_POINT_07_ADDRESS,
      0n,
    );
    expect(nonce).toBe(5n);
  });

  it('refuses a non-hex eth_call response', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'not-hex' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(
      client.getNonce(
        ('0x' + 'a'.repeat(40)) as `0x${string}`,
        ENTRY_POINT_07_ADDRESS,
        0n,
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('BundlerClient.getFeeData', () => {
  it('returns 2x-margined hex for both maxFeePerGas and maxPriorityFeePerGas', async () => {
    const fetchImpl = makeMockFetch(async (req) => {
      const body = (await req.json()) as { method: string };
      expect(body.method).toBe('eth_gasPrice');
      // 0x10 = 16; 2x = 32 = 0x20
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x10' });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const data = await client.getFeeData();
    expect(data.maxFeePerGas).toBe('0x20');
    expect(data.maxPriorityFeePerGas).toBe('0x20');
  });

  it('refuses a non-hex gas price', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'not-hex' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    await expect(client.getFeeData()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('BundlerClient.drainTrace — ring buffer for inline echo diagnostic (0.2.8)', () => {
  it('returns an empty trace on a fresh client', async () => {
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl: makeMockFetch(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' })),
    });
    expect(client.drainTrace()).toEqual([]);
  });

  it('captures a successful RPC into the trace', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await client.assertChainId();
    const trace = client.drainTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0].method).toBe('eth_chainId');
    expect(trace[0].responseStatus).toBe(200);
    expect(trace[0].responseBody).toContain('0x66eee');
    expect(trace[0].error).toBeUndefined();
    expect(trace[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('drain returns the trace AND clears it (next call sees empty)', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await client.assertChainId();
    expect(client.drainTrace()).toHaveLength(1);
    expect(client.drainTrace()).toHaveLength(0);
  });

  it('captures HTTP error responses with status + body', async () => {
    const fetchImpl = makeMockFetch(async () => new Response('not found', { status: 404 }));
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(client.getFeeData()).rejects.toBeInstanceOf(BundlerClientError);
    const trace = client.drainTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0].method).toBe('eth_gasPrice');
    expect(trace[0].responseStatus).toBe(404);
    expect(trace[0].responseBody).toBe('not found');
    expect(trace[0].error).toMatchObject({ code: 'http_error' });
  });

  it('captures RPC-error responses (e.g. paymaster AA23) with the upstream message', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'AA23 reverted during simulation' },
      }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(
      client.sponsorUserOp(partialUserOpFixture(), ENTRY_POINT_07_ADDRESS),
    ).rejects.toBeInstanceOf(BundlerClientError);
    const trace = client.drainTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0].method).toBe('zd_sponsorUserOperation');
    expect(trace[0].responseBody).toContain('AA23 reverted');
    expect(trace[0].error).toMatchObject({ code: 'rpc_error' });
  });

  it('is bounded to 20 events (older entries shift off)', async () => {
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    for (let i = 0; i < 25; i++) {
      await client.assertChainId();
    }
    const trace = client.drainTrace();
    expect(trace).toHaveLength(20);
    // Newest entries at the end; first surviving id should be the 6th
    // call (call ids 1..5 dropped).
    expect(trace[0].id).toBe(6);
    expect(trace[19].id).toBe(25);
  });
});

describe('BundlerClient verbose logging (MUHAVEN_MCP_VERBOSE)', () => {
  // 0.2.7 — every bundler RPC writes one request line + one response
  // line to stderr when MUHAVEN_MCP_VERBOSE=1. Default-off so normal
  // smokes stay quiet; flip on for triage to see exact wire payloads
  // instead of curl repro.
  let originalVerbose: string | undefined;
  let stderrCalls: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    originalVerbose = process.env.MUHAVEN_MCP_VERBOSE;
    stderrCalls = [];
    // Cast through unknown to satisfy the overloaded write signature.
    (process.stderr.write as unknown) = (chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (originalVerbose === undefined) delete process.env.MUHAVEN_MCP_VERBOSE;
    else process.env.MUHAVEN_MCP_VERBOSE = originalVerbose;
  });

  it('emits request + response lines when MUHAVEN_MCP_VERBOSE=1', async () => {
    process.env.MUHAVEN_MCP_VERBOSE = '1';
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await client.assertChainId();
    const joined = stderrCalls.join('');
    expect(joined).toMatch(/\[bundler→\] eth_chainId/);
    expect(joined).toMatch(/\[bundler←\] eth_chainId/);
    expect(joined).toContain('0x66eee');
  });

  it('stays silent when MUHAVEN_MCP_VERBOSE is unset', async () => {
    delete process.env.MUHAVEN_MCP_VERBOSE;
    const fetchImpl = makeMockFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await client.assertChainId();
    expect(stderrCalls.join('')).not.toMatch(/\[bundler/);
  });

  it('logs http_error responses when verbose', async () => {
    process.env.MUHAVEN_MCP_VERBOSE = '1';
    const fetchImpl = makeMockFetch(
      async () => new Response('not found', { status: 404 }),
    );
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      expectedChainId: 421614,
      fetchImpl,
    });
    await expect(client.getFeeData()).rejects.toBeInstanceOf(BundlerClientError);
    expect(stderrCalls.join('')).toMatch(/HTTP 404/);
  });
});

describe('BundlerClient.originHeader (ZeroDev allowlist defense)', () => {
  // Regression — 2026-05-23 smoke surfaced ZeroDev bundler URLs returning
  // 403 "Neither IP nor domain is on the allowlist" against the MCP
  // server's Node-fetch traffic. Browser requests from
  // `https://muhaven.app` pass because the project's allowlist accepts
  // that domain; Node `fetch` sends no Origin by default. The fix sends
  // an Origin header matching the dashboard URL on every bundler RPC.

  it('sends `Origin: <originHeader>` on every RPC when set', async () => {
    const capturedOrigins: (string | null)[] = [];
    const fetchImpl = makeMockFetch(async (req) => {
      capturedOrigins.push(req.headers.get('origin'));
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      originHeader: 'https://muhaven.app',
      expectedChainId: 421614,
      fetchImpl,
    });
    await client.assertChainId();
    await client.getFeeData();
    expect(capturedOrigins).toEqual(['https://muhaven.app', 'https://muhaven.app']);
  });

  it('omits the Origin header when not configured', async () => {
    let capturedOrigin: string | null | undefined;
    const fetchImpl = makeMockFetch(async (req) => {
      capturedOrigin = req.headers.get('origin');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      fetchImpl,
      // originHeader intentionally absent — pre-0.2.3 behaviour
    });
    await client.getFeeData();
    expect(capturedOrigin).toBeNull();
  });

  it('omits the Origin header when explicitly set to empty string', async () => {
    let capturedOrigin: string | null | undefined;
    const fetchImpl = makeMockFetch(async (req) => {
      capturedOrigin = req.headers.get('origin');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x66eee' });
    });
    const client = new BundlerClient({
      endpoint: 'http://localhost:4337',
      requestTimeoutMs: 5_000,
      originHeader: '',
      fetchImpl,
    });
    await client.getFeeData();
    expect(capturedOrigin).toBeNull();
  });
});
