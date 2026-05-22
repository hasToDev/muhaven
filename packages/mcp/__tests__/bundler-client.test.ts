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
import { describe, it, expect } from 'vitest';
import {
  BundlerClient,
  BundlerClientError,
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
