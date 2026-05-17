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
  formatUsdc6ToDecimal,
  positionBuy,
  positionClaim,
  positionRebalance,
  positionSell,
  type ToolDeps,
} from '../src/tools/handlers.js';
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

// ---------- formatUsdc6ToDecimal ----------

describe('formatUsdc6ToDecimal', () => {
  it.each([
    ['5000000', '5'],
    ['1500000', '1.5'],
    ['1000000', '1'],
    ['100', '0.0001'],
    ['1', '0.000001'],
    ['0', '0'],
    ['999999', '0.999999'],
    ['1000000000', '1000'],
    ['1234567890123456', '1234567890.123456'],
  ])('renders %s base-6 units as %s', (input, expected) => {
    expect(formatUsdc6ToDecimal(input)).toBe(expected);
  });

  it('rejects non-numeric input', () => {
    expect(() => formatUsdc6ToDecimal('5.0')).toThrow(/must be a non-negative integer/);
    expect(() => formatUsdc6ToDecimal('abc')).toThrow();
    expect(() => formatUsdc6ToDecimal('-1')).toThrow();
    expect(() => formatUsdc6ToDecimal('')).toThrow();
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
      { token: 'TBILL1', amountUsdc6: '5000000' } as never,
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

  it('handles 0x-address token verbatim', async () => {
    const addr = '0x8D773C8b3Ea15Eef2E2F1E6f43Ee8d52c7e57b0D';
    const result = await positionBuy(
      { token: addr, amountUsdc6: '1500000' } as never,
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
      { token: 'TBILL1', amountUsdc6: '5000000' } as never,
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
      { token: 'TBILL1', amountUsdc6: '5000000' } as never,
      { backend: stubBackend(), surface: 'mcp' } as ToolDeps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dashboardUrl.startsWith('https://muhaven.app/trade?')).toBe(true);
    }
  });

  it('does NOT require a broker dep — Path C tools talk only to dashboard URL', async () => {
    const result = await positionBuy(
      { token: 'TBILL1', amountUsdc6: '5000000' } as never,
      { backend: stubBackend(), surface: 'mcp', dashboardBaseUrl: 'https://muhaven.app' } as ToolDeps,
    );
    expect(result.ok).toBe(true);
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

  it('rejects non-numeric amountShares with invalid_input', async () => {
    const result = await positionSell(
      { token: 'TBILL1', amountShares: 'all' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_input');
    }
  });

  it('accepts fractional share counts (decimal string)', async () => {
    const result = await positionSell(
      { token: 'TBILL1', amountShares: '2.5' } as never,
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new URL(result.data.dashboardUrl).searchParams.get('shares')).toBe('2.5');
    }
  });
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
