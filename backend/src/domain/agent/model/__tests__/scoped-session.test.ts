import { describe, it, expect } from 'vitest';
import { ScopedSession } from '../scoped-session.js';
import { ScopedSessionStatus } from '../scoped-session-status.enum.js';
import { Surface } from '../surface.enum.js';

const BASE_PROPS = {
  sessionId: 'abc123',
  userId: 'u1',
  surface: Surface.MCP,
  status: ScopedSessionStatus.Active,
  signerAddress: '0xaaaa000000000000000000000000000000000001' as `0x${string}`,
  permissionId: null,
  targetContracts: ['0xbbbb000000000000000000000000000000000002' as `0x${string}`],
  selectorCaps: [
    {
      selector: '0xdeadbeef' as `0x${string}`,
      capArgIndex: 2,
      maxAmount: '1000000',
    },
  ],
  maxPerOpUsd6: 100_000_000n,
  totalSpentUsd6: 0n,
  validUntilSec: 2_000_000_000,
  mintedAtSec: 1_000_000_000,
  consentActionHash: null,
  consentTextSha256: null,
  mintedAt: new Date('2026-05-22T00:00:00.000Z'),
  revokedAt: null,
  expiredAt: null,
};

describe('ScopedSession — domain entity', () => {
  describe('isActive(nowSec)', () => {
    it('returns true when status=active AND validUntilSec > nowSec', () => {
      const session = new ScopedSession(BASE_PROPS);
      expect(session.isActive(1_500_000_000)).toBe(true);
    });

    it('returns false when validUntilSec equals nowSec (strict >)', () => {
      const session = new ScopedSession({ ...BASE_PROPS, validUntilSec: 1_500 });
      expect(session.isActive(1_500)).toBe(false);
    });

    it('returns false when validUntilSec already passed', () => {
      const session = new ScopedSession({ ...BASE_PROPS, validUntilSec: 1_000 });
      expect(session.isActive(2_000)).toBe(false);
    });

    it('returns false when status=revoked even if not expired', () => {
      const session = new ScopedSession({
        ...BASE_PROPS,
        status: ScopedSessionStatus.Revoked,
        revokedAt: new Date(),
      });
      expect(session.isActive(1_500_000_000)).toBe(false);
    });

    it('returns false when status=expired even if validUntilSec in future', () => {
      // An operator/cron could mark expired before the real cutoff; isActive
      // must respect the row's terminal status rather than re-deriving from
      // the clock.
      const session = new ScopedSession({
        ...BASE_PROPS,
        status: ScopedSessionStatus.Expired,
        expiredAt: new Date(),
      });
      expect(session.isActive(1_500_000_000)).toBe(false);
    });
  });

  describe('with(patch)', () => {
    it('returns a new instance with patched fields, immutability preserved', () => {
      const original = new ScopedSession(BASE_PROPS);
      const revoked = original.with({
        status: ScopedSessionStatus.Revoked,
        revokedAt: new Date('2026-05-23T00:00:00.000Z'),
      });
      expect(original.status).toBe(ScopedSessionStatus.Active);
      expect(original.revokedAt).toBeNull();
      expect(revoked.status).toBe(ScopedSessionStatus.Revoked);
      expect(revoked.revokedAt).toEqual(new Date('2026-05-23T00:00:00.000Z'));
      // Unchanged fields round-trip
      expect(revoked.sessionId).toBe(original.sessionId);
      expect(revoked.maxPerOpUsd6).toBe(original.maxPerOpUsd6);
    });

    it('accepts bigint patches', () => {
      const original = new ScopedSession(BASE_PROPS);
      const spent = original.with({ totalSpentUsd6: 50_000_000n });
      expect(spent.totalSpentUsd6).toBe(50_000_000n);
      expect(spent.maxPerOpUsd6).toBe(100_000_000n);
    });
  });
});
