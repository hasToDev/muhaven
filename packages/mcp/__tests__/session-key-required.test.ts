import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  positionBuy,
  positionClaim,
  __resetSessionKeyProbeCacheForTests,
  type ToolDeps,
} from '../src/tools/handlers.js';
import { BrokerClientError } from '../src/clients/broker-client.js';
import type { BrokerClient } from '../src/clients/broker-client.js';
import type { BackendClient } from '../src/clients/backend-client.js';

function stubBackend(): BackendClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as BackendClient;
}

function brokerWithHasSessionKey(value: boolean): BrokerClient {
  return {
    hello: vi.fn().mockResolvedValue({
      type: 'hello',
      version: '0.3.0',
      sessionKeyAddress: value
        ? '0x1111111111111111111111111111111111111111'
        : '0x0000000000000000000000000000000000000000',
      hasJwt: false,
      hasSessionKey: value,
      effectiveConfig: {
        backendBaseUrl: 'https://api.muhaven.app',
        dashboardBaseUrl: 'https://muhaven.app',
      },
    }),
    signHash: vi.fn().mockImplementation(async () => {
      if (!value) {
        throw new BrokerClientError(
          'broker_error',
          'session_key_unavailable: daemon booted in read-only posture',
        );
      }
      return {
        type: 'sign_hash',
        signature: ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`,
        signerAddress: '0x1111111111111111111111111111111111111111' as const,
      };
    }),
  } as unknown as BrokerClient;
}

describe('signEnvelope — SESSION_KEY_REQUIRED probe', () => {
  beforeEach(() => {
    __resetSessionKeyProbeCacheForTests();
  });
  afterEach(() => {
    __resetSessionKeyProbeCacheForTests();
  });

  it('positionBuy returns SESSION_KEY_REQUIRED when daemon is read-only', async () => {
    const broker = brokerWithHasSessionKey(false);
    const deps: ToolDeps = {
      backend: stubBackend(),
      broker,
      surface: 'mcp',
      dashboardBaseUrl: 'https://stage.muhaven.app',
    };
    const result = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: 1_000_000n.toString() } as never,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SESSION_KEY_REQUIRED');
      expect((result as { mintUrl: string }).mintUrl).toBe(
        'https://stage.muhaven.app/agent/policy/transition',
      );
    }
    // signHash should NOT have been called — the probe short-circuits.
    expect(broker.signHash).not.toHaveBeenCalled();
  });

  it('positionClaim returns SESSION_KEY_REQUIRED when daemon is read-only', async () => {
    const broker = brokerWithHasSessionKey(false);
    const deps: ToolDeps = {
      backend: stubBackend(),
      broker,
      surface: 'mcp',
    };
    const result = await positionClaim(
      { token: '0xabc' as `0x${string}` } as never,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SESSION_KEY_REQUIRED');
      // Falls back to the prod dashboard URL when dashboardBaseUrl is omitted.
      expect((result as { mintUrl: string }).mintUrl).toBe(
        'https://muhaven.app/agent/policy/transition',
      );
    }
  });

  it('positionBuy successfully signs when daemon has a session key', async () => {
    const broker = brokerWithHasSessionKey(true);
    const deps: ToolDeps = {
      backend: stubBackend(),
      broker,
      surface: 'mcp',
    };
    const result = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: 1_000_000n.toString() } as never,
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.brokerSignature).toMatch(/^0x[a-f0-9]+$/);
    }
    expect(broker.signHash).toHaveBeenCalledOnce();
  });

  it('safety net maps a sign_hash session_key_unavailable to SESSION_KEY_REQUIRED', async () => {
    // Simulate a daemon that reports hasSessionKey=true at hello time
    // but throws session_key_unavailable at sign_hash time (extremely
    // unlikely in practice — daemon can't change posture without restart
    // — but the safety net needs to be tested anyway).
    const broker = {
      hello: vi.fn().mockResolvedValue({
        type: 'hello',
        version: '0.3.0',
        sessionKeyAddress: '0x1111111111111111111111111111111111111111',
        hasJwt: false,
        hasSessionKey: true,
        effectiveConfig: {
          backendBaseUrl: 'https://api.muhaven.app',
          dashboardBaseUrl: 'https://muhaven.app',
        },
      }),
      signHash: vi.fn().mockRejectedValue(
        new BrokerClientError(
          'broker_error',
          'session_key_unavailable: daemon transitioned to read-only',
        ),
      ),
    } as unknown as BrokerClient;
    const deps: ToolDeps = { backend: stubBackend(), broker, surface: 'mcp' };
    const result = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: 1_000_000n.toString() } as never,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SESSION_KEY_REQUIRED');
  });

  it('caches the probe result across calls within the same process', async () => {
    const broker = brokerWithHasSessionKey(true);
    const deps: ToolDeps = { backend: stubBackend(), broker, surface: 'mcp' };
    await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
      deps,
    );
    await positionClaim({ token: '0xabc' as `0x${string}` } as never, deps);
    // hello called only on the FIRST signEnvelope call; the second one
    // reuses the cached `hasSessionKey=true`.
    expect(broker.hello).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent first-call probes into a single hello round-trip', async () => {
    // Without Promise-based caching, two simultaneous signEnvelope calls
    // before the cache resolves would each kick off their own broker.hello().
    // The cache stores the in-flight Promise; both callers await it.
    let resolveHello: ((v: unknown) => void) | null = null;
    const helloPending = new Promise((resolve) => {
      resolveHello = resolve;
    });
    const broker = {
      hello: vi.fn().mockReturnValue(helloPending),
      signHash: vi.fn().mockResolvedValue({
        type: 'sign_hash',
        signature: ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`,
        signerAddress: '0x1111111111111111111111111111111111111111' as const,
      }),
    } as unknown as BrokerClient;
    const deps: ToolDeps = { backend: stubBackend(), broker, surface: 'mcp' };
    // Fire 3 concurrent calls BEFORE resolving hello.
    const calls = [
      positionBuy(
        { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
        deps,
      ),
      positionBuy(
        { token: '0xabc' as `0x${string}`, amountUsdc6: '2000000' } as never,
        deps,
      ),
      positionClaim({ token: '0xabc' as `0x${string}` } as never, deps),
    ];
    // Resolve hello with hasSessionKey=true. All 3 calls now proceed to signHash.
    resolveHello!({
      type: 'hello',
      version: '0.3.0',
      sessionKeyAddress: '0x1111111111111111111111111111111111111111',
      hasJwt: false,
      hasSessionKey: true,
    });
    const results = await Promise.all(calls);
    for (const r of results) expect(r.ok).toBe(true);
    // The critical assertion: hello was called EXACTLY ONCE despite 3
    // concurrent first-callers.
    expect(broker.hello).toHaveBeenCalledOnce();
    expect(broker.signHash).toHaveBeenCalledTimes(3);
  });

  it('retries the probe after a rejected first attempt (broker recovery)', async () => {
    // First call fails (broker down). Cache must NOT pin the rejection —
    // a subsequent call should retry instead of seeing the same error forever.
    const broker = {
      hello: vi
        .fn()
        .mockRejectedValueOnce(new BrokerClientError('connect_failed', 'broker down'))
        .mockResolvedValue({
          type: 'hello',
          version: '0.3.0',
          sessionKeyAddress: '0x1111111111111111111111111111111111111111',
          hasJwt: false,
          hasSessionKey: true,
        }),
      signHash: vi.fn().mockResolvedValue({
        type: 'sign_hash',
        signature: ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`,
        signerAddress: '0x1111111111111111111111111111111111111111' as const,
      }),
    } as unknown as BrokerClient;
    const deps: ToolDeps = { backend: stubBackend(), broker, surface: 'mcp' };
    const first = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
      deps,
    );
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('broker.connect_failed');
    // Second call: broker is back, hello returns hasSessionKey=true,
    // signHash succeeds.
    const second = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
      deps,
    );
    expect(second.ok).toBe(true);
    expect(broker.hello).toHaveBeenCalledTimes(2);
  });

  it('does NOT pin a rejected probe across concurrent retries (eager clear)', async () => {
    // Code Reviewer M1: if two callers enter signEnvelope while the FIRST
    // probe is still pending, and the probe then rejects, BOTH should see
    // the rejection (sharing the in-flight promise is intentional — they
    // hit the same broker hop together) AND a THIRD caller arriving AFTER
    // the rejection should re-issue, not see the stale Promise. With the
    // eager-clear-in-IIFE pattern, the cache slot is null by the time the
    // rejection propagates to `await`-ers.
    let rejectHello: ((e: Error) => void) | null = null;
    const helloPending = new Promise((_resolve, reject) => {
      rejectHello = reject;
    });
    let helloCallCount = 0;
    const recoveredHello = {
      type: 'hello' as const,
      version: '0.3.0',
      sessionKeyAddress:
        '0x1111111111111111111111111111111111111111' as `0x${string}`,
      hasJwt: false,
      hasSessionKey: true,
    };
    const broker = {
      hello: vi.fn().mockImplementation(() => {
        helloCallCount++;
        if (helloCallCount === 1) return helloPending;
        return Promise.resolve(recoveredHello);
      }),
      signHash: vi.fn().mockResolvedValue({
        type: 'sign_hash',
        signature: ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`,
        signerAddress: '0x1111111111111111111111111111111111111111' as const,
      }),
    } as unknown as BrokerClient;
    const deps: ToolDeps = { backend: stubBackend(), broker, surface: 'mcp' };
    // Caller A starts; cache slot now holds the in-flight Promise.
    const a = positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
      deps,
    );
    // Caller B starts in the same microtask — shares the slot.
    const b = positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '2000000' } as never,
      deps,
    );
    rejectHello!(new BrokerClientError('connect_failed', 'broker down'));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    // Caller C arrives AFTER the rejection has propagated. Slot is null.
    const c = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '3000000' } as never,
      deps,
    );
    expect(c.ok).toBe(true);
    expect(helloCallCount).toBe(2); // first call rejected, second succeeded
  });

  it('sessionKeyRequiredPayload mintUrl strips a trailing slash on dashboardBaseUrl', async () => {
    const broker = brokerWithHasSessionKey(false);
    const deps: ToolDeps = {
      backend: stubBackend(),
      broker,
      surface: 'mcp',
      dashboardBaseUrl: 'https://stage.muhaven.app/',
    };
    const result = await positionBuy(
      { token: '0xabc' as `0x${string}`, amountUsdc6: '1000000' } as never,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { mintUrl: string }).mintUrl).toBe(
        'https://stage.muhaven.app/agent/policy/transition',
      );
    }
  });
});
