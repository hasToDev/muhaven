import { describe, expect, it } from 'vitest';

import {
  buildSuggestions,
  FALLBACK_SUGGESTIONS,
} from '../suggestion-builder.js';

/**
 * Wave 4 P2 follow-up — pin the chip-mapping rules. The frontend
 * ActionCard reads the chips emitted by `chat-llm.service.ts` from
 * the SSE `suggestions` event; this suite locks the per-outcome
 * rules so a "Wrap mhUSDC" prompt never silently rotates back to
 * the static "Show portfolio breakdown" fallback.
 */

describe('buildSuggestions', () => {
  it('returns the wrap path for INSUFFICIENT_MHUSDC errors', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_propose_buy',
      lastError:
        'INSUFFICIENT_MHUSDC: this wallet has no mhUSDC history yet. Wrap USDC into mhUSDC on the Cash page before buying TBILL1.',
    });
    expect(items[0].label).toMatch(/wrap/i);
    expect(items.some((i) => /wrap/i.test(i.label))).toBe(true);
    expect(items[0].variant).toBe('primary');
  });

  it('returns the wrap path for empty portfolio_summary', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_portfolio_summary',
      lastResult: { totalPositions: 0, positions: [], signals: { note: '' } },
    });
    expect(items.some((i) => /wrap/i.test(i.label))).toBe(true);
  });

  it('returns the buy path for a successful quote with shares', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_quote',
      lastResult: {
        tokenSymbol: 'TBILL1',
        navUsd6: '1000000',
        estimatedShares: '100',
      },
    });
    expect(items[0].label).toBe('Buy 100 TBILL1');
    expect(items[0].variant).toBe('primary');
    expect(items.some((i) => /quote.*different/i.test(i.label))).toBe(true);
  });

  it('returns post-buy chips after a successful propose_buy (no buy-again echo)', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_propose_buy',
      lastResult: { kind: 'buy', preview: { shares: '100', tokenSymbol: 'TBILL1' } },
    });
    expect(items.some((i) => /buy/i.test(i.label))).toBe(false);
    expect(items.some((i) => /portfolio/i.test(i.label))).toBe(true);
  });

  it('returns recovery chips for "no NAV / archived / paused" errors', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_quote',
      lastError: 'No NAV snapshot indexed for TBILL1; quote unavailable.',
    });
    expect(items.some((i) => /available/i.test(i.label) || /portfolio/i.test(i.label))).toBe(true);
  });

  it('returns resume chips after a successful pause', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_pause',
      lastResult: { kind: 'pause' },
    });
    expect(items[0].label).toMatch(/resume/i);
  });

  it('falls back when no branch matches', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_unseal_position',
      lastResult: { handle: '0x' + 'a'.repeat(64) },
    });
    expect(items).toEqual(FALLBACK_SUGGESTIONS);
  });

  it('returns the buy path even when shares are missing (degraded quote response)', () => {
    const items = buildSuggestions({
      lastTool: 'muhaven_quote',
      lastResult: { tokenSymbol: 'TBILL1', estimatedShares: '100' },
    });
    expect(items[0].label).toBe('Buy 100 TBILL1');
  });
});
