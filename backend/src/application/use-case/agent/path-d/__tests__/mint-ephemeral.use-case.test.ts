import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// `getLogger()`/env may resolve lazily; seed the minimum env (mirrors the
// encrypt-shares use-case test).
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});
import { RwaToken } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { IScopedSessionRepository } from '../../../../../domain/agent/repository/scoped-session.repository.js';
import type { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { MintEphemeralEoaUseCase } from '../mint-ephemeral.use-case.js';

const USER_ID = 'user-uuid-0001';
const TOKEN_ACTIVE = '0x1d6C140204F21835F1AF2A0615826A333827d946';
const TOKEN_WINDDOWN = '0x797b9a2ec6F752B791DcE2f721Ad51Da68074Ed3';

function buildToken(addressOverride: string, status: 'active' | 'winding_down'): RwaToken {
  const now = new Date('2026-05-29T00:00:00.000Z');
  return new RwaToken({
    id: addressOverride,
    address: addressOverride,
    name: 'Test',
    symbol: 'TEST',
    issuerAddress: '0x0000000000000000000000000000000000000099',
    kycTier: 1,
    assetClass: 'money_market',
    status,
    createdAt: now,
    updatedAt: now,
  });
}

function makeTokenRepo(): IRwaTokenRepository {
  return {
    findByAddress: vi.fn(async (addr: string) => {
      const lower = addr.toLowerCase();
      if (lower === TOKEN_ACTIVE.toLowerCase()) return buildToken(TOKEN_ACTIVE, 'active');
      if (lower === TOKEN_WINDDOWN.toLowerCase()) return buildToken(TOKEN_WINDDOWN, 'winding_down');
      return null;
    }),
    save: vi.fn(async () => { throw new Error('unstubbed: save'); }),
    findById: vi.fn(async () => { throw new Error('unstubbed: findById'); }),
    findAll: vi.fn(async () => { throw new Error('unstubbed: findAll'); }),
    findByIssuer: vi.fn(async () => { throw new Error('unstubbed: findByIssuer'); }),
    findByStatus: vi.fn(async () => { throw new Error('unstubbed: findByStatus'); }),
    update: vi.fn(async () => { throw new Error('unstubbed: update'); }),
    updateIssuer: vi.fn(async () => { throw new Error('unstubbed: updateIssuer'); }),
    updatePausedStatus: vi.fn(async () => { throw new Error('unstubbed: updatePausedStatus'); }),
  };
}

function makeScopedRepo(hasActive: boolean): {
  repo: IScopedSessionRepository;
  findLatestActive: ReturnType<typeof vi.fn>;
} {
  const findLatestActive = vi.fn(async () =>
    hasActive ? ({ sessionId: 'sess_active' } as unknown as ScopedSession) : null,
  );
  return { repo: { findLatestActive } as unknown as IScopedSessionRepository, findLatestActive };
}

describe('MintEphemeralEoaUseCase', () => {
  let tokenRepo: IRwaTokenRepository;
  let useCase: MintEphemeralEoaUseCase;

  beforeEach(() => {
    tokenRepo = makeTokenRepo();
    useCase = new MintEphemeralEoaUseCase(tokenRepo, makeScopedRepo(true).repo);
  });

  it('returns a fresh ephemeralEOA on the happy path (no encryption)', async () => {
    const result = await useCase.execute({ userId: USER_ID, tokenAddress: TOKEN_ACTIVE });
    expect(result.ephemeralEOA).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('mints a DIFFERENT ephemeralEOA on each call (no key reuse)', async () => {
    const r1 = await useCase.execute({ userId: USER_ID, tokenAddress: TOKEN_ACTIVE });
    const r2 = await useCase.execute({ userId: USER_ID, tokenAddress: TOKEN_ACTIVE });
    expect(r1.ephemeralEOA).not.toBe(r2.ephemeralEOA);
  });

  it('rejects with 403 when there is no active scoped session (revoke kill-switch)', async () => {
    const { repo, findLatestActive } = makeScopedRepo(false);
    const gated = new MintEphemeralEoaUseCase(tokenRepo, repo);
    await expect(
      gated.execute({ userId: USER_ID, tokenAddress: TOKEN_ACTIVE }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(findLatestActive).toHaveBeenCalledWith(USER_ID, 'mcp', expect.any(Number));
  });

  it('does NOT touch the token repo when the session is revoked (gate fires first)', async () => {
    const gated = new MintEphemeralEoaUseCase(tokenRepo, makeScopedRepo(false).repo);
    await expect(
      gated.execute({ userId: USER_ID, tokenAddress: TOKEN_ACTIVE }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(tokenRepo.findByAddress).not.toHaveBeenCalled();
  });

  it('rejects a malformed tokenAddress with 400', async () => {
    await expect(
      useCase.execute({ userId: USER_ID, tokenAddress: 'not-an-address' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown token with 404', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        tokenAddress: '0x0000000000000000000000000000000000000abc',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a winding_down token with 409', async () => {
    await expect(
      useCase.execute({ userId: USER_ID, tokenAddress: TOKEN_WINDDOWN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
