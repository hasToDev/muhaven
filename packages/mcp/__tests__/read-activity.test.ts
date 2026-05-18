/**
 * 0.2.1 — `muhaven.read.activity` proxies `/api/v1/activity`. Closes the
 * Path-C verification gap: re-calling `read.portfolio` after a buy of
 * a token already held returns the same shape (no signal); the activity
 * feed gives one row per on-chain event with tx hash + timestamp.
 *
 * Tests pinned here:
 *   - Default call (no input) → GETs /api/v1/activity with no query params
 *   - limit + offset pass through to backend query
 *   - Backend error mapping (auth, server) is uniform with other read.*
 */
import { describe, expect, it, vi } from 'vitest';
import { readActivity, type ToolDeps } from '../src/tools/handlers.js';
import { BackendError } from '../src/clients/backend-client.js';
import type { BackendClient } from '../src/clients/backend-client.js';

function makeDeps(backend: BackendClient): ToolDeps {
  return {
    backend,
    surface: 'mcp',
    dashboardBaseUrl: 'https://muhaven.app',
  };
}

function backendReturning(payload: unknown): BackendClient {
  return {
    get: vi.fn().mockResolvedValue(payload),
    getUnauth: vi.fn().mockResolvedValue(payload),
    post: vi.fn(),
  } as unknown as BackendClient;
}

function backendThrowing(err: unknown): BackendClient {
  return {
    get: vi.fn().mockRejectedValue(err),
    getUnauth: vi.fn().mockRejectedValue(err),
    post: vi.fn(),
  } as unknown as BackendClient;
}

describe('readActivity', () => {
  it('returns the backend payload verbatim on success', async () => {
    const samplePayload = {
      items: [
        {
          id: '0xabc123:0',
          type: 'buy',
          status: 'confirmed',
          token_address: '0xtbill',
          amount: null,
          timestamp: '2026-05-18T10:42:00.000Z',
          tx_hash: '0xabc123',
          reference_id: null,
          metadata: null,
        },
      ],
      has_more: false,
    };
    const backend = backendReturning(samplePayload);
    const result = await readActivity({}, makeDeps(backend));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(samplePayload);
    }
    expect(backend.get).toHaveBeenCalledWith('/api/v1/activity', {
      limit: undefined,
      offset: undefined,
    });
  });

  it('forwards limit + offset query params to the backend', async () => {
    const backend = backendReturning({ items: [], has_more: false });
    await readActivity({ limit: 10, offset: 20 }, makeDeps(backend));
    expect(backend.get).toHaveBeenCalledWith('/api/v1/activity', {
      limit: 10,
      offset: 20,
    });
  });

  it('preserves the privacy invariant in the proxied response (amount stays null)', async () => {
    // The backend's GetActivityUseCase forces every row's amount to
    // null. This test pins that the MCP relay doesn't accidentally
    // synthesize or default a value.
    const backend = backendReturning({
      items: [
        { id: '1', type: 'buy', status: 'confirmed', amount: null, tx_hash: '0xabc' },
      ],
      has_more: false,
    });
    const result = await readActivity({}, makeDeps(backend));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const items = (result.data as { items: Array<{ amount: unknown }> }).items;
      expect(items[0]?.amount).toBeNull();
    }
  });

  it('maps backend unauthorized to AUTH_REQUIRED (uniform with other read.* handlers)', async () => {
    const backend = backendThrowing(
      new BackendError('unauthorized', 'GET /api/v1/activity → 401', 401),
    );
    const result = await readActivity({}, makeDeps(backend));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AUTH_REQUIRED');
    }
  });

  it('maps backend 500 to backend.server_error', async () => {
    const backend = backendThrowing(
      new BackendError('server_error', 'GET /api/v1/activity → 500', 500),
    );
    const result = await readActivity({}, makeDeps(backend));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('backend.server_error');
    }
  });
});
