/**
 * Phase 9.A · Expansion (F2) — deploy-token use-case tests.
 *
 * Coverage:
 *   - happy path: row transitions running → succeeded with result address
 *   - failure path: row transitions to failed with errorMessage + lastStep
 *   - SYMBOL_TAKEN: pre-check rejects before any state change
 *   - non-approved issuer rejected with 403 NOT_APPROVED_ISSUER
 *   - progress callback bridges to deployEventBus
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeployTokenUseCase } from '../deploy-token.use-case.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { User } from '../../../../domain/auth/model/user.js';
import {
  IssuerTokenDeploy,
  type DeployStepKey,
} from '../../../../domain/issuer-onboarding/model/issuer-token-deploy.js';
import type { IIssuerTokenDeployRepository } from '../../../../domain/issuer-onboarding/repository/issuer-token-deploy.repository.js';
import type {
  DeployTokenLibrary,
  DeployProgressCallback,
} from '../../../../infrastructure/onboarding/deploy-token.library.js';
import { deployEventBus, type DeployEvent } from '../../../../infrastructure/onboarding/deploy-event-bus.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { Address, Hex } from 'viem';

const WALLET = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12' as Address;
const TOKEN_ADDR = '0xfEED11FEED2222FEED3333FEED4444FEED5555AA' as Address;

class StubDeployRepo implements IIssuerTokenDeployRepository {
  rows = new Map<string, IssuerTokenDeploy>();
  async save(d: IssuerTokenDeploy): Promise<void> {
    this.rows.set(d.id, d);
  }
  async findById(id: string): Promise<IssuerTokenDeploy | null> {
    return this.rows.get(id) ?? null;
  }
  async updateProgress(id: string, lastStep: DeployStepKey): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    this.rows.set(
      id,
      new IssuerTokenDeploy({
        ...r,
        config: r.config,
        lastStep,
      }),
    );
  }
  async finalize(
    id: string,
    update: {
      status: 'succeeded' | 'failed';
      resultTokenAddress?: string | null;
      errorMessage?: string | null;
      lastStep?: DeployStepKey | null;
    },
  ): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    this.rows.set(
      id,
      new IssuerTokenDeploy({
        ...r,
        config: r.config,
        status: update.status,
        resultTokenAddress: update.resultTokenAddress ?? r.resultTokenAddress,
        errorMessage: update.errorMessage ?? r.errorMessage,
        lastStep: update.lastStep ?? r.lastStep,
        completedAt: new Date(),
      }),
    );
  }
}

function makeStubLibrary(opts: {
  existingTokenForSymbol?: Address;
  failOnDeploy?: boolean;
}): DeployTokenLibrary {
  return {
    findExistingTokenBySymbol: async () => opts.existingTokenForSymbol ?? null,
    deploy: async (
      _input: unknown,
      onProgress: DeployProgressCallback,
    ) => {
      // Simulate a single happy-path step + register, then either succeed or fail.
      await onProgress({ step: 'deploy_token', status: 'pending' });
      await onProgress({
        step: 'deploy_token',
        status: 'mined',
        txHash: '0xfeedtx' as Hex,
      });
      await onProgress({ step: 'register_token', status: 'pending' });
      if (opts.failOnDeploy) {
        throw new Error('Fhenix coprocessor unreachable');
      }
      await onProgress({
        step: 'register_token',
        status: 'mined',
        txHash: '0xreg00tx' as Hex,
      });
      return {
        tokenAddress: TOKEN_ADDR,
        treasuryAddress: '0xTreasury' as Address,
        queueAddress: '0xQueue' as Address,
        registeredOracle: '0xOracle' as Address,
        txHashes: {} as Record<DeployStepKey, Hex[]>,
      };
    },
  } as unknown as DeployTokenLibrary;
}

const DTO = {
  symbol: 'TBILL2',
  name: 'MuHaven Treasury Bill Series 2',
  asset_class: 'treasury' as const,
  initial_nav: '1000000',
  min_investment: '1',
  yield_schedule: 'monthly' as const,
};

describe('DeployTokenUseCase', () => {
  let userRepo: MemoryUserRepository;
  let deployRepo: StubDeployRepo;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    process.env.JWT_ISSUER = 'test-issuer';

    userRepo = new MemoryUserRepository();
    deployRepo = new StubDeployRepo();
    await userRepo.save(
      new User({
        id: 'user-1',
        walletAddress: WALLET,
        walletProvider: 'zerodev',
        role: 'issuer',
        createdAt: new Date(),
        issuerStatus: 'approved',
      }),
    );
  });

  it('returns 202 + deploy_id and finalises to succeeded with result token', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
    );
    const events: DeployEvent[] = [];
    const tap = (e: DeployEvent) => events.push(e);

    const result = await useCase.start('user-1', DTO);
    expect(result.status).toBe('running');
    expect(result.deploy_id).toMatch(/^[0-9a-f-]{36}$/);

    // Subscribe AFTER start — bus replays buffered events.
    const unsub = deployEventBus.subscribe(result.deploy_id, tap);
    // Wait for fire-and-forget deploy to settle.
    await new Promise((r) => setTimeout(r, 50));
    unsub();

    const row = await deployRepo.findById(result.deploy_id);
    expect(row?.status).toBe('succeeded');
    expect(row?.resultTokenAddress?.toLowerCase()).toBe(TOKEN_ADDR.toLowerCase());

    // The event buffer carries every progress event + the terminal finalize.
    expect(events.some((e) => e.step === 'finalize' && e.status === 'succeeded')).toBe(true);
    expect(events.some((e) => e.step === 'deploy_token' && e.status === 'pending')).toBe(true);
  });

  it('finalises to failed with error message when the library throws', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({ failOnDeploy: true }),
    );
    const result = await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    const row = await deployRepo.findById(result.deploy_id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('Fhenix coprocessor');
  });

  it('rejects with 409 SYMBOL_TAKEN when registry already has the symbol', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({ existingTokenForSymbol: '0xExisting' as Address }),
    );
    await expect(useCase.start('user-1', DTO)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'SYMBOL_TAKEN' },
    });
  });

  it('rejects with 403 NOT_APPROVED_ISSUER for non-approved issuer', async () => {
    await userRepo.save(
      new User({
        id: 'user-1',
        walletAddress: WALLET,
        walletProvider: 'zerodev',
        role: 'investor',
        createdAt: new Date(),
        issuerStatus: 'unregistered',
      }),
    );
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
    );
    await expect(useCase.start('user-1', DTO)).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
    await expect(useCase.start('user-1', DTO)).rejects.toMatchObject({
      statusCode: 403,
      details: { code: 'NOT_APPROVED_ISSUER' },
    });
  });
});
