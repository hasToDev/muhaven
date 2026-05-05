import { describe, expect, it } from 'vitest';
import { RegisterWebhookEndpointUseCase } from '../register-webhook.use-case.js';
import { MemoryWebhookEndpointRepository } from '../../../../infrastructure/repository/memory/memory-webhook-endpoint.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { WebhookEventType } from '../../../../domain/checkout/model/webhook-endpoint.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';

async function makeUserRepo(
  issuerStatus: IssuerStatus = 'approved',
  role: 'investor' | 'issuer' = 'issuer',
): Promise<MemoryUserRepository> {
  const repo = new MemoryUserRepository();
  await repo.save(
    new User({
      id: 'iss_1',
      walletAddress: '0x' + '1'.repeat(40),
      walletProvider: 'zerodev',
      role,
      createdAt: new Date(),
      issuerStatus,
    }),
  );
  return repo;
}

describe('RegisterWebhookEndpointUseCase', () => {
  it('mints an endpoint with a fresh signing secret', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    const result = await uc.execute({
      issuerUserId: 'iss_1',
      url: 'https://issuer.test/hook',
    });
    expect(result.endpoint.endpointId).toMatch(/^whe_[0-9a-f]{32}$/);
    expect(result.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(result.endpoint.enabledEvents).toEqual([]);
  });

  it('rejects malformed URL', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    await expect(
      uc.execute({ issuerUserId: 'iss_1', url: 'not-a-url' }),
    ).rejects.toThrow(/url/);
  });

  it('rejects http:// for non-loopback hosts', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    await expect(
      uc.execute({ issuerUserId: 'iss_1', url: 'http://issuer.test/hook' }),
    ).rejects.toThrow(/https/);
  });

  it('allows http:// for localhost (test convenience)', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    const result = await uc.execute({
      issuerUserId: 'iss_1',
      url: 'http://localhost:8080/hook',
    });
    expect(result.endpoint.url).toBe('http://localhost:8080/hook');
  });

  it('caps enabledEvents to ≤32 entries', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    const big = Array(33).fill(WebhookEventType.SessionFunded);
    await expect(
      uc.execute({ issuerUserId: 'iss_1', url: 'https://x.test/h', enabledEvents: big }),
    ).rejects.toThrow(/32/);
  });

  it.each([
    ['https://10.0.0.1/hook', 'private 10/8'],
    ['https://172.16.0.5/hook', 'private 172.16/12'],
    ['https://172.31.4.4/hook', 'private 172.31'],
    ['https://192.168.1.10/hook', 'private 192.168/16'],
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://169.254.169.254/latest', 'AWS metadata link-local'],
    ['https://0.0.0.0/h', 'unspecified ipv4'],
    ['https://[::1]/h', 'ipv6 loopback'],
    ['https://[fc00::1]/h', 'ipv6 ULA fc'],
    ['https://[fd00::5]/h', 'ipv6 ULA fd'],
    ['https://[fe80::1]/h', 'ipv6 link-local'],
  ])('rejects SSRF target %s (%s)', async (url) => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    await expect(
      uc.execute({ issuerUserId: 'iss_1', url }),
    ).rejects.toThrow(/private|loopback/);
  });

  it('accepts public hostnames + plausible-public IPs', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    const r = await uc.execute({ issuerUserId: 'iss_1', url: 'https://issuer.example/hook' });
    expect(r.endpoint.url).toBe('https://issuer.example/hook');
    const r2 = await uc.execute({ issuerUserId: 'iss_1', url: 'https://172.32.0.1/hook' });
    expect(r2.endpoint.url).toBe('https://172.32.0.1/hook');
  });

  it('rejects unapproved issuer (Phase 9.A · F2 lifecycle gate)', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    for (const status of ['unregistered', 'pending', 'suspended'] as const) {
      const uc = new RegisterWebhookEndpointUseCase(
        repo,
        await makeUserRepo(status),
      );
      await expect(
        uc.execute({ issuerUserId: 'iss_1', url: 'https://x.test/a' }),
      ).rejects.toThrow(/Issuer onboarding required/);
    }
  });

  it('persists distinct secrets across two endpoint creations', async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const uc = new RegisterWebhookEndpointUseCase(repo, await makeUserRepo());
    const a = await uc.execute({ issuerUserId: 'iss_1', url: 'https://x.test/a' });
    const b = await uc.execute({ issuerUserId: 'iss_1', url: 'https://x.test/b' });
    expect(a.signingSecret).not.toBe(b.signingSecret);
    expect(a.endpoint.endpointId).not.toBe(b.endpoint.endpointId);
  });
});
