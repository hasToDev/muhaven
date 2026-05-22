import { describe, it, expect, beforeEach } from 'vitest';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import {
  MintScopedSessionConflictError,
  MintScopedSessionUseCase,
} from '../mint-scoped-session.use-case.js';
import { MemoryAgentStateRepository } from '../../../../../infrastructure/repository/memory/memory-agent-state.repository.js';
import { MemoryScopedSessionRepository } from '../../../../../infrastructure/repository/memory/memory-scoped-session.repository.js';
import type { MintScopedSessionDto } from '../../../../dto/agent/policy.dto.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const SUBSCRIPTION_ADDR = '0xCcCC000000000000000000000000000000000003';
const PURCHASE_SELECTOR = '0xdeadbeef';
const SIGNER = '0xAaAa000000000000000000000000000000000001';

function makeDto(overrides: Partial<MintScopedSessionDto['snapshot']> = {}): MintScopedSessionDto {
  return {
    surface: Surface.MCP,
    maxPerOpUsd6: '100000000',
    snapshot: {
      sessionId: 'session-abc-123',
      mode: 'scoped',
      signerAddress: SIGNER,
      targetContracts: [SUBSCRIPTION_ADDR],
      selectorCaps: [
        {
          selector: PURCHASE_SELECTOR,
          capArgIndex: 2,
          maxAmount: '1000000',
        },
      ],
      validUntilSec: NOW_SEC + 4 * 60 * 60, // 4h TTL
      mintedAtSec: NOW_SEC,
      ...overrides,
    },
  };
}

describe('MintScopedSessionUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let scopedRepo: MemoryScopedSessionRepository;
  let useCase: MintScopedSessionUseCase;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    scopedRepo = new MemoryScopedSessionRepository();
    useCase = new MintScopedSessionUseCase(stateRepo, scopedRepo);
  });

  async function seedTier(tier: Tier, userId = 'u1', surface: Surface = Surface.MCP): Promise<void> {
    await stateRepo.upsert(
      new AgentUserState({
        userId,
        surface,
        tier,
        pausedAt: null,
        pauseTrigger: null,
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        confirmedActionCount: 5,
        riskQuestionnaireComplete: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  it('happy path — mints + persists when user at Scoped tier', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    expect(result.session.sessionId).toBe('session-abc-123');
    expect(result.session.maxPerOpUsd6).toBe(100_000_000n);
    expect(result.session.signerAddress).toBe(SIGNER.toLowerCase());
    expect(result.session.targetContracts).toEqual([SUBSCRIPTION_ADDR.toLowerCase()]);
    expect(result.session.selectorCaps[0]?.selector).toBe(PURCHASE_SELECTOR);

    const persisted = await scopedRepo.findById('session-abc-123');
    expect(persisted).not.toBeNull();
    expect(persisted?.userId).toBe('u1');
  });

  it('rejects with 412 when no state row for surface', async () => {
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 412,
      name: 'ApplicationHttpError',
    });
  });

  it('rejects with 412 when state tier is PolicyBound (one step below Scoped)', async () => {
    await seedTier(Tier.PolicyBound);
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toThrow(/tier is policy-bound/);
  });

  it('rejects with 412 when state tier is Advisory', async () => {
    await seedTier(Tier.Advisory);
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toThrow(/tier is advisory/);
  });

  it('rejects with 409 when an active session for (user, surface) already exists', async () => {
    await seedTier(Tier.Scoped);
    await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    const second = useCase.execute({
      userId: 'u1',
      dto: makeDto({ sessionId: 'session-abc-456' }),
      now: NOW,
    });
    await expect(second).rejects.toBeInstanceOf(MintScopedSessionConflictError);
    await expect(second).rejects.toMatchObject({
      statusCode: 409,
      existingSessionId: 'session-abc-123',
    });
  });

  it('rejects with 422 when validUntilSec is not in the future', async () => {
    await seedTier(Tier.Scoped);
    await expect(
      useCase.execute({
        userId: 'u1',
        dto: makeDto({ validUntilSec: NOW_SEC }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects with 422 when mintedAtSec drifts > 5 min from server clock', async () => {
    await seedTier(Tier.Scoped);
    // 6 minutes ahead of server clock
    await expect(
      useCase.execute({
        userId: 'u1',
        dto: makeDto({ mintedAtSec: NOW_SEC + 6 * 60 }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('accepts mintedAtSec within +5 min skew tolerance', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({ mintedAtSec: NOW_SEC + 4 * 60 }),
      now: NOW,
    });
    expect(result.session.mintedAtSec).toBe(NOW_SEC + 4 * 60);
  });

  it('accepts mintedAtSec within -5 min skew tolerance', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({ mintedAtSec: NOW_SEC - 4 * 60 }),
      now: NOW,
    });
    expect(result.session.mintedAtSec).toBe(NOW_SEC - 4 * 60);
  });

  it('lowercases signerAddress + targetContracts + permissionId during persist', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({
        signerAddress: '0xAAaABbBb0000000000000000000000000000000F',
        targetContracts: ['0xCcCcDdDd0000000000000000000000000000000E'],
        permissionId: '0xDeAdBeEf',
      }),
      now: NOW,
    });
    expect(result.session.signerAddress).toBe('0xaaaabbbb0000000000000000000000000000000f');
    expect(result.session.targetContracts).toEqual([
      '0xccccdddd0000000000000000000000000000000e',
    ]);
    expect(result.session.permissionId).toBe('0xdeadbeef');
  });

  it('stores totalSpentUsd6=0 on fresh mint regardless of dto input', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    expect(result.session.totalSpentUsd6).toBe(0n);
  });
});
