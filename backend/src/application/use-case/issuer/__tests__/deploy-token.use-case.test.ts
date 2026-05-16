/**
 * Phase 9.A · Expansion (F2) — deploy-token use-case tests.
 *
 * Coverage:
 *   - happy path: row transitions running → succeeded with result address
 *   - happy path: rwa_tokens row written as paused (closes /tokens-empty
 *     gap; mirrors seed-demo-issuers shape)
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
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { RwaToken, TokenStatus } from '../../../../domain/token-registry/model/rwa-token.js';
import type {
  DeployTokenLibrary,
  DeployProgressCallback,
} from '../../../../infrastructure/onboarding/deploy-token.library.js';
import { deployEventBus, type DeployEvent } from '../../../../infrastructure/onboarding/deploy-event-bus.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { Address, Hex } from 'viem';

const WALLET = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12' as Address;
const TOKEN_ADDR = '0xfEED11FEED2222FEED3333FEED4444FEED5555AA' as Address;
const YIELD_SNAPSHOT_ADDR = '0xbEEBee11BEEBee2222BEEbEE3333BeEbeE4444Cc' as Address;

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

class StubRwaTokenRepo implements IRwaTokenRepository {
  rows: RwaToken[] = [];
  async save(t: RwaToken): Promise<void> {
    this.rows.push(t);
  }
  async findById(id: string): Promise<RwaToken | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findAll(): Promise<RwaToken[]> {
    return [...this.rows];
  }
  async findByAddress(address: string): Promise<RwaToken | null> {
    return this.rows.find((r) => r.address.toLowerCase() === address.toLowerCase()) ?? null;
  }
  async findByIssuer(issuerAddress: string): Promise<RwaToken[]> {
    return this.rows.filter(
      (r) => r.issuerAddress.toLowerCase() === issuerAddress.toLowerCase(),
    );
  }
  async findByStatus(status: TokenStatus): Promise<RwaToken[]> {
    return this.rows.filter((r) => r.status === status);
  }
  async update(t: RwaToken): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === t.id);
    if (idx >= 0) this.rows[idx] = t;
  }
  async updateIssuer(tokenAddress: string, newIssuer: string): Promise<void> {
    const row = await this.findByAddress(tokenAddress);
    if (row) {
      // Stub mutates in place; the production repo issues a SQL UPDATE.
      (row as { issuerAddress: string }).issuerAddress = newIssuer;
    }
  }

  async updatePausedStatus(tokenAddress: string, paused: boolean): Promise<void> {
    const row = await this.findByAddress(tokenAddress);
    if (!row) return;
    (row as { status: TokenStatus }).status = paused ? 'paused' : 'active';
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
        // Wave 5+ per-token YieldSnapshot binding (2026-05-23): the
        // library now deploys a per-token snapshot proxy and returns
        // its address. The use case persists this into
        // `rwa_tokens.yield_snapshot_address`.
        yieldSnapshotAddress: YIELD_SNAPSHOT_ADDR,
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
  let rwaTokenRepo: StubRwaTokenRepo;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    process.env.JWT_ISSUER = 'test-issuer';

    userRepo = new MemoryUserRepository();
    deployRepo = new StubDeployRepo();
    rwaTokenRepo = new StubRwaTokenRepo();
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
      rwaTokenRepo,
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

  it('writes rwa_tokens row as paused on success so /tokens reflects the deploy immediately', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
      rwaTokenRepo,
    );

    const result = await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    const written = await rwaTokenRepo.findByAddress(TOKEN_ADDR);
    expect(written).not.toBeNull();
    expect(written?.symbol).toBe(DTO.symbol);
    expect(written?.name).toBe(DTO.name);
    expect(written?.assetClass).toBe(DTO.asset_class);
    expect(written?.minInvestment).toBe(DTO.min_investment);
    expect(written?.yieldSchedule).toBe(DTO.yield_schedule);
    expect(written?.status).toBe('paused');
    expect(written?.kycTier).toBe(0);
    expect(written?.issuerAddress.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(written?.pausedAt).toBeInstanceOf(Date);

    // The deploy row still finalises succeeded — both rows are coherent.
    const row = await deployRepo.findById(result.deploy_id);
    expect(row?.status).toBe('succeeded');
  });

  it('persists the per-token YieldSnapshot address on the rwa_tokens row (Pick B)', async () => {
    // Wave 5+ per-token YieldSnapshot binding (2026-05-23): the F2
    // wizard deploys a per-token snapshot proxy and returns its
    // address; the use case must persist this so the frontend's
    // `getYieldSnapshot(token)` resolves to the per-token proxy
    // instead of the env-baked singleton. Without this assertion the
    // tenant-isolation guarantee silently regresses (legacy resolution
    // path still works via fallback, but every issuer would share one
    // snapshot's epoch state and ACLs).
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
      rwaTokenRepo,
    );
    await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    const written = await rwaTokenRepo.findByAddress(TOKEN_ADDR);
    expect(written?.yieldSnapshotAddress?.toLowerCase()).toBe(
      YIELD_SNAPSHOT_ADDR.toLowerCase(),
    );
  });

  it('skips rwa_tokens write when row already exists (race with seed:tokens:v35)', async () => {
    // Pre-populate as if `pnpm seed:tokens:v35` ran between register_token
    // mining and this branch — second insert would violate the address PK.
    rwaTokenRepo.rows.push({
      id: 'pre-seeded',
      address: TOKEN_ADDR,
      name: 'Pre-seeded',
      symbol: DTO.symbol,
      issuerAddress: WALLET,
      kycTier: 0,
      assetClass: 'treasury',
      status: 'paused',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as RwaToken);

    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
      rwaTokenRepo,
    );
    await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    // Still exactly one row; the deploy did not append a second.
    const matches = rwaTokenRepo.rows.filter(
      (r) => r.address.toLowerCase() === TOKEN_ADDR.toLowerCase(),
    );
    expect(matches.length).toBe(1);
    expect(matches[0]?.id).toBe('pre-seeded');
    // Pick B round-1 CR-L2 (2026-05-23): re-seed must NOT clobber
    // the wizard's `yield_snapshot_address` column. The pre-seeded
    // row had no snapshot; the wizard write was skipped on this path,
    // so the column stays null — but the SET-clause exclusion in
    // `pg-rwa-token.repository.ts` is the load-bearing guard the
    // PRODUCTION re-seed would respect (this test stub uses an
    // in-memory array, so we pin the no-clobber invariant at the
    // row-shape level).
    expect(matches[0]?.yieldSnapshotAddress).toBeUndefined();
  });

  it('still finalises succeeded when rwa_tokens write throws (operator falls back to seed:tokens:v35)', async () => {
    // Force the repo to throw so the catch branch covers the on-chain
    // commit, deploy-row succeeded, rwa-row failed scenario.
    const throwingRepo = {
      ...rwaTokenRepo,
      save: async () => { throw new Error('db boom'); },
      findByAddress: async () => null,
    } as unknown as IRwaTokenRepository;

    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({}),
      throwingRepo,
    );
    const result = await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    const row = await deployRepo.findById(result.deploy_id);
    expect(row?.status).toBe('succeeded');
    expect(row?.resultTokenAddress?.toLowerCase()).toBe(TOKEN_ADDR.toLowerCase());
  });

  it('finalises to failed with error message when the library throws', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({ failOnDeploy: true }),
      rwaTokenRepo,
    );
    const result = await useCase.start('user-1', DTO);
    await new Promise((r) => setTimeout(r, 50));

    const row = await deployRepo.findById(result.deploy_id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('Fhenix coprocessor');

    // Failed deploy must NOT leave a stray rwa_tokens row behind.
    const stray = await rwaTokenRepo.findByAddress(TOKEN_ADDR);
    expect(stray).toBeNull();
  });

  it('rejects with 409 SYMBOL_TAKEN when registry already has the symbol', async () => {
    const useCase = new DeployTokenUseCase(
      userRepo,
      deployRepo,
      makeStubLibrary({ existingTokenForSymbol: '0xExisting' as Address }),
      rwaTokenRepo,
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
      rwaTokenRepo,
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
