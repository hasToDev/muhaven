import { describe, expect, it } from 'vitest';
import { ListCheckoutSessionsUseCase } from '../list-sessions.use-case.js';
import { CreateCheckoutSessionUseCase } from '../create-session.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../../../infrastructure/repository/memory/memory-checkout-session.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { CheckoutSessionStatus } from '../../../../domain/checkout/model/checkout-session.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';
import { decodeSessionCursor } from '../session-cursor.js';

const BASE_URL = 'https://pay.example.test';

function makeMetadata(overrides: Partial<{ tokenSymbol: string }> = {}) {
  return {
    issuerAddress: ('0x' + 'a'.repeat(40)) as `0x${string}`,
    tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    tokenSymbol: overrides.tokenSymbol ?? 'USDX',
    issuerLabel: 'Demo Issuer',
    description: 'Series A bridge',
    successUrl: null,
    cancelUrl: null,
  };
}

async function makeUserRepoMulti(
  ...issuers: Array<{ id: string; issuerStatus?: IssuerStatus; role?: 'investor' | 'issuer' }>
): Promise<MemoryUserRepository> {
  const repo = new MemoryUserRepository();
  for (const u of issuers) {
    await repo.save(
      new User({
        id: u.id,
        walletAddress: '0x' + u.id.padStart(40, '0').slice(-40),
        walletProvider: 'zerodev',
        role: u.role ?? 'issuer',
        createdAt: new Date(),
        issuerStatus: u.issuerStatus ?? 'approved',
      }),
    );
  }
  return repo;
}

async function seedSessions(
  sessionRepo: MemoryCheckoutSessionRepository,
  userRepo: MemoryUserRepository,
  issuerUserId: string,
  count: number,
  startMs = Date.UTC(2026, 4, 1, 12, 0, 0),
): Promise<void> {
  const uc = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
  for (let i = 0; i < count; i++) {
    await uc.execute({
      issuerUserId,
      metadata: makeMetadata(),
      payload: { amountUsd6: '1000000' },
      now: new Date(startMs + i * 1000),
    });
  }
}

describe('ListCheckoutSessionsUseCase', () => {
  it('returns the issuer\'s sessions newest-first, omitting encPayload', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    await seedSessions(sessionRepo, userRepo, 'iss_a', 3);

    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
    const result = await uc.execute({ issuerUserId: 'iss_a' });

    expect(result.sessions).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
    const times = result.sessions.map((s) => new Date(s.createdAt).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
    // Privacy invariant — encPayload MUST NOT appear in DTO.
    for (const s of result.sessions) {
      expect(s).not.toHaveProperty('encPayload');
    }
  });

  it('paginates through multiple pages with stable cursor ordering', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    await seedSessions(sessionRepo, userRepo, 'iss_a', 5);

    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);

    const page1 = await uc.execute({ issuerUserId: 'iss_a', limit: 2 });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(decodeSessionCursor(page1.nextCursor!)).toMatchObject({
      sessionId: page1.sessions[1].sessionId,
    });

    const page2 = await uc.execute({
      issuerUserId: 'iss_a',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.sessions).toHaveLength(2);
    expect(page2.sessions.map((s) => s.sessionId)).not.toContain(page1.sessions[0].sessionId);

    const page3 = await uc.execute({
      issuerUserId: 'iss_a',
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.sessions).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    await seedSessions(sessionRepo, userRepo, 'iss_a', 3);
    // Advance two of the three to Funded.
    const all = await sessionRepo.findByIssuerUserId('iss_a');
    for (const s of all.sessions.slice(0, 2)) {
      await sessionRepo.transition({
        sessionId: s.sessionId,
        expectedStatus: CheckoutSessionStatus.Pending,
        newStatus: CheckoutSessionStatus.Funded,
        now: new Date(),
      });
    }

    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
    const funded = await uc.execute({
      issuerUserId: 'iss_a',
      status: CheckoutSessionStatus.Funded,
    });
    expect(funded.sessions).toHaveLength(2);
    for (const s of funded.sessions) {
      expect(s.status).toBe('funded');
    }
  });

  it('does not return another issuer\'s sessions (cross-issuer isolation)', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' }, { id: 'iss_b' });
    await seedSessions(sessionRepo, userRepo, 'iss_a', 2);
    await seedSessions(sessionRepo, userRepo, 'iss_b', 3);

    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
    const a = await uc.execute({ issuerUserId: 'iss_a' });
    const b = await uc.execute({ issuerUserId: 'iss_b' });

    expect(a.sessions).toHaveLength(2);
    expect(b.sessions).toHaveLength(3);
    const aIds = new Set(a.sessions.map((s) => s.sessionId));
    for (const s of b.sessions) {
      expect(aIds.has(s.sessionId)).toBe(false);
    }
  });

  it('rejects unapproved issuer with NOT_APPROVED_ISSUER', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    for (const status of ['unregistered', 'pending', 'suspended'] as const) {
      const userRepo = await makeUserRepoMulti({ id: 'iss_a', issuerStatus: status });
      const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
      await expect(uc.execute({ issuerUserId: 'iss_a' })).rejects.toThrow(
        /Issuer onboarding required/,
      );
    }
  });

  it('rejects investor-role users', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'inv_a', role: 'investor' });
    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
    await expect(uc.execute({ issuerUserId: 'inv_a' })).rejects.toThrow(
      /Issuer onboarding required/,
    );
  });

  it('returns 400 on malformed cursor', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    const uc = new ListCheckoutSessionsUseCase(sessionRepo, userRepo);
    await expect(
      uc.execute({ issuerUserId: 'iss_a', cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/invalid cursor/);
  });
});
