import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentConfirmTokenRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';
import { GetPolicyStateUseCase } from '../../policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { ConfirmTokenService } from '../../policy/confirm-token.service.js';
import {
  CheckProtectionCoverageToolUseCase,
  ExplainKycAttestationToolUseCase,
  ProposeGovernanceVoteToolUseCase,
  CastEncryptedVoteToolUseCase,
} from '../index.js';
import { RwaToken, type AssetClass } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { PublicClient } from 'viem';
import { CastEncryptedVoteDtoSchema } from '../../../../dto/agent/p11-tool.dto.js';

const NOW = new Date('2026-05-07T00:00:00.000Z');
const USER_ID = 'investor-user-1';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = '0x3e570bdb3928488b0092fbe149d4b7e8d12cb178';
const PROTECTION_ADDR = '0x1111111111111111111111111111111111111111';
const KYC_REGISTRY_ADDR = '0x2222222222222222222222222222222222222222';
const GOVERNANCE_ADDR = '0x3333333333333333333333333333333333333333';
const ISSUER_ADDR = '0x9999999999999999999999999999999999999999';

class StubRwaTokenRepo implements IRwaTokenRepository {
  tokens = new Map<string, RwaToken>();
  async save(t: RwaToken): Promise<void> {
    this.tokens.set(t.address.toLowerCase(), t);
  }
  async findById(_id: string): Promise<RwaToken | null> {
    return null;
  }
  async findAll(): Promise<RwaToken[]> {
    return [...this.tokens.values()];
  }
  async findByAddress(address: string): Promise<RwaToken | null> {
    return this.tokens.get(address.toLowerCase()) ?? null;
  }
  async findByIssuer(_addr: string): Promise<RwaToken[]> {
    return [];
  }
  async findByStatus(_s: never): Promise<RwaToken[]> {
    return [];
  }
  async update(t: RwaToken): Promise<void> {
    this.tokens.set(t.address.toLowerCase(), t);
  }
  async updateIssuer(): Promise<void> {}
  async updatePausedStatus(): Promise<void> {}
}

function activeToken(): RwaToken {
  return new RwaToken({
    id: 'tok_1',
    address: TOKEN,
    name: 'Treasury Bond Fund',
    symbol: 'TBILL1',
    issuerAddress: ISSUER_ADDR,
    kycTier: 1,
    assetClass: 'treasury' as AssetClass,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function pausedToken(): RwaToken {
  return new RwaToken({
    id: 'tok_2',
    address: TOKEN,
    name: 'Treasury Bond Fund',
    symbol: 'TBILL1',
    issuerAddress: ISSUER_ADDR,
    kycTier: 1,
    assetClass: 'treasury' as AssetClass,
    status: 'paused',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function fakePublicClient(reads: Map<string, unknown>): PublicClient {
  return {
    readContract: vi.fn(async (args: { functionName: string; args?: unknown[] }) => {
      // Use functionName + first arg (if any) as a coarse cache key.
      const key = `${args.functionName}:${(args.args?.[0] ?? '').toString().toLowerCase()}`;
      if (!reads.has(key)) {
        throw new Error(`unexpected readContract call: ${key}`);
      }
      return reads.get(key)!;
    }),
  } as unknown as PublicClient;
}

describe('CheckProtectionCoverageToolUseCase', () => {
  let rwaRepo: StubRwaTokenRepo;
  beforeEach(() => {
    rwaRepo = new StubRwaTokenRepo();
    rwaRepo.tokens.set(TOKEN.toLowerCase(), activeToken());
  });

  it('returns 404 when the token is not registered', async () => {
    const uc = new CheckProtectionCoverageToolUseCase({
      rwaTokenRepo: rwaRepo,
      defaultProtectionAddress: PROTECTION_ADDR,
      rpcUrl: 'http://stub',
    });
    await expect(
      uc.execute({ tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
    ).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('returns not_deployed when DEFAULT_PROTECTION_ADDRESS is unset', async () => {
    const uc = new CheckProtectionCoverageToolUseCase({ rwaTokenRepo: rwaRepo });
    const out = await uc.execute({ tokenAddress: TOKEN });
    expect(out.status).toBe('not_deployed');
    expect(out.protectionId).toBeNull();
    expect(out.reserveRateBps).toBeNull();
    expect(out.explanation).toMatch(/not yet deployed/);
  });

  it('returns no_protection when tokenProtection returns 0', async () => {
    const reads = new Map<string, unknown>([[`tokenProtection:${TOKEN.toLowerCase()}`, 0n]]);
    const uc = new CheckProtectionCoverageToolUseCase({
      rwaTokenRepo: rwaRepo,
      defaultProtectionAddress: PROTECTION_ADDR,
      rpcUrl: 'http://stub',
      publicClientFactory: () => fakePublicClient(reads),
    });
    const out = await uc.execute({ tokenAddress: TOKEN });
    expect(out.status).toBe('no_protection');
    expect(out.protectionId).toBeNull();
    expect(out.reserveRateBps).toBeNull();
  });

  it('packages the active branch with reserveRateBps + explanation', async () => {
    const reads = new Map<string, unknown>([
      [`tokenProtection:${TOKEN.toLowerCase()}`, 5n],
      [
        `getProtection:5`,
        [
          TOKEN as `0x${string}`,
          ISSUER_ADDR as `0x${string}`,
          500n /* reserveRateBps = 5.00% */,
          0n /* encReserve handle id */,
          1 /* status: ACTIVE */,
          0n,
          0n,
        ],
      ],
    ]);
    const uc = new CheckProtectionCoverageToolUseCase({
      rwaTokenRepo: rwaRepo,
      defaultProtectionAddress: PROTECTION_ADDR,
      rpcUrl: 'http://stub',
      publicClientFactory: () => fakePublicClient(reads),
    });
    const out = await uc.execute({ tokenAddress: TOKEN });
    expect(out.status).toBe('active');
    expect(out.protectionId).toBe('5');
    expect(out.reserveRateBps).toBe(500);
    expect(out.issuerAddress).toBe(ISSUER_ADDR);
    expect(out.explanation).toMatch(/5\.00%/);
    expect(out.explanation).toMatch(/TBILL1/);
  });

  it('handles each active-state status code', async () => {
    const cases: Array<[number, string]> = [
      [0, 'inactive'],
      [1, 'active'],
      [2, 'triggered'],
      [3, 'distributing'],
      [4, 'completed'],
    ];
    for (const [statusCode, expectedLabel] of cases) {
      const reads = new Map<string, unknown>([
        [`tokenProtection:${TOKEN.toLowerCase()}`, 5n],
        [
          `getProtection:5`,
          [
            TOKEN as `0x${string}`,
            ISSUER_ADDR as `0x${string}`,
            500n,
            0n,
            statusCode,
            0n,
            0n,
          ],
        ],
      ]);
      const uc = new CheckProtectionCoverageToolUseCase({
        rwaTokenRepo: rwaRepo,
        defaultProtectionAddress: PROTECTION_ADDR,
        rpcUrl: 'http://stub',
        publicClientFactory: () => fakePublicClient(reads),
      });
      const out = await uc.execute({ tokenAddress: TOKEN });
      expect(out.status).toBe(expectedLabel);
    }
  });

  it('refuses partial config (address set, RPC missing)', async () => {
    const uc = new CheckProtectionCoverageToolUseCase({
      rwaTokenRepo: rwaRepo,
      defaultProtectionAddress: PROTECTION_ADDR,
    });
    await expect(uc.execute({ tokenAddress: TOKEN })).rejects.toThrow(
      /P11_RPC_NOT_CONFIGURED/,
    );
  });
});

describe('ExplainKycAttestationToolUseCase', () => {
  it('returns not_deployed + static narrative when registry address is unset', async () => {
    const uc = new ExplainKycAttestationToolUseCase({});
    const out = await uc.execute(WALLET, {});
    expect(out.status).toBe('not_deployed');
    expect(out.investorAddress).toBe(WALLET.toLowerCase());
    expect(out.attestationSigner).toBeNull();
    expect(out.defaultValidityPeriodSec).toBeNull();
    expect(out.jurisdictionHash).toBeNull();
    expect(out.narrative).toMatch(/EIP-712/);
  });

  it('defaults investorAddress to caller wallet when omitted', async () => {
    const uc = new ExplainKycAttestationToolUseCase({});
    const out = await uc.execute(WALLET, {});
    expect(out.investorAddress).toBe(WALLET.toLowerCase());
  });

  it('honours an explicit investorAddress override', async () => {
    const uc = new ExplainKycAttestationToolUseCase({});
    const explicit = '0xcafecafecafecafecafecafecafecafecafecafe';
    const out = await uc.execute(WALLET, { investorAddress: explicit });
    expect(out.investorAddress).toBe(explicit.toLowerCase());
  });

  it('refuses partial config (address set, RPC missing)', async () => {
    const uc = new ExplainKycAttestationToolUseCase({
      kycAttestationRegistryAddress: KYC_REGISTRY_ADDR,
    });
    await expect(uc.execute(WALLET, {})).rejects.toThrow(/P11_RPC_NOT_CONFIGURED/);
  });

  it('reads + projects on-chain values when configured', async () => {
    const reads = new Map<string, unknown>([
      [`attestationSigner:`, '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed'],
      [`defaultValidityPeriod:`, 86_400n],
      [
        `jurisdictionHashes:${WALLET.toLowerCase()}`,
        '0x' + 'aa'.repeat(32),
      ],
    ]);
    const uc = new ExplainKycAttestationToolUseCase({
      kycAttestationRegistryAddress: KYC_REGISTRY_ADDR,
      rpcUrl: 'http://stub',
      publicClientFactory: () => fakePublicClient(reads),
    });
    const out = await uc.execute(WALLET, {});
    expect(out.status).toBe('live');
    expect(out.attestationSigner).toBe('0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed');
    expect(out.defaultValidityPeriodSec).toBe(86_400);
    expect(out.jurisdictionHash).toBe('0x' + 'aa'.repeat(32));
  });

  it('returns null for jurisdiction when bytes32 == 0', async () => {
    const reads = new Map<string, unknown>([
      [`attestationSigner:`, '0x0000000000000000000000000000000000000000'],
      [`defaultValidityPeriod:`, 0n],
      [`jurisdictionHashes:${WALLET.toLowerCase()}`, '0x' + '00'.repeat(32)],
    ]);
    const uc = new ExplainKycAttestationToolUseCase({
      kycAttestationRegistryAddress: KYC_REGISTRY_ADDR,
      rpcUrl: 'http://stub',
      publicClientFactory: () => fakePublicClient(reads),
    });
    const out = await uc.execute(WALLET, {});
    expect(out.attestationSigner).toBeNull();
    expect(out.jurisdictionHash).toBeNull();
    expect(out.defaultValidityPeriodSec).toBe(0);
  });
});

describe('ProposeGovernanceVoteToolUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;
  let rwaRepo: StubRwaTokenRepo;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
    rwaRepo = new StubRwaTokenRepo();
    rwaRepo.tokens.set(TOKEN.toLowerCase(), activeToken());
  });

  it('refuses with P11_NOT_DEPLOYED when address unset', async () => {
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      {},
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, proposalType: 0 },
        NOW,
      ),
    ).rejects.toThrow(/P11_NOT_DEPLOYED/);
  });

  it('refuses with P11_MISCONFIGURED on a malformed address', async () => {
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: 'not-an-address' },
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, proposalType: 0 },
        NOW,
      ),
    ).rejects.toThrow(/P11_MISCONFIGURED/);
  });

  it('refuses with 423 when surface is paused', async () => {
    await stateRepo.upsert(
      new AgentUserState({
        userId: USER_ID,
        surface: Surface.HavenBot,
        tier: Tier.Paused,
        pausedAt: NOW,
        pauseTrigger: 'T-1-pause',
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        confirmedActionCount: 0,
        riskQuestionnaireComplete: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: GOVERNANCE_ADDR },
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, proposalType: 0 },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('refuses when token is not registered', async () => {
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: GOVERNANCE_ADDR },
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', proposalType: 0 },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('refuses when token is paused', async () => {
    rwaRepo.tokens.set(TOKEN.toLowerCase(), pausedToken());
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: GOVERNANCE_ADDR },
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, proposalType: 0 },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('refuses Wave-5-reserved proposalType=1', async () => {
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: GOVERNANCE_ADDR },
    );
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, proposalType: 1 },
        NOW,
      ),
    ).rejects.toThrow(/reserved for Wave 5/);
  });

  it('mints an ActionDescriptor with the round-tripable preview', async () => {
    const uc = new ProposeGovernanceVoteToolUseCase(
      rwaRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
      { encryptedGovernanceAddress: GOVERNANCE_ADDR },
    );
    const out = await uc.execute(
      { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
      { tokenAddress: TOKEN, proposalType: 0 },
      NOW,
    );
    expect(out.kind).toBe('governance_propose');
    expect(out.preview.governanceAddress).toBe(GOVERNANCE_ADDR.toLowerCase());
    expect(out.preview.proposalType).toBe(0);
    expect(out.preview.proposalTypeLabel).toBe('TRIGGER_PROTECTION');
    expect(out.preview.requestedAtSec).toBe(Math.floor(NOW.getTime() / 1000));
    expect(out.sdkCall.contractName).toBe('EncryptedGovernance');
    expect(out.sdkCall.functionName).toBe('createProposal');
    // ConfirmModal commit round-trip — the preview pinned in the
    // descriptor must be byte-equivalent to the actionPayload that
    // ConfirmTokenService stored, so the action-hash check on commit
    // matches.
    const stored = await confirmRepo.findByToken(out.confirmTokenId);
    expect(stored?.actionPayload).toMatchObject({
      tool: 'muhaven_propose_governance_vote',
      tokenAddress: TOKEN.toLowerCase(),
      proposalType: 0,
      governanceAddress: GOVERNANCE_ADDR.toLowerCase(),
      requestedAtSec: out.preview.requestedAtSec,
    });
  });
});

describe('CastEncryptedVoteToolUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
  });

  it('refuses with P11_NOT_DEPLOYED when address unset', async () => {
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {});
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { proposalId: '1', voteYes: true },
        NOW,
      ),
    ).rejects.toThrow(/P11_NOT_DEPLOYED/);
  });

  it('refuses paused surface', async () => {
    await stateRepo.upsert(
      new AgentUserState({
        userId: USER_ID,
        surface: Surface.HavenBot,
        tier: Tier.Paused,
        pausedAt: NOW,
        pauseTrigger: 'T-1-pause',
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        confirmedActionCount: 0,
        riskQuestionnaireComplete: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {
      encryptedGovernanceAddress: GOVERNANCE_ADDR,
    });
    await expect(
      uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { proposalId: '1', voteYes: true },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ApplicationHttpError);
  });

  it('mints a vote ActionDescriptor with the cleartext preview', async () => {
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {
      encryptedGovernanceAddress: GOVERNANCE_ADDR,
    });
    const out = await uc.execute(
      { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
      { proposalId: '7', voteYes: true },
      NOW,
    );
    expect(out.kind).toBe('governance_vote');
    expect(out.preview.proposalId).toBe('7');
    expect(out.preview.voteYes).toBe(true);
    expect(out.preview.governanceAddress).toBe(GOVERNANCE_ADDR.toLowerCase());
    expect(out.summary).toContain('YES');
    expect(out.sdkCall.functionName).toBe('castVote');
    expect(out.sdkCall.args).toMatchObject({ proposalId: '7', voteYes: true });
  });

  it('mints a NO vote variant', async () => {
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {
      encryptedGovernanceAddress: GOVERNANCE_ADDR,
    });
    const out = await uc.execute(
      { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
      { proposalId: '7', voteYes: false },
      NOW,
    );
    expect(out.preview.voteYes).toBe(false);
    expect(out.summary).toContain('NO');
  });

  it('persists the round-tripable actionPayload in agent_confirm_tokens', async () => {
    // The frontend echoes the actionPayload back in the commit POST so the
    // ConfirmTokenService action-hash recovery succeeds. This test pins the
    // exact stored shape so a Wave-5 frontend that omits any field would
    // surface as a regression here, BEFORE the frontend ships.
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {
      encryptedGovernanceAddress: GOVERNANCE_ADDR,
    });
    const out = await uc.execute(
      { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
      { proposalId: '42', voteYes: true },
      NOW,
    );
    const stored = await confirmRepo.findByToken(out.confirmTokenId);
    expect(stored).not.toBeNull();
    expect(stored!.actionPayload).toEqual({
      tool: 'muhaven_cast_encrypted_vote',
      action: 'governance_vote',
      proposalId: '42',
      voteYes: true,
      governanceAddress: GOVERNANCE_ADDR.toLowerCase(),
      requestedAtSec: Math.floor(NOW.getTime() / 1000),
    });
  });

  it('refuses proposalId="0" + leading-zero strings at the DTO boundary', () => {
    // Defence-in-depth: the DTO regex `^[1-9]\d*$` rejects "0" + leading-zero
    // strings. Pin the failure so a Wave-5 schema relax can't silently allow
    // proposalId=0 commits (the contract reverts but the audit row would
    // still write before the revert reaches the indexer).
    expect(() => CastEncryptedVoteDtoSchema.parse({ proposalId: '0', voteYes: true })).toThrow();
    expect(() => CastEncryptedVoteDtoSchema.parse({ proposalId: '01', voteYes: true })).toThrow();
    expect(() => CastEncryptedVoteDtoSchema.parse({ proposalId: '', voteYes: true })).toThrow();
    expect(() => CastEncryptedVoteDtoSchema.parse({ proposalId: '-1', voteYes: true })).toThrow();
    // Sanity: the canonical form is accepted.
    expect(() => CastEncryptedVoteDtoSchema.parse({ proposalId: '1', voteYes: true })).not.toThrow();
    expect(() =>
      CastEncryptedVoteDtoSchema.parse({ proposalId: '1234567890', voteYes: false }),
    ).not.toThrow();
  });

  it('does NOT include voteYes in the audit metadata (privacy invariant)', async () => {
    const uc = new CastEncryptedVoteToolUseCase(getPolicy, confirmTokens, appendAudit, {
      encryptedGovernanceAddress: GOVERNANCE_ADDR,
    });
    await uc.execute(
      { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
      { proposalId: '7', voteYes: true },
      NOW,
    );
    const page = await auditRepo.findByUserId(USER_ID);
    const lastEvent = page.items[page.items.length - 1];
    expect(lastEvent).toBeDefined();
    const metadata = lastEvent!.metadata as Record<string, unknown>;
    expect(metadata.tool).toBe('muhaven_cast_encrypted_vote');
    expect(metadata.proposalId).toBe('7');
    // The privacy guarantee — audit log must not leak which way the
    // user voted, even to a backend operator with audit-log read access.
    expect(metadata).not.toHaveProperty('voteYes');
  });
});
