import { describe, it, expect } from 'vitest';
import { RwaToken, type RwaTokenParams } from '../rwa-token.js';

function makeTokenParams(overrides?: Partial<RwaTokenParams>): RwaTokenParams {
  return {
    id: 'token-1',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    name: 'MuHaven Treasury Bill',
    symbol: 'MHTB',
    issuerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    apy: '4.5',
    yieldSchedule: 'monthly',
    kycTier: 1,
    assetClass: 'treasury',
    minInvestment: '1000',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RwaToken', () => {
  describe('constructor', () => {
    it('assigns all required fields', () => {
      const params = makeTokenParams();
      const token = new RwaToken(params);
      expect(token.id).toBe(params.id);
      expect(token.address).toBe(params.address);
      expect(token.name).toBe(params.name);
      expect(token.symbol).toBe(params.symbol);
      expect(token.issuerAddress).toBe(params.issuerAddress);
      expect(token.status).toBe('active');
      expect(token.assetClass).toBe('treasury');
    });

    it('leaves optional fields undefined when not provided', () => {
      const token = new RwaToken(makeTokenParams({
        apy: undefined,
        yieldSchedule: undefined,
        minInvestment: undefined,
        pausedAt: undefined,
        windingDownAt: undefined,
        archivedAt: undefined,
      }));
      expect(token.apy).toBeUndefined();
      expect(token.yieldSchedule).toBeUndefined();
      expect(token.minInvestment).toBeUndefined();
      expect(token.pausedAt).toBeUndefined();
      expect(token.windingDownAt).toBeUndefined();
      expect(token.archivedAt).toBeUndefined();
    });
  });

  describe('lifecycle: canPause', () => {
    it('returns true when active', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(token.canPause()).toBe(true);
    });

    it('returns false when paused', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(token.canPause()).toBe(false);
    });

    it('returns false when winding_down', () => {
      const token = new RwaToken(makeTokenParams({ status: 'winding_down' }));
      expect(token.canPause()).toBe(false);
    });

    it('returns false when archived', () => {
      const token = new RwaToken(makeTokenParams({ status: 'archived' }));
      expect(token.canPause()).toBe(false);
    });
  });

  describe('lifecycle: pause', () => {
    it('transitions from active to paused', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      token.pause();
      expect(token.status).toBe('paused');
      expect(token.pausedAt).toBeInstanceOf(Date);
      expect(token.updatedAt).toBeInstanceOf(Date);
    });

    it('throws when called on paused token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(() => token.pause()).toThrow("Cannot pause token in 'paused' status");
    });

    it('throws when called on winding_down token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'winding_down' }));
      expect(() => token.pause()).toThrow("Cannot pause token in 'winding_down' status");
    });

    it('throws when called on archived token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'archived' }));
      expect(() => token.pause()).toThrow("Cannot pause token in 'archived' status");
    });
  });

  describe('lifecycle: canUnpause', () => {
    it('returns true when paused', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(token.canUnpause()).toBe(true);
    });

    it('returns false when active', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(token.canUnpause()).toBe(false);
    });
  });

  describe('lifecycle: unpause', () => {
    it('transitions from paused to active', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      token.unpause();
      expect(token.status).toBe('active');
    });

    it('throws when called on active token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(() => token.unpause()).toThrow("Cannot unpause token in 'active' status");
    });
  });

  describe('lifecycle: canWindDown', () => {
    it('returns true when active', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(token.canWindDown()).toBe(true);
    });

    it('returns true when paused', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(token.canWindDown()).toBe(true);
    });

    it('returns false when winding_down', () => {
      const token = new RwaToken(makeTokenParams({ status: 'winding_down' }));
      expect(token.canWindDown()).toBe(false);
    });

    it('returns false when archived', () => {
      const token = new RwaToken(makeTokenParams({ status: 'archived' }));
      expect(token.canWindDown()).toBe(false);
    });
  });

  describe('lifecycle: windDown', () => {
    it('transitions from active to winding_down', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      token.windDown();
      expect(token.status).toBe('winding_down');
      expect(token.windingDownAt).toBeInstanceOf(Date);
    });

    it('transitions from paused to winding_down', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      token.windDown();
      expect(token.status).toBe('winding_down');
    });

    it('throws when called on archived token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'archived' }));
      expect(() => token.windDown()).toThrow("Cannot wind down token in 'archived' status");
    });
  });

  describe('lifecycle: canArchive', () => {
    it('returns true when winding_down', () => {
      const token = new RwaToken(makeTokenParams({ status: 'winding_down' }));
      expect(token.canArchive()).toBe(true);
    });

    it('returns false when active', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(token.canArchive()).toBe(false);
    });

    it('returns false when paused', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(token.canArchive()).toBe(false);
    });
  });

  describe('lifecycle: archive', () => {
    it('transitions from winding_down to archived', () => {
      const token = new RwaToken(makeTokenParams({ status: 'winding_down' }));
      token.archive();
      expect(token.status).toBe('archived');
      expect(token.archivedAt).toBeInstanceOf(Date);
    });

    it('throws when called on active token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));
      expect(() => token.archive()).toThrow("Cannot archive token in 'active' status");
    });

    it('throws when called on paused token', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));
      expect(() => token.archive()).toThrow("Cannot archive token in 'paused' status");
    });
  });

  describe('lifecycle: full happy path', () => {
    it('active → paused → active → winding_down → archived', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));

      token.pause();
      expect(token.status).toBe('paused');

      token.unpause();
      expect(token.status).toBe('active');

      token.windDown();
      expect(token.status).toBe('winding_down');

      token.archive();
      expect(token.status).toBe('archived');
    });

    it('active → winding_down → archived (skip pause)', () => {
      const token = new RwaToken(makeTokenParams({ status: 'active' }));

      token.windDown();
      expect(token.status).toBe('winding_down');

      token.archive();
      expect(token.status).toBe('archived');
    });

    it('paused → winding_down → archived (skip unpause)', () => {
      const token = new RwaToken(makeTokenParams({ status: 'paused' }));

      token.windDown();
      expect(token.status).toBe('winding_down');

      token.archive();
      expect(token.status).toBe('archived');
    });
  });

  describe('lifecycle: terminal state', () => {
    it('archived token cannot transition to any state', () => {
      const token = new RwaToken(makeTokenParams({ status: 'archived' }));
      expect(token.canPause()).toBe(false);
      expect(token.canUnpause()).toBe(false);
      expect(token.canWindDown()).toBe(false);
      expect(token.canArchive()).toBe(false);
    });
  });
});
