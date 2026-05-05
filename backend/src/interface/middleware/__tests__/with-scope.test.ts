import { describe, it, expect, vi } from 'vitest';
import { withScope, grantsScope } from '../with-scope.js';

describe('grantsScope', () => {
  it('exact match', () => {
    expect(grantsScope(['mcp.read.portfolio'], 'mcp.read.portfolio')).toBe(true);
    expect(grantsScope(['mcp.read.portfolio'], 'mcp.read.audit')).toBe(false);
  });

  it('wildcard suffix', () => {
    expect(grantsScope(['mcp.read.*'], 'mcp.read.portfolio')).toBe(true);
    expect(grantsScope(['mcp.read.*'], 'mcp.read.audit')).toBe(true);
    expect(grantsScope(['mcp.read.*'], 'mcp.read')).toBe(true);
    expect(grantsScope(['mcp.read.*'], 'mcp.write.x')).toBe(false);
  });

  it('global wildcard', () => {
    expect(grantsScope(['*'], 'anything.goes')).toBe(true);
  });

  it('no match across groups', () => {
    expect(grantsScope(['mcp.read.*'], 'mcp.policy.pause')).toBe(false);
  });

  it('multiple grants — any wins', () => {
    expect(grantsScope(['mcp.read.*', 'mcp.policy.pause'], 'mcp.policy.pause')).toBe(true);
  });
});

describe('withScope middleware', () => {
  function makeReqRes(scope: string[] | undefined): {
    req: Record<string, unknown>;
    res: { status: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    inner: ReturnType<typeof vi.fn>;
    invoke: () => Promise<void>;
  } {
    const req = {
      authPayload: { userId: 'u1', sub: 'u1', ...(scope ? { scope } : {}) },
    };
    const res = {
      status: vi.fn(function (this: { _status: number; status: () => unknown }, code: number) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any)._status = code;
        return this;
      }),
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    const inner = vi.fn(async () => {
      /* noop */
    });
    const wrapped = withScope(['mcp.read.*'])(inner);
    return {
      req: req as unknown as Record<string, unknown>,
      res,
      inner,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke: () => wrapped(req as any, res as any),
    };
  }

  it('passes through when scope grants', async () => {
    const { res, inner, invoke } = makeReqRes(['mcp.read.*']);
    await invoke();
    expect(inner).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when scope is missing', async () => {
    const { res, inner, invoke } = makeReqRes(['mcp.policy.*']);
    await invoke();
    expect(inner).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('treats missing scope claim (legacy SIWE token) as all-scopes', async () => {
    const { res, inner, invoke } = makeReqRes(undefined);
    await invoke();
    expect(inner).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects with()-time invalid scope patterns', () => {
    expect(() => withScope([])).toThrow();
    expect(() => withScope([''])).toThrow();
    expect(() => withScope(['has space'])).toThrow();
  });
});
