import { describe, expect, it } from 'vitest';
import { GetIssuerStatsUseCase } from '../get-issuer-stats.use-case.js';
import { CreateCheckoutSessionUseCase } from '../create-session.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../../../infrastructure/repository/memory/memory-checkout-session.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { CheckoutSessionStatus } from '../../../../domain/checkout/model/checkout-session.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';

const BASE_URL = 'https://pay.example.test';

function makeMetadata() {
  return {
    issuerAddress: ('0x' + 'a'.repeat(40)) as `0x${string}`,
    tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    tokenSymbol: 'USDX',
    issuerLabel: 'Demo',
    description: 'Stats test',
    successUrl: null,
    cancelUrl: null,
  };
}

async function makeUserRepo(
  id = 'iss_a',
  issuerStatus: IssuerStatus = 'approved',
  role: 'investor' | 'issuer' = 'issuer',
): Promise<MemoryUserRepository> {
  const repo = new MemoryUserRepository();
  await repo.save(
    new User({
      id,
      walletAddress: '0x' + id.padStart(40, '0').slice(-40),
      walletProvider: 'zerodev',
      role,
      createdAt: new Date(),
      issuerStatus,
    }),
  );
  return repo;
}

async function seed(
  sessionRepo: MemoryCheckoutSessionRepository,
  userRepo: MemoryUserRepository,
  issuerUserId: string,
  perDayUtc: Array<{ dayOffsetFromNow: number; count: number }>,
  now: Date,
): Promise<void> {
  const create = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
  for (const { dayOffsetFromNow, count } of perDayUtc) {
    // Pin to a few hours BEFORE `now` so the rapid-fire `+ i*1000` seed
    // doesn't push later iterations past the stats `until` boundary.
    const day = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + dayOffsetFromNow,
        Math.max(0, now.getUTCHours() - 2), 0, 0,
      ),
    );
    for (let i = 0; i < count; i++) {
      await create.execute({
        issuerUserId,
        metadata: makeMetadata(),
        payload: { amountUsd6: '1000000' },
        now: new Date(day.getTime() + i * 1000),
      });
    }
  }
}

describe('GetIssuerStatsUseCase', () => {
  const NOW = new Date('2026-05-12T12:00:00.000Z');

  it('returns count-only stats — no amount aggregation fields', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo();
    await seed(sessionRepo, userRepo, 'iss_a', [{ dayOffsetFromNow: 0, count: 3 }], NOW);

    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    const result = await uc.execute({ issuerUserId: 'iss_a', now: NOW });

    // Sanity — schema present.
    expect(result.total).toBe(3);
    expect(result.range).toBe('7d');
    // Privacy invariant — count-only.
    expect(result).not.toHaveProperty('avgAmount');
    expect(result).not.toHaveProperty('totalRevenue');
    expect(result).not.toHaveProperty('amount');
    for (const value of Object.values(result.byStatus)) {
      expect(typeof value).toBe('number');
    }
  });

  it('respects range (7d vs 30d vs all)', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo();
    await seed(
      sessionRepo,
      userRepo,
      'iss_a',
      [
        { dayOffsetFromNow: -1, count: 2 },
        { dayOffsetFromNow: -10, count: 3 },
        { dayOffsetFromNow: -60, count: 5 },
      ],
      NOW,
    );

    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    const r7 = await uc.execute({ issuerUserId: 'iss_a', range: '7d', now: NOW });
    const r30 = await uc.execute({ issuerUserId: 'iss_a', range: '30d', now: NOW });
    const rAll = await uc.execute({ issuerUserId: 'iss_a', range: 'all', now: NOW });

    expect(r7.total).toBe(2);
    expect(r30.total).toBe(5);
    expect(rAll.total).toBe(10);
  });

  it('gap-fills daily buckets so the chart x-axis stays continuous', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo();
    // Only day -3 and day -1 have sessions. Days -7..0 are the 7d window.
    await seed(
      sessionRepo,
      userRepo,
      'iss_a',
      [
        { dayOffsetFromNow: -3, count: 2 },
        { dayOffsetFromNow: -1, count: 1 },
      ],
      NOW,
    );

    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    const result = await uc.execute({ issuerUserId: 'iss_a', range: '7d', now: NOW });
    expect(result.daily.length).toBeGreaterThanOrEqual(7);
    expect(result.daily.length).toBeLessThanOrEqual(9);
    const sum = result.daily.reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(3);
    // Buckets are monotonic-ascending.
    for (let i = 1; i < result.daily.length; i++) {
      expect(result.daily[i].bucketMs).toBeGreaterThan(result.daily[i - 1].bucketMs);
    }
  });

  it('computes conversion rate as settled / total', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo();
    await seed(sessionRepo, userRepo, 'iss_a', [{ dayOffsetFromNow: 0, count: 4 }], NOW);
    // Flip two to settled (forward: pending → funded → wrapped → purchased → settled).
    const list = await sessionRepo.findByIssuerUserId('iss_a');
    for (const s of list.sessions.slice(0, 2)) {
      for (const step of [
        CheckoutSessionStatus.Funded,
        CheckoutSessionStatus.Wrapped,
        CheckoutSessionStatus.Purchased,
        CheckoutSessionStatus.Settled,
      ]) {
        const cur = await sessionRepo.findById(s.sessionId);
        await sessionRepo.transition({
          sessionId: s.sessionId,
          expectedStatus: cur!.status,
          newStatus: step,
          now: new Date(),
        });
      }
    }

    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    const r = await uc.execute({ issuerUserId: 'iss_a', range: 'all', now: NOW });
    expect(r.byStatus.settled).toBe(2);
    expect(r.byStatus.pending).toBe(2);
    expect(r.conversionRate).toBe(0.5);
  });

  it('does not include another issuer\'s data', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = new MemoryUserRepository();
    for (const id of ['iss_a', 'iss_b']) {
      await userRepo.save(
        new User({
          id,
          walletAddress: '0x' + id.padStart(40, '0').slice(-40),
          walletProvider: 'zerodev',
          role: 'issuer',
          createdAt: new Date(),
          issuerStatus: 'approved',
        }),
      );
    }
    await seed(sessionRepo, userRepo, 'iss_a', [{ dayOffsetFromNow: 0, count: 2 }], NOW);
    await seed(sessionRepo, userRepo, 'iss_b', [{ dayOffsetFromNow: 0, count: 5 }], NOW);

    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    const a = await uc.execute({ issuerUserId: 'iss_a', range: 'all', now: NOW });
    const b = await uc.execute({ issuerUserId: 'iss_b', range: 'all', now: NOW });
    expect(a.total).toBe(2);
    expect(b.total).toBe(5);
  });

  it('uses half-open [since, until) bounds — no double-counting on boundary tick (arch HIGH-2)', async () => {
    // A session created at exactly `until` should NOT count in `7d`
    // (boundary is exclusive); the same session counts in `all`.
    // Pre-fix, both ranges would double-count this row.
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo();
    const create = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
    // NOW is the until boundary for 7d. Place a session AT NOW.
    await create.execute({
      issuerUserId: 'iss_a',
      metadata: {
        issuerAddress: ('0x' + 'a'.repeat(40)) as `0x${string}`,
        tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
        tokenSymbol: 'USDX',
        issuerLabel: 'Demo',
        description: 'Boundary',
        successUrl: null,
        cancelUrl: null,
      },
      payload: { amountUsd6: '1000000' },
      now: NOW,
    });
    // Place a session strictly inside the 7d window (1h before NOW).
    await create.execute({
      issuerUserId: 'iss_a',
      metadata: {
        issuerAddress: ('0x' + 'a'.repeat(40)) as `0x${string}`,
        tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
        tokenSymbol: 'USDX',
        issuerLabel: 'Demo',
        description: 'Inside',
        successUrl: null,
        cancelUrl: null,
      },
      payload: { amountUsd6: '1000000' },
      now: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    // `until = NOW`; the session AT NOW is excluded (half-open).
    const r7 = await uc.execute({ issuerUserId: 'iss_a', range: '7d', now: NOW });
    expect(r7.total).toBe(1);
    // `all` has no `since` floor and uses NOW as the strict upper
    // bound. The session at exactly NOW is still excluded (half-open),
    // so the visible total is 1 — the session before NOW.
    const rAll = await uc.execute({ issuerUserId: 'iss_a', range: 'all', now: NOW });
    expect(rAll.total).toBe(1);
  });

  it('rejects unapproved issuer', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepo('iss_a', 'pending');
    const uc = new GetIssuerStatsUseCase(sessionRepo, userRepo);
    await expect(uc.execute({ issuerUserId: 'iss_a' })).rejects.toThrow(
      /Issuer onboarding required/,
    );
  });
});
