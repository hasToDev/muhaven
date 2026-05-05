import { describe, expect, it } from 'vitest';
import { CreateCheckoutSessionUseCase, buildCheckoutUrl } from '../create-session.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../../../infrastructure/repository/memory/memory-checkout-session.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { CheckoutAesGcm, b64urlDecode } from '../../../../infrastructure/checkout/aes-gcm.js';
import { CheckoutSessionStatus } from '../../../../domain/checkout/model/checkout-session.js';
import { User, type IssuerStatus } from '../../../../domain/auth/model/user.js';

describe('CreateCheckoutSessionUseCase', () => {
  const baseUrl = 'https://pay.example.test';

  function makeMetadata() {
    return {
      issuerAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
      tokenAddress: '0x' + 'b'.repeat(40) as `0x${string}`,
      tokenSymbol: 'USDX',
      issuerLabel: 'Demo Issuer',
      description: 'Series A bridge',
      successUrl: null,
      cancelUrl: null,
    };
  }

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

  it('mints a session with a 30-min default TTL + ciphertext payload', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    const before = new Date();
    const result = await uc.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '12345000', memo: 'test' },
    });
    expect(result.session.sessionId).toMatch(/^cs_[A-Z0-9]{26}$/);
    expect(result.session.status).toBe(CheckoutSessionStatus.Pending);
    expect(result.fragmentKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.url).toBe(`${baseUrl}/c/${result.session.sessionId}#k=${result.fragmentKey}`);
    const ttl = result.session.expiresAt.getTime() - before.getTime();
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThan(31 * 60 * 1000);
  });

  it('persists the encrypted payload + the key never reaches the row', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    const result = await uc.execute({
      issuerUserId: 'iss_1',
      metadata: makeMetadata(),
      payload: { amountUsd6: '500000', memo: 'half a dollar' },
    });
    const stored = await repo.findById(result.session.sessionId);
    expect(stored).not.toBeNull();
    // The row's encPayload is the ciphertext envelope; the key is NOT
    // anywhere on the row.
    expect(stored!.encPayload).not.toContain(result.fragmentKey);
    // Round-trip with the surfaced key recovers the original payload.
    const aes = new CheckoutAesGcm();
    const keyBuf = b64urlDecode(result.fragmentKey);
    const decrypted = aes.decrypt(stored!.encPayload, Buffer.from(keyBuf));
    expect(decrypted).toEqual({ amountUsd6: '500000', memo: 'half a dollar' });
  });

  it('rejects amountUsd6 with non-digit characters', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    await expect(
      uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: '12.34' },
      }),
    ).rejects.toThrow(/amountUsd6/);
  });

  it('rejects ttl outside (0, 86400]', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    await expect(
      uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: '1' },
        ttlSec: 0,
      }),
    ).rejects.toThrow(/ttlSec/);
    await expect(
      uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: '1' },
        ttlSec: 86401,
      }),
    ).rejects.toThrow(/ttlSec/);
  });

  it('rejects memo > 280 chars', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    await expect(
      uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: '1', memo: 'x'.repeat(281) },
      }),
    ).rejects.toThrow(/memo/);
  });

  it('rejects unapproved issuer (Phase 9.A · F2 lifecycle gate)', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    for (const status of ['unregistered', 'pending', 'suspended'] as const) {
      const uc = new CreateCheckoutSessionUseCase(
        repo,
        baseUrl,
        await makeUserRepo(status),
      );
      await expect(
        uc.execute({
          issuerUserId: 'iss_1',
          metadata: makeMetadata(),
          payload: { amountUsd6: '1' },
        }),
      ).rejects.toThrow(/Issuer onboarding required/);
    }
  });

  it('rejects investor-roled user even if issuerStatus is approved', async () => {
    // Defense in depth — the JWT role claim could be `investor` even if
    // the user table briefly carried an `approved` issuerStatus from a
    // role demotion. The use-case re-checks both fields.
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(
      repo,
      baseUrl,
      await makeUserRepo('approved', 'investor'),
    );
    await expect(
      uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: '1' },
      }),
    ).rejects.toThrow(/Issuer onboarding required/);
  });

  it('rejects unknown issuerUserId', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(
      repo,
      baseUrl,
      await makeUserRepo(),
    );
    await expect(
      uc.execute({
        issuerUserId: 'iss_unknown',
        metadata: makeMetadata(),
        payload: { amountUsd6: '1' },
      }),
    ).rejects.toThrow(/Issuer onboarding required/);
  });

  it('produces unique session ids on parallel mints', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const uc = new CreateCheckoutSessionUseCase(repo, baseUrl, await makeUserRepo());
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = await uc.execute({
        issuerUserId: 'iss_1',
        metadata: makeMetadata(),
        payload: { amountUsd6: String(i + 1) },
      });
      ids.add(r.session.sessionId);
    }
    expect(ids.size).toBe(200);
  });
});

describe('buildCheckoutUrl', () => {
  it('strips trailing slash on the base url', () => {
    expect(
      buildCheckoutUrl('https://pay.example.test/', 'cs_AAA', 'KEY'),
    ).toBe('https://pay.example.test/c/cs_AAA#k=KEY');
    expect(
      buildCheckoutUrl('https://pay.example.test/////', 'cs_AAA', 'KEY'),
    ).toBe('https://pay.example.test/c/cs_AAA#k=KEY');
  });
});
