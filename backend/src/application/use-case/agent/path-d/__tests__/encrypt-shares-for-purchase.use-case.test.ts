import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FheWorkerClient } from '../../../../../infrastructure/fhe/fhe-worker.client.js';

// `getLogger()` resolves `getEnv()` lazily on first call. Seed the
// minimum env so the empty-result branch's logger call doesn't trip
// the EnvSchema parser in the test env. Mirrors
// `notify-yield-cron-failure.use-case.test.ts`.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});
import { RwaToken } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { IScopedSessionRepository } from '../../../../../domain/agent/repository/scoped-session.repository.js';
import type { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';
import { EncryptSharesForPurchaseUseCase } from '../encrypt-shares-for-purchase.use-case.js';

const KERNEL = '0xe11E83398C33A37CaC02C01c43F14A7f95876986';
const USER_ID = 'user-uuid-0001';
const TOKEN_ACTIVE = '0x1d6C140204F21835F1AF2A0615826A333827d946'; // USYC from Wave 5 1A
const TOKEN_WINDDOWN = '0x797b9a2ec6F752B791DcE2f721Ad51Da68074Ed3';

function buildToken(addressOverride: string, status: 'active' | 'winding_down'): RwaToken {
  const now = new Date('2026-05-22T00:00:00.000Z');
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

interface StubbedFheWorker
  extends Pick<FheWorkerClient, 'encryptBatchForAccount'> {
  readonly callLog: Array<{ userAddress: string; items: unknown[] }>;
}

function makeFheWorker(): StubbedFheWorker {
  const callLog: Array<{ userAddress: string; items: unknown[] }> = [];
  const encryptBatchForAccount = vi.fn(async (userAddress: string, items: unknown[]) => {
    callLog.push({ userAddress, items });
    return {
      results: [
        {
          type: 'euint128',
          data: '0x'.padEnd(66, 'a'),
          securityZone: 0,
          utype: 5,
          inputProof: '0xdeadbeef',
          encryptionTimeMs: 100,
        },
      ],
      totalEncryptionTimeMs: 100,
    };
  });
  return { encryptBatchForAccount, callLog } as StubbedFheWorker;
}

function makeTokenRepo(active = TOKEN_ACTIVE, winddown = TOKEN_WINDDOWN): IRwaTokenRepository {
  return {
    findByAddress: vi.fn(async (addr: string) => {
      const lower = addr.toLowerCase();
      if (lower === active.toLowerCase()) return buildToken(active, 'active');
      if (lower === winddown.toLowerCase()) return buildToken(winddown, 'winding_down');
      return null;
    }),
    // The use-case only calls findByAddress; the rest of the surface
    // throws to make sure no future refactor silently reaches for an
    // unstubbed method.
    save: vi.fn(async () => {
      throw new Error('unstubbed: save');
    }),
    findById: vi.fn(async () => {
      throw new Error('unstubbed: findById');
    }),
    findAll: vi.fn(async () => {
      throw new Error('unstubbed: findAll');
    }),
    findByIssuer: vi.fn(async () => {
      throw new Error('unstubbed: findByIssuer');
    }),
    findByStatus: vi.fn(async () => {
      throw new Error('unstubbed: findByStatus');
    }),
    update: vi.fn(async () => {
      throw new Error('unstubbed: update');
    }),
    updateIssuer: vi.fn(async () => {
      throw new Error('unstubbed: updateIssuer');
    }),
    updatePausedStatus: vi.fn(async () => {
      throw new Error('unstubbed: updatePausedStatus');
    }),
  };
}

/**
 * Stub the scoped-session repo for the revoke kill-switch gate. The
 * use-case only calls `findLatestActive`, so we stub just that:
 * `hasActive=true` → return a truthy session (gate passes);
 * `hasActive=false` → return null (revoked/expired → gate rejects 403).
 * The session object's fields are never read by the gate (truthiness
 * only), so an opaque cast is sufficient.
 */
function makeScopedRepo(hasActive: boolean): {
  repo: IScopedSessionRepository;
  findLatestActive: ReturnType<typeof vi.fn>;
} {
  const findLatestActive = vi.fn(async () =>
    hasActive ? ({ sessionId: 'sess_active' } as unknown as ScopedSession) : null,
  );
  return { repo: { findLatestActive } as unknown as IScopedSessionRepository, findLatestActive };
}

describe('EncryptSharesForPurchaseUseCase', () => {
  let fhe: StubbedFheWorker;
  let tokenRepo: IRwaTokenRepository;
  let useCase: EncryptSharesForPurchaseUseCase;

  beforeEach(() => {
    fhe = makeFheWorker();
    tokenRepo = makeTokenRepo();
    useCase = new EncryptSharesForPurchaseUseCase(
      fhe as unknown as FheWorkerClient,
      tokenRepo,
      makeScopedRepo(true).repo,
    );
  });

  it('returns encShares + a fresh ephemeralEOA on the happy path', async () => {
    const result = await useCase.execute({
      userId: USER_ID,
      accountAddress: KERNEL,
      tokenAddress: TOKEN_ACTIVE,
      sharesAmount: 500n,
    });

    expect(result.encShares.ctHash).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(result.encShares.securityZone).toBe(0);
    expect(result.encShares.utype).toBe(5);
    expect(result.encShares.signature).toBe('0xdeadbeef');
    expect(result.ephemeralEOA).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // fhe-worker received setAccount-binding kernel address + correct type.
    expect(fhe.callLog).toHaveLength(1);
    expect(fhe.callLog[0]!.userAddress).toBe(KERNEL);
    expect(fhe.callLog[0]!.items).toEqual([{ type: 'euint128', value: '500' }]);
  });

  it('mints a different ephemeralEOA on each call (no key reuse)', async () => {
    const r1 = await useCase.execute({
      userId: USER_ID,
      accountAddress: KERNEL,
      tokenAddress: TOKEN_ACTIVE,
      sharesAmount: 1n,
    });
    const r2 = await useCase.execute({
      userId: USER_ID,
      accountAddress: KERNEL,
      tokenAddress: TOKEN_ACTIVE,
      sharesAmount: 1n,
    });
    expect(r1.ephemeralEOA).not.toBe(r2.ephemeralEOA);
  });

  // ── Revoke kill-switch gate (Wave 5, 2026-05-24) ──

  it('rejects with 403 when there is no active scoped session (revoked / expired)', async () => {
    const { repo, findLatestActive } = makeScopedRepo(false);
    const gated = new EncryptSharesForPurchaseUseCase(
      fhe as unknown as FheWorkerClient,
      tokenRepo,
      repo,
    );
    await expect(
      gated.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // The gate keyed the lookup on the JWT subject + the MCP surface.
    expect(findLatestActive).toHaveBeenCalledWith(USER_ID, 'mcp', expect.any(Number));
  });

  it('does NOT encrypt (no fhe-worker call) when the session is revoked', async () => {
    const gated = new EncryptSharesForPurchaseUseCase(
      fhe as unknown as FheWorkerClient,
      tokenRepo,
      makeScopedRepo(false).repo,
    );
    await expect(
      gated.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fhe.callLog).toHaveLength(0);
  });

  it('passes the gate when an active session exists, then encrypts', async () => {
    const result = await useCase.execute({
      userId: USER_ID,
      accountAddress: KERNEL,
      tokenAddress: TOKEN_ACTIVE,
      sharesAmount: 7n,
    });
    expect(result.encShares.ctHash).toMatch(/^0x/);
    expect(fhe.callLog).toHaveLength(1);
  });

  it('rejects accountAddress that is not a 0x-prefixed 20-byte hex address with 400', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: 'not-an-address',
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects accountAddress zero address with 400', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: '0x0000000000000000000000000000000000000000',
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects sharesAmount === 0 with 400', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 0n,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects sharesAmount > uint128 max with 400', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n << 128n,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects unknown token with 404', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: '0x0000000000000000000000000000000000000abc',
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects winding_down token with 409', async () => {
    await expect(
      useCase.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_WINDDOWN,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('surfaces fhe-worker errors as 500', async () => {
    const sadFhe: StubbedFheWorker = {
      callLog: [],
      encryptBatchForAccount: vi.fn(async () => {
        throw ApplicationHttpError.internalError('FHE worker not ready');
      }),
    } as unknown as StubbedFheWorker;
    const sadUseCase = new EncryptSharesForPurchaseUseCase(
      sadFhe as unknown as FheWorkerClient,
      tokenRepo,
      makeScopedRepo(true).repo,
    );
    await expect(
      sadUseCase.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it('refuses an empty result array from the fhe-worker', async () => {
    const emptyFhe: StubbedFheWorker = {
      callLog: [],
      encryptBatchForAccount: vi.fn(async () => ({
        results: [],
        totalEncryptionTimeMs: 0,
      })),
    } as unknown as StubbedFheWorker;
    const useCase2 = new EncryptSharesForPurchaseUseCase(
      emptyFhe as unknown as FheWorkerClient,
      tokenRepo,
      makeScopedRepo(true).repo,
    );
    await expect(
      useCase2.execute({
        userId: USER_ID,
        accountAddress: KERNEL,
        tokenAddress: TOKEN_ACTIVE,
        sharesAmount: 1n,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
