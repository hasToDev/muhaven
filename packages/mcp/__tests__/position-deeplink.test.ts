/**
 * Position + cash handlers — Path C URL response shape (2026-05-18,
 * @muhaven/mcp 0.1.7).
 *
 * Replaces the prior `session-key-required.test.ts` which exercised the
 * broker-probe path. That path was removed when position tools stopped
 * being attestation-only — Path C returns a dashboard deep-link, the
 * user's existing kernel + passkey signs, and the broker is never
 * involved in position writes.
 *
 * Tests asserted here:
 *   - URL shape is correct for every tool (path + query + from=mcp).
 *   - Token identifier accepts both symbols (TBILL1) AND addresses.
 *   - amount in base-6 USDC is rendered as human-readable decimal in
 *     the URL (`5000000` → `amount=5`; `1500000` → `amount=1.5`).
 *   - Optional escrow id deep-links to a highlighted epoch row.
 *   - position.rebalance returns not_implemented with a clear hint.
 *   - cash.wrap returns a `/cash?action=...&amount=...` URL.
 *   - echo block mirrors input for LLM verification.
 *
 * No broker dep needed for these tools — the test harness omits it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildPositionDeeplink,
  cashWrap,
  positionBuy,
  positionClaim,
  positionRebalance,
  positionSell,
  type ToolDeps,
} from '../src/tools/handlers.js';
import {
  CashWrapInputSchema,
  PositionBuyInputSchema,
  PositionSellInputSchema,
} from '../src/tools/schemas.js';
import type { BackendClient } from '../src/clients/backend-client.js';

function stubBackend(): BackendClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as BackendClient;
}

function makeDeps(dashboardBaseUrl = 'https://muhaven.app'): ToolDeps {
  return {
    backend: stubBackend(),
    surface: 'mcp',
    dashboardBaseUrl,
  };
}

// ---------- decimal amount schema (PositionBuyInput / CashWrapInput) ----------
//
// 0.2.0 swapped position.buy from base-6 integer (`amountUsdc6`) to
// human-decimal (`amountUsdc`), matching cash.wrap. The LLM-footgun
// these tests pin: a model hearing "buy 5 dollars" must NOT be able to
// silently encode that as $0.000005 via misinterpreting base-6 units.

describe('decimal mhUSDC amount schema (position.buy + cash.wrap)', () => {
  it.each([
    ['5', true],
    ['0.5', true],
    ['1.5', true],
    ['100', true],
    ['1234.567', true],
    ['1234.567890', true],
    ['0', true],
    ['100.000000', true],
  ])('accepts %s', (raw, valid) => {
    expect(PositionBuyInputSchema.safeParse({ token: 'TBILL1', amountUsdc: raw }).success).toBe(valid);
    expect(CashWrapInputSchema.safeParse({ amountUsdc: raw }).success).toBe(valid);
  });

  it.each([
    ['5.0000001'],     // 7 fractional digits — silent-floor hazard rejected
    ['-1'],            // negative
    ['1e6'],           // scientific notation
    ['+1'],            // signed
    ['abc'],
    [''],
    ['1,000'],         // thousands separator
    ['1.2.3'],
    ['00'],            // leading-zero canonicalization rejected
    ['05'],
    ['.5'],            // leading dot rejected
    ['5.'],            // trailing dot rejected
  ])('rejects %s', (raw) => {
    expect(PositionBuyInputSchema.safeParse({ token: 'TBILL1', amountUsdc: raw }).success).toBe(false);
    expect(CashWrapInputSchema.safeParse({ amountUsdc: raw }).success).toBe(false);
  });

  it('rejects URL-bloat amounts past 48 chars', () => {
    const huge = '1' + '0'.repeat(48); // 49 chars
    expect(PositionBuyInputSchema.safeParse({ token: 'TBILL1', amountUsdc: huge }).success).toBe(false);
  });
});

describe('PositionSellInputSchema rejects fractional shares', () => {
  // fhERC-20 shares are integer base units; pre-fill must NEVER carry
  // "2.5 shares" that would silently floor on the on-chain submit.
  it.each([['1'], ['10'], ['9999']])('accepts integer %s', (raw) => {
    expect(PositionSellInputSchema.safeParse({ token: 'TBILL1', amountShares: raw }).success).toBe(true);
  });
  it.each([['0'], ['2.5'], ['-1'], ['']])('rejects %s', (raw) => {
    expect(PositionSellInputSchema.safeParse({ token: 'TBILL1', amountShares: raw }).success).toBe(false);
  });
});

// ---------- buildPositionDeeplink ----------

describe('buildPositionDeeplink', () => {
  it('buy → /trade?mode=buy with from=mcp marker', () => {
    const url = buildPositionDeeplink('https://muhaven.app', 'buy', {
      token: 'TBILL1',
      amount: '5',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://muhaven.app');
    expect(parsed.pathname).toBe('/trade');
    expect(parsed.searchParams.get('mode')).toBe('buy');
    expect(parsed.searchParams.get('token')).toBe('TBILL1');
    expect(parsed.searchParams.get('amount')).toBe('5');
    expect(parsed.searchParams.get('from')).toBe('mcp');
  });

  it('sell → /trade?mode=sell with shares param', () => {
    const url = buildPositionDeeplink('https://muhaven.app', 'sell', {
      token: 'TBILL1',
      shares: '10',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/trade');
    expect(parsed.searchParams.get('mode')).toBe('sell');
    expect(parsed.searchParams.get('shares')).toBe('10');
  });

  it('claim → /yields (no mode param needed)', () => {
    const url = buildPositionDeeplink('https://muhaven.app', 'claim', {
      token: 'TBILL1',
      epoch: '5',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/yields');
    expect(parsed.searchParams.has('mode')).toBe(false);
    expect(parsed.searchParams.get('epoch')).toBe('5');
  });

  it('wrap → /cash (no mode param needed)', () => {
    const url = buildPositionDeeplink('https://muhaven.app', 'wrap', { amount: '100' });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/cash');
    expect(parsed.searchParams.has('mode')).toBe(false);
    expect(parsed.searchParams.get('amount')).toBe('100');
  });

  it('trims trailing slash on dashboardBaseUrl', () => {
    const url = buildPositionDeeplink('https://muhaven.app/', 'buy', {
      token: 'TBILL1',
      amount: '5',
    });
    expect(url.startsWith('https://muhaven.app/trade?')).toBe(true);
  });

  it('URL-encodes query values (hex-address with mixed case round-trips clean)', () => {
    const addr = '0xABCdef0123456789ABCDef0123456789ABcDEF01';
    const url = buildPositionDeeplink('https://muhaven.app', 'buy', {
      token: addr,
      amount: '5',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBe(addr);
  });

  it('accepts a staging dashboardBaseUrl', () => {
    const url = buildPositionDeeplink('http://localhost:7778', 'buy', {
      token: 'TBILL1',
      amount: '5',
    });
    expect(url.startsWith('http://localhost:7778/trade?')).toBe(true);
  });
});

// ---------- positionBuy handler ----------

describe('positionBuy', () => {
  it('returns dashboardUrl + instructions + echo for a symbol token', async () => {
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc: '5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('buy');
      const url = new URL(result.data.dashboardUrl);
      expect(url.pathname).toBe('/trade');
      expect(url.searchParams.get('token')).toBe('TBILL1');
      expect(url.searchParams.get('amount')).toBe('5');
      expect(url.searchParams.get('mode')).toBe('buy');
      expect(url.searchParams.get('from')).toBe('mcp');
      expect(result.data.instructions).toContain('5 mhUSDC of TBILL1');
      expect(result.data.instructions).toContain(result.data.dashboardUrl);
      expect(result.data.echo).toEqual({
        action: 'buy',
        token: 'TBILL1',
        amount: '5',
      });
    }
  });

  it('handles 0x-address token verbatim with fractional amount', async () => {
    const addr = '0x8D773C8b3Ea15Eef2E2F1E6f43Ee8d52c7e57b0D';
    const result = await positionBuy(
      { token: addr, amountUsdc: '1.5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new URL(result.data.dashboardUrl).searchParams.get('token')).toBe(addr);
      expect(new URL(result.data.dashboardUrl).searchParams.get('amount')).toBe('1.5');
    }
  });

  it('uses provided dashboardBaseUrl (staging override)', async () => {
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc: '5' } as never,
      makeDeps('https://stage.muhaven.app'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dashboardUrl.startsWith('https://stage.muhaven.app/trade?')).toBe(
        true,
      );
    }
  });

  it('falls back to production dashboard URL when dep omits it', async () => {
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc: '5' } as never,
      { backend: stubBackend(), surface: 'mcp' } as ToolDeps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dashboardUrl.startsWith('https://muhaven.app/trade?')).toBe(true);
    }
  });

  it('does NOT require a broker dep — Path C tools talk only to dashboard URL', async () => {
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc: '5' } as never,
      { backend: stubBackend(), surface: 'mcp', dashboardBaseUrl: 'https://muhaven.app' } as ToolDeps,
    );
    expect(result.ok).toBe(true);
  });

  it('preserves human-readable amount verbatim (no base-6 conversion footgun)', async () => {
    // 0.2.0 regression test for Code Reviewer H1: in 0.1.7,
    // positionBuy({amountUsdc6: '5'}) silently produced amount=0.000005
    // (LLM saying "5 dollars" → user buys $5e-6). 0.2.0 takes
    // amountUsdc as human-decimal so "5" means $5. Lock the new behavior.
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc: '5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new URL(result.data.dashboardUrl).searchParams.get('amount')).toBe('5');
      // NOT '0.000005' (the 0.1.7 footgun output)
      expect(new URL(result.data.dashboardUrl).searchParams.get('amount')).not.toBe('0.000005');
    }
  });
});

// ---------- positionSell handler ----------

describe('positionSell', () => {
  it('returns /trade?mode=sell with shares param', async () => {
    const result = await positionSell(
      { token: 'TBILL1', amountShares: '3' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('sell');
      expect(new URL(result.data.dashboardUrl).searchParams.get('mode')).toBe('sell');
      expect(new URL(result.data.dashboardUrl).searchParams.get('shares')).toBe('3');
      expect(result.data.echo).toEqual({
        action: 'sell',
        token: 'TBILL1',
        shares: '3',
      });
    }
  });

  // 0.2.0: fractional shares now REJECTED at the schema boundary (see
  // PositionSellInputSchema regex test above). The handler-level
  // runtime check was deleted because the schema is now the boundary.
  // Bad inputs throw at MCP-server schema-parse time, not inside the
  // handler — these are pinned in the schema describe block above.
});

// ---------- positionClaim handler ----------

describe('positionClaim', () => {
  it('returns /yields URL with token only when escrowId is omitted', async () => {
    const result = await positionClaim(
      { token: 'TBILL1' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.data.dashboardUrl);
      expect(url.pathname).toBe('/yields');
      expect(url.searchParams.get('token')).toBe('TBILL1');
      expect(url.searchParams.has('epoch')).toBe(false);
      expect(result.data.instructions).toContain('your claimable epochs');
    }
  });

  it('adds epoch param when escrowId is provided', async () => {
    const result = await positionClaim(
      { token: 'TBILL1', escrowId: '5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.data.dashboardUrl);
      expect(url.searchParams.get('epoch')).toBe('5');
      expect(result.data.instructions).toContain('epoch #5');
      expect(result.data.echo.epoch).toBe('5');
    }
  });
});

// ---------- positionRebalance handler ----------

describe('positionRebalance', () => {
  it('returns not_implemented with a clear next-step hint', async () => {
    const result = await positionRebalance(
      { legs: [] } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_implemented');
      expect(result.message).toMatch(/Wave 5/);
      expect(result.message).toMatch(/position\.buy/);
    }
  });
});

// ---------- cashWrap handler ----------

describe('cashWrap', () => {
  it('returns /cash URL with amount in USDC human-readable units', async () => {
    const result = await cashWrap(
      { amountUsdc: '100' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('wrap');
      const url = new URL(result.data.dashboardUrl);
      expect(url.pathname).toBe('/cash');
      expect(url.searchParams.get('amount')).toBe('100');
      expect(url.searchParams.get('from')).toBe('mcp');
      expect(result.data.instructions).toContain('100 USDC');
      expect(result.data.instructions).toContain('mhUSDC');
      expect(result.data.echo).toEqual({ action: 'wrap', amount: '100' });
    }
  });

  it('accepts fractional USDC amounts', async () => {
    const result = await cashWrap(
      { amountUsdc: '1.5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new URL(result.data.dashboardUrl).searchParams.get('amount')).toBe('1.5');
    }
  });
});
