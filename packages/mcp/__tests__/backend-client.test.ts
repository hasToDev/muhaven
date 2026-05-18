import { describe, it, expect, vi } from 'vitest';
import { BackendClient, BackendError } from '../src/clients/backend-client.js';

function makeJwtSource(jwt = 'a.b.c'): {
  get: () => Promise<string>;
  invalidate: () => void;
} {
  return {
    get: async () => jwt,
    invalidate: vi.fn(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BackendClient', () => {
  it('GET success returns parsed body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: 1 }));
    const client = new BackendClient({
      baseUrl: 'https://b.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: makeJwtSource() as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
    });
    const out = await client.get<{ ok: number }>('/x');
    expect(out.ok).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects when host is not in allowedHosts', async () => {
    const client = new BackendClient({
      baseUrl: 'https://other.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: makeJwtSource() as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
    });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'host_not_allowed' });
  });

  it('rejects relative path without leading slash', async () => {
    const client = new BackendClient({
      baseUrl: 'https://b.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: makeJwtSource() as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
    });
    await expect(client.get('x')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('401 → invalidate + retry once → propagate if still 401', async () => {
    const jwtSource = makeJwtSource();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no' }, 401));
    const client = new BackendClient({
      baseUrl: 'https://b.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: jwtSource as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
    });
    await expect(client.get('/x')).rejects.toBeInstanceOf(BackendError);
    expect(jwtSource.invalidate).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('postUnauth omits Authorization header', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_u: URL, init?: RequestInit) => {
      captured = init;
      return jsonResponse({});
    });
    const client = new BackendClient({
      baseUrl: 'https://b.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: makeJwtSource() as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
    });
    await client.postUnauth('/x', { y: 1 });
    expect(captured?.headers).toBeDefined();
    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  // 0.2.1: positionBuy's NAV-resolution path hits the public
  // `/api/v1/tokens` endpoint, so the MCP needs a GET that does NOT
  // attach the Bearer header. Without this, the broker's JwtSource
  // would be called on every NAV lookup — failing AUTH_REQUIRED for
  // a not-yet-logged-in user (H1 in the multi-agent review).
  it('getUnauth omits Authorization header and does not consult JwtSource', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_u: URL, init?: RequestInit) => {
      captured = init;
      return jsonResponse({ tokens: [] });
    });
    const jwtSource = makeJwtSource();
    const jwtSpy = vi.spyOn(jwtSource, 'get');
    const client = new BackendClient({
      baseUrl: 'https://b.example.com',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jwtSource: jwtSource as any,
      timeoutMs: 5000,
      allowedHosts: ['b.example.com'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
    });
    const result = await client.getUnauth<{ tokens: unknown[] }>('/api/v1/tokens');
    expect(result.tokens).toEqual([]);
    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    // The handler MUST NOT call JwtSource.get() — the whole point of
    // getUnauth is to skip the auth-token acquisition path.
    expect(jwtSpy).not.toHaveBeenCalled();
  });
});
