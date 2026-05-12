import { describe, expect, it, vi } from 'vitest';
import { createMiniAppApi } from '../src/api.js';

interface FetchInvocation {
  url: string;
  init?: RequestInit;
}

function makeStubFetch(
  responses: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>,
): { fetch: typeof globalThis.fetch; calls: FetchInvocation[] } {
  const calls: FetchInvocation[] = [];
  let i = 0;
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error('no more stubbed responses');
    const body = r.body !== undefined ? JSON.stringify(r.body) : '';
    return Promise.resolve(
      new Response(body, {
        status: r.status,
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      }),
    );
  };
  return { fetch: fetchImpl, calls };
}

const VALID_INTENT = {
  intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
  kind: 'buy' as const,
  tier: 'mini_app_otp' as const,
  status: 'pending' as const,
  amountUsd6: '500000000',
  payload: {
    token: '0x' + 'a'.repeat(40),
    summary: 'Buy 500 mhUSDC of GOLD1',
    issuerLabel: 'GoldVault Issuer',
    escrowId: '42',
  },
  intentHash: '0x' + 'b'.repeat(64),
  expiresAt: '2026-05-07T12:00:00.000Z',
  createdAt: '2026-05-07T11:55:00.000Z',
};

describe('createMiniAppApi.lookupIntent', () => {
  it('POSTs the correct path + body and returns the parsed intent', async () => {
    const { fetch, calls } = makeStubFetch([{ status: 200, body: VALID_INTENT }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    const out = await api.lookupIntent(VALID_INTENT.intentId, 'fake_initData=1');
    expect(out).toEqual(VALID_INTENT);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      'https://api.muhaven.app/api/v1/agent/openclaw/intent/lookup-miniapp',
    );
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      intentId: VALID_INTENT.intentId,
      telegramInitData: 'fake_initData=1',
    });
  });

  it('strips a trailing slash from backendBaseUrl', async () => {
    const { fetch, calls } = makeStubFetch([{ status: 200, body: VALID_INTENT }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app/',
      fetchImpl: fetch,
    });
    await api.lookupIntent(VALID_INTENT.intentId, 'fake');
    expect(calls[0]!.url).toBe(
      'https://api.muhaven.app/api/v1/agent/openclaw/intent/lookup-miniapp',
    );
  });

  it('translates a 404 into a friendly message', async () => {
    const { fetch } = makeStubFetch([{ status: 404, body: { title: 'not found' } }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(
      api.lookupIntent(VALID_INTENT.intentId, 'fake'),
    ).rejects.toThrow(/not found or no longer active/i);
  });

  it('translates other non-2xx into a generic message', async () => {
    const { fetch } = makeStubFetch([{ status: 500 }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(
      api.lookupIntent(VALID_INTENT.intentId, 'fake'),
    ).rejects.toThrow(/Lookup failed \(HTTP 500\)/);
  });
});

describe('createMiniAppApi.confirmIntent', () => {
  it('POSTs to the confirm path with otp + initData (no `source` — server-derived per H-1)', async () => {
    const { fetch, calls } = makeStubFetch([{ status: 200, body: { intent: { status: 'confirmed' } } }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await api.confirmIntent(VALID_INTENT.intentId, '123456', 'fake_initData=1');
    expect(calls[0]!.url).toBe(
      'https://api.muhaven.app/api/v1/agent/openclaw/intent/confirm',
    );
    // 2026-05-12: regression for the 422 "Validation failed" that fired
    // when the body carried `source: 'mini_app'`. Backend DTO is
    // `.strict()` and rejects extra fields; pin the cleaned shape.
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({
      intentId: VALID_INTENT.intentId,
      otp: '123456',
      telegramInitData: 'fake_initData=1',
    });
    expect(body).not.toHaveProperty('source');
  });

  it('surfaces a backend error.title when available', async () => {
    const { fetch } = makeStubFetch([
      { status: 410, body: { title: 'intent expired' } },
    ]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(
      api.confirmIntent(VALID_INTENT.intentId, '123456', 'fake'),
    ).rejects.toThrow(/intent expired/);
  });

  it('falls back to HTTP-status when the body is malformed', async () => {
    const { fetch } = makeStubFetch([
      // Force a JSON-parse error by returning a response whose body is
      // valid JSON-the-string but missing `title`.
      { status: 422, body: { somethingElse: true } },
    ]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(
      api.confirmIntent(VALID_INTENT.intentId, '123456', 'fake'),
    ).rejects.toThrow(/Confirm failed \(HTTP 422\)/);
  });

  it('returns void on 200', async () => {
    const { fetch } = makeStubFetch([{ status: 200, body: { intent: { status: 'confirmed' } } }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(
      api.confirmIntent(VALID_INTENT.intentId, '123456', 'fake'),
    ).resolves.toBeUndefined();
  });
});

describe('createMiniAppApi.denyIntent', () => {
  it('POSTs to the deny path with initData (no `source` — server-derived per H-1)', async () => {
    const { fetch, calls } = makeStubFetch([{ status: 200, body: { intent: { status: 'denied' } } }]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await api.denyIntent(VALID_INTENT.intentId, 'fake_initData=1');
    expect(calls[0]!.url).toBe(
      'https://api.muhaven.app/api/v1/agent/openclaw/intent/deny',
    );
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({
      intentId: VALID_INTENT.intentId,
      telegramInitData: 'fake_initData=1',
    });
    expect(body).not.toHaveProperty('source');
  });

  it('surfaces backend error.title on non-2xx', async () => {
    const { fetch } = makeStubFetch([
      { status: 409, body: { title: 'already consumed' } },
    ]);
    const api = createMiniAppApi({
      backendBaseUrl: 'https://api.muhaven.app',
      fetchImpl: fetch,
    });
    await expect(api.denyIntent(VALID_INTENT.intentId, 'fake')).rejects.toThrow(
      /already consumed/,
    );
  });
});

describe('createMiniAppApi default fetch fallback', () => {
  it('uses globalThis.fetch when fetchImpl is omitted', async () => {
    const stub = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const original = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = stub;
    try {
      const api = createMiniAppApi({ backendBaseUrl: 'https://example.test' });
      await api.lookupIntent(VALID_INTENT.intentId, 'fake').catch(() => undefined);
      expect(stub).toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = original;
    }
  });
});
