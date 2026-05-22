/**
 * Tests for `fetchJwtSubjectHint` — the Bug #5 helper that enriches
 * `no_active_session_key` fallback messages with the broker JWT's
 * subject so an operator can distinguish "mirror genuinely empty for
 * my user" from "broker JWT is for a different user." Best-effort: any
 * failure (no broker, missing JWT, malformed JWT, IPC throw) returns
 * null instead of bubbling — the LLM-visible message degrades to the
 * original generic form.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchJwtSubjectHint, type ToolDeps } from '../src/tools/handlers.js';
import type { BackendClient } from '../src/clients/backend-client.js';
import type { BrokerClient } from '../src/clients/broker-client.js';

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeBackend(): BackendClient {
  return {} as BackendClient;
}

function makeDeps(broker?: BrokerClient): ToolDeps {
  return {
    backend: makeBackend(),
    surface: 'mcp',
    ...(broker ? { broker } : {}),
  };
}

describe('fetchJwtSubjectHint', () => {
  it('returns null when deps.broker is undefined', async () => {
    const hint = await fetchJwtSubjectHint(makeDeps());
    expect(hint).toBeNull();
  });

  it('returns null when broker.getJwt resolves with jwt: null (operator never logged in)', async () => {
    const broker = {
      getJwt: vi.fn().mockResolvedValue({ type: 'get_jwt', jwt: null, expiresAtSec: null }),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBeNull();
  });

  it('returns truncated subject when broker.getJwt returns a well-formed JWT', async () => {
    const jwt = fakeJwt({ sub: '4b488b44-b13b-4ccb-b419-a1b801fe8814', exp: 1779465597 });
    const broker = {
      getJwt: vi.fn().mockResolvedValue({ type: 'get_jwt', jwt, expiresAtSec: 1779465597 }),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBe('4b488b44…8814');
  });

  it('returns "(missing)" when JWT lacks a sub claim', async () => {
    const jwt = fakeJwt({ exp: 0 });
    const broker = {
      getJwt: vi.fn().mockResolvedValue({ type: 'get_jwt', jwt, expiresAtSec: null }),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBe('(missing)');
  });

  it('swallows broker IPC errors and returns null (no thrown rejection)', async () => {
    const broker = {
      getJwt: vi.fn().mockRejectedValue(new Error('broker socket closed')),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBeNull();
  });

  it('swallows malformed-JWT decode errors and returns null', async () => {
    const broker = {
      getJwt: vi.fn().mockResolvedValue({
        type: 'get_jwt',
        jwt: 'not-a-real-jwt-just-two-segments.x',
        expiresAtSec: null,
      }),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBeNull();
  });

  it('handles short subjects without truncation', async () => {
    const jwt = fakeJwt({ sub: 'shortsub' });
    const broker = {
      getJwt: vi.fn().mockResolvedValue({ type: 'get_jwt', jwt, expiresAtSec: null }),
    } as unknown as BrokerClient;
    const hint = await fetchJwtSubjectHint(makeDeps(broker));
    expect(hint).toBe('shortsub');
  });
});
