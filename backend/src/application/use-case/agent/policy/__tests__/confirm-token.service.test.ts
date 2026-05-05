import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAgentConfirmTokenRepository } from '../../../../../infrastructure/repository/memory/index.js';
import { ConfirmTokenService } from '../confirm-token.service.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';

const NOW = new Date('2026-04-30T00:00:00.000Z');
const T_PLUS_1H = new Date(NOW.getTime() + 60 * 60 * 1000);

describe('ConfirmTokenService — R-3 single-use enforcement', () => {
  let repo: MemoryAgentConfirmTokenRepository;
  let svc: ConfirmTokenService;

  beforeEach(() => {
    repo = new MemoryAgentConfirmTokenRepository();
    svc = new ConfirmTokenService(repo);
  });

  it('issues a token bound to the action hash', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      now: NOW,
    });
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('produces deterministic action hashes for semantically equal payloads', () => {
    const h1 = ConfirmTokenService.hashAction('tier_transition', {
      surface: 'havenbot',
      targetTier: 'policy-bound',
    });
    const h2 = ConfirmTokenService.hashAction('tier_transition', {
      targetTier: 'policy-bound',
      surface: 'havenbot',
    }); // key order swapped
    expect(h1).toBe(h2);
  });

  it('produces different hashes when the payload differs', () => {
    const h1 = ConfirmTokenService.hashAction('tier_transition', { targetTier: 'policy-bound' });
    const h2 = ConfirmTokenService.hashAction('tier_transition', { targetTier: 'confirm-per-action' });
    expect(h1).not.toBe(h2);
  });

  it('consumes a fresh token successfully', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      now: NOW,
    });
    const consumed = await svc.consume(
      issued.token,
      'u1',
      'tier_transition',
      { surface: 'havenbot', targetTier: 'policy-bound' },
      NOW,
    );
    expect(consumed.consumedAt).not.toBeNull();
  });

  it('rejects a re-consumed token with 410', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      now: NOW,
    });
    await svc.consume(
      issued.token,
      'u1',
      'tier_transition',
      { surface: 'havenbot', targetTier: 'policy-bound' },
      NOW,
    );
    try {
      await svc.consume(
        issued.token,
        'u1',
        'tier_transition',
        { surface: 'havenbot', targetTier: 'policy-bound' },
        NOW,
      );
      expect.fail('expected re-consume to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationHttpError);
      expect((err as ApplicationHttpError).statusCode).toBe(410);
    }
  });

  it('rejects an expired token with 410', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      ttlMs: 1000, // 1s
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 60_000);
    try {
      await svc.consume(
        issued.token,
        'u1',
        'tier_transition',
        { surface: 'havenbot', targetTier: 'policy-bound' },
        later,
      );
      expect.fail('expected expired-consume to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationHttpError);
      expect((err as ApplicationHttpError).statusCode).toBe(410);
    }
  });

  it('rejects a token with a tampered actionPayload (re-approve required)', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      now: NOW,
    });
    try {
      await svc.consume(
        issued.token,
        'u1',
        'tier_transition',
        { surface: 'havenbot', targetTier: 'confirm-per-action' }, // changed
        NOW,
      );
      expect.fail('expected mismatched-payload consume to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationHttpError);
      expect((err as ApplicationHttpError).statusCode).toBe(403);
    }
  });

  it('rejects a token issued for a different user', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'tier_transition',
      actionPayload: { surface: 'havenbot', targetTier: 'policy-bound' },
      now: NOW,
    });
    try {
      await svc.consume(
        issued.token,
        'u2',
        'tier_transition',
        { surface: 'havenbot', targetTier: 'policy-bound' },
        NOW,
      );
      expect.fail('expected wrong-user consume to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationHttpError);
      expect((err as ApplicationHttpError).statusCode).toBe(403);
    }
  });

  it('default TTL is non-zero and below 1 hour', async () => {
    const issued = await svc.issue({
      userId: 'u1',
      actionKind: 'pause',
      actionPayload: {},
      now: NOW,
    });
    expect(issued.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(T_PLUS_1H.getTime());
  });
});
