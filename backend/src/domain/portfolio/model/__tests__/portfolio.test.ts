import { describe, it, expect } from 'vitest';
import { Portfolio, type PortfolioParams } from '../portfolio.js';

function makePortfolioParams(overrides?: Partial<PortfolioParams>): PortfolioParams {
  return {
    id: 'portfolio-1',
    userId: 'user-1',
    tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
    tokenSymbol: 'MHTB',
    ...overrides,
  };
}

describe('Portfolio', () => {
  describe('constructor', () => {
    it('assigns all required fields', () => {
      const params = makePortfolioParams();
      const portfolio = new Portfolio(params);
      expect(portfolio.id).toBe(params.id);
      expect(portfolio.userId).toBe(params.userId);
      expect(portfolio.tokenAddress).toBe(params.tokenAddress);
      expect(portfolio.tokenSymbol).toBe(params.tokenSymbol);
    });

    it('leaves lastSyncedAt undefined when not provided', () => {
      const portfolio = new Portfolio(makePortfolioParams());
      expect(portfolio.lastSyncedAt).toBeUndefined();
    });

    it('assigns lastSyncedAt when provided', () => {
      const syncDate = new Date();
      const portfolio = new Portfolio(makePortfolioParams({ lastSyncedAt: syncDate }));
      expect(portfolio.lastSyncedAt).toBe(syncDate);
    });
  });

  describe('markSynced', () => {
    it('sets lastSyncedAt to current time', () => {
      const portfolio = new Portfolio(makePortfolioParams());
      expect(portfolio.lastSyncedAt).toBeUndefined();

      const before = Date.now();
      portfolio.markSynced();
      const after = Date.now();

      expect(portfolio.lastSyncedAt).toBeInstanceOf(Date);
      expect(portfolio.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(portfolio.lastSyncedAt!.getTime()).toBeLessThanOrEqual(after);
    });
  });
});
