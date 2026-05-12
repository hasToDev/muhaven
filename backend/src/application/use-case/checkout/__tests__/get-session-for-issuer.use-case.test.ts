import { describe, expect, it } from 'vitest';
import { GetSessionForIssuerUseCase } from '../get-session-for-issuer.use-case.js';
import { CreateCheckoutSessionUseCase } from '../create-session.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../../../infrastructure/repository/memory/memory-checkout-session.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';

const BASE_URL = 'https://pay.example.test';

function makeMetadata() {
  return {
    issuerAddress: ('0x' + 'a'.repeat(40)) as `0x${string}`,
    tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    tokenSymbol: 'USDX',
    issuerLabel: 'Demo Issuer',
    description: 'Detail-page test',
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

describe('GetSessionForIssuerUseCase', () => {
  it('returns the session when owned by the caller, omitting encPayload', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    const create = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
    const created = await create.execute({
      issuerUserId: 'iss_a',
      metadata: makeMetadata(),
      payload: { amountUsd6: '5000000' },
    });

    const uc = new GetSessionForIssuerUseCase(sessionRepo, userRepo);
    const got = await uc.execute({
      issuerUserId: 'iss_a',
      sessionId: created.session.sessionId,
    });

    expect(got.session.sessionId).toBe(created.session.sessionId);
    expect(got.session.metadata.tokenSymbol).toBe('USDX');
    expect(got.session).not.toHaveProperty('encPayload');
  });

  it('returns 404 when the session belongs to another issuer (no leak)', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' }, { id: 'iss_b' });
    const create = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
    const created = await create.execute({
      issuerUserId: 'iss_a',
      metadata: makeMetadata(),
      payload: { amountUsd6: '5000000' },
    });

    const uc = new GetSessionForIssuerUseCase(sessionRepo, userRepo);
    await expect(
      uc.execute({ issuerUserId: 'iss_b', sessionId: created.session.sessionId }),
    ).rejects.toThrow(/not found/);
  });

  it('returns 404 for an unknown session id', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    const uc = new GetSessionForIssuerUseCase(sessionRepo, userRepo);
    await expect(
      uc.execute({ issuerUserId: 'iss_a', sessionId: 'cs_ABCDEFGHJKMNPQRSTVWXYZ2345' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects unapproved issuer with NOT_APPROVED_ISSUER', async () => {
    const sessionRepo = new MemoryCheckoutSessionRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a', issuerStatus: 'pending' });
    const uc = new GetSessionForIssuerUseCase(sessionRepo, userRepo);
    await expect(
      uc.execute({
        issuerUserId: 'iss_a',
        sessionId: 'cs_ABCDEFGHJKMNPQRSTVWXYZ2345',
      }),
    ).rejects.toThrow(/Issuer onboarding required/);
  });
});
