import { describe, expect, it } from 'vitest';
import { ListWebhooksUseCase, maskSigningSecret } from '../list-webhooks.use-case.js';
import { RegisterWebhookEndpointUseCase } from '../register-webhook.use-case.js';
import { MemoryWebhookEndpointRepository } from '../../../../infrastructure/repository/memory/memory-webhook-endpoint.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';

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

describe('ListWebhooksUseCase', () => {
  it('returns the issuer\'s endpoints with hint-only signing secrets', async () => {
    const endpointRepo = new MemoryWebhookEndpointRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    const register = new RegisterWebhookEndpointUseCase(endpointRepo, userRepo);
    const a = await register.execute({ issuerUserId: 'iss_a', url: 'https://a.test/hook' });
    const b = await register.execute({ issuerUserId: 'iss_a', url: 'https://b.test/hook' });

    const uc = new ListWebhooksUseCase(endpointRepo, userRepo);
    const result = await uc.execute({ issuerUserId: 'iss_a' });

    expect(result.endpoints).toHaveLength(2);
    for (const e of result.endpoints) {
      // Privacy invariant — full secret never surfaces.
      expect(e.signingSecretHint).not.toBe(a.signingSecret);
      expect(e.signingSecretHint).not.toBe(b.signingSecret);
      expect(e.signingSecretHint).toMatch(/^whsec_.{6}\.\.\..{4}$/);
      expect(e).not.toHaveProperty('signingSecret');
    }
  });

  it('returns disabled endpoints alongside active ones', async () => {
    const endpointRepo = new MemoryWebhookEndpointRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' });
    const register = new RegisterWebhookEndpointUseCase(endpointRepo, userRepo);
    const a = await register.execute({ issuerUserId: 'iss_a', url: 'https://a.test/hook' });
    await register.execute({ issuerUserId: 'iss_a', url: 'https://b.test/hook' });
    await endpointRepo.disable({
      endpointId: a.endpoint.endpointId,
      issuerUserId: 'iss_a',
      now: new Date(),
    });

    const uc = new ListWebhooksUseCase(endpointRepo, userRepo);
    const result = await uc.execute({ issuerUserId: 'iss_a' });
    expect(result.endpoints).toHaveLength(2);
    const disabled = result.endpoints.find((e) => e.endpointId === a.endpoint.endpointId);
    expect(disabled?.disabledAt).not.toBeNull();
  });

  it('does not return another issuer\'s endpoints (cross-issuer isolation)', async () => {
    const endpointRepo = new MemoryWebhookEndpointRepository();
    const userRepo = await makeUserRepoMulti({ id: 'iss_a' }, { id: 'iss_b' });
    const register = new RegisterWebhookEndpointUseCase(endpointRepo, userRepo);
    await register.execute({ issuerUserId: 'iss_a', url: 'https://a.test/hook' });
    await register.execute({ issuerUserId: 'iss_b', url: 'https://b.test/hook' });

    const uc = new ListWebhooksUseCase(endpointRepo, userRepo);
    const a = await uc.execute({ issuerUserId: 'iss_a' });
    const b = await uc.execute({ issuerUserId: 'iss_b' });
    expect(a.endpoints).toHaveLength(1);
    expect(b.endpoints).toHaveLength(1);
    expect(a.endpoints[0].url).toBe('https://a.test/hook');
    expect(b.endpoints[0].url).toBe('https://b.test/hook');
  });

  it('rejects unapproved issuer with NOT_APPROVED_ISSUER', async () => {
    const endpointRepo = new MemoryWebhookEndpointRepository();
    for (const status of ['unregistered', 'pending', 'suspended'] as const) {
      const userRepo = await makeUserRepoMulti({ id: 'iss_a', issuerStatus: status });
      const uc = new ListWebhooksUseCase(endpointRepo, userRepo);
      await expect(uc.execute({ issuerUserId: 'iss_a' })).rejects.toThrow(
        /Issuer onboarding required/,
      );
    }
  });
});

describe('maskSigningSecret', () => {
  it('returns a stable mask shape for a representative whsec_ secret', () => {
    const masked = maskSigningSecret('whsec_d41d8cd98f00b204e9800998ecf8427e');
    expect(masked).toBe('whsec_d41d8c...427e');
  });

  it('returns *** for implausibly short secrets', () => {
    expect(maskSigningSecret('short')).toBe('***');
  });
});
