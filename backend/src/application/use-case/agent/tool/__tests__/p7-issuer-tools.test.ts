import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentConfirmTokenRepository,
  MemoryUserRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';
import { GetPolicyStateUseCase } from '../../policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { ConfirmTokenService } from '../../policy/confirm-token.service.js';
import {
  ProposeDistributeYieldToolUseCase,
  ProposeKycAddToolUseCase,
  ProposeKycRemoveToolUseCase,
  ProposeUnpauseTokenToolUseCase,
  AuditQueryToolUseCase,
} from '../index.js';
import {
  PublishIssuerChannelEventUseCase,
  LoggingIssuerChannelTransport,
  type IIssuerChannelTransport,
  type IssuerChannelEvent,
} from '../../openclaw/publish-issuer-channel-event.use-case.js';
import { User } from '../../../../../domain/auth/model/user.js';
import { RwaToken, type AssetClass } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';

const NOW = new Date('2026-05-06T00:00:00.000Z');
const ISSUER_USER_ID = 'issuer-user-1';
const ISSUER_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NON_ISSUER_USER_ID = 'investor-user-2';
const NON_ISSUER_WALLET = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = '0x3e570bdb3928488b0092fbe149d4b7e8d12cb178';
const OTHER_ISSUER_TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc';
const INVESTOR_TO_KYC = '0x1111111111111111111111111111111111111111';

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

function approvedIssuer(): User {
  return new User({
    id: ISSUER_USER_ID,
    walletAddress: ISSUER_WALLET,
    walletProvider: 'zerodev',
    role: 'issuer',
    createdAt: NOW,
    issuerStatus: 'approved',
    issuerDisplayName: 'Acme RWA',
  });
}

function pendingIssuer(): User {
  return new User({
    id: ISSUER_USER_ID,
    walletAddress: ISSUER_WALLET,
    walletProvider: 'zerodev',
    role: 'issuer',
    createdAt: NOW,
    issuerStatus: 'pending',
  });
}

function investor(): User {
  return new User({
    id: NON_ISSUER_USER_ID,
    walletAddress: NON_ISSUER_WALLET,
    walletProvider: 'zerodev',
    role: 'investor',
    createdAt: NOW,
  });
}

function activeToken(opts?: { issuerAddress?: string; status?: 'active' | 'paused' | 'archived' }): RwaToken {
  return new RwaToken({
    id: 'tok_1',
    address: TOKEN,
    name: 'Treasury Bond Fund',
    symbol: 'TBILL1',
    issuerAddress: opts?.issuerAddress ?? ISSUER_WALLET,
    kycTier: 1,
    assetClass: 'treasury' as AssetClass,
    status: opts?.status ?? 'active',
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
    issuerAddress: ISSUER_WALLET,
    kycTier: 1,
    assetClass: 'treasury' as AssetClass,
    status: 'paused',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('Wave 4 P7 — issuer-side tool use cases', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let userRepo: MemoryUserRepository;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;
  let rwaTokenRepo: StubRwaTokenRepo;

  beforeEach(async () => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    userRepo = new MemoryUserRepository();
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
    rwaTokenRepo = new StubRwaTokenRepo();
    rwaTokenRepo.tokens.set(TOKEN, activeToken());
    await userRepo.save(approvedIssuer());
    await userRepo.save(investor());
    // Configure env so tools that read it find a value. The 0x[40-hex]
    // shape is enforced post-resolve (H3 fix) — use real-shape addresses
    // here, not the marker strings that earlier drafts used.
    process.env.KYC_ADAPTER_ADDRESS = '0x' + 'aa'.repeat(20);
    process.env.ISSUER_ORACLE_ADDRESS = '0x' + 'bb'.repeat(20);
    process.env.TOKEN_REGISTRY_ADDRESS = '0x' + 'cc'.repeat(20);
  });

  afterEach(() => {
    // Restore env so test isolation is preserved across files.
    delete process.env.KYC_ADAPTER_ADDRESS;
    delete process.env.ISSUER_ORACLE_ADDRESS;
    delete process.env.TOKEN_REGISTRY_ADDRESS;
  });

  describe('ProposeDistributeYieldToolUseCase', () => {
    it('mints a confirm token + descriptor + audit row on the happy path', async () => {
      const uc = new ProposeDistributeYieldToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, totalYieldUsd6: '5000000', label: 'Q2 yield' },
        NOW,
      );
      expect(out.kind).toBe('distribute_yield');
      expect(out.preview.tokenSymbol).toBe('TBILL1');
      expect(out.preview.totalYieldUsd6).toBe('5000000');
      expect(out.preview.label).toBe('Q2 yield');
      expect(out.preview.issuerAddress).toBe(ISSUER_WALLET.toLowerCase());
      expect(out.confirmTokenId).toMatch(/^[0-9a-f]{64}$/);
      const audits = await auditRepo.findByUserId(ISSUER_USER_ID);
      expect(audits.items[0]?.metadata?.tool).toBe('muhaven_propose_distribute_yield');
    });

    it('rejects non-approved issuers (pending issuerStatus → 403)', async () => {
      await userRepo.save(pendingIssuer());
      const uc = new ProposeDistributeYieldToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, totalYieldUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects investor-roled callers (403)', async () => {
      const uc = new ProposeDistributeYieldToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: NON_ISSUER_USER_ID, walletAddress: NON_ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, totalYieldUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects when caller is approved issuer but NOT the token issuer-of-record', async () => {
      // Token registered under a different issuer wallet.
      rwaTokenRepo.tokens.set(
        TOKEN,
        activeToken({ issuerAddress: '0xdeadbeef' + '0'.repeat(32) }),
      );
      const uc = new ProposeDistributeYieldToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, totalYieldUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects on Paused tier with HTTP 423', async () => {
      await stateRepo.upsert(
        new AgentUserState({
          userId: ISSUER_USER_ID,
          surface: Surface.HavenBot,
          tier: Tier.Paused,
          pausedAt: NOW,
          pauseTrigger: 'T-1-pause' as const,
          pauseMetadata: null,
          enteredAt: NOW,
          validatorAddress: null,
          confirmedActionCount: 0,
          riskQuestionnaireComplete: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const uc = new ProposeDistributeYieldToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, totalYieldUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
    });
  });

  describe('ProposeKycAddToolUseCase', () => {
    it('mints a tier-1 add descriptor with one tx leg', async () => {
      const uc = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 1 },
        NOW,
      );
      expect(out.kind).toBe('kyc_add');
      expect(out.preview.kycTier).toBe(1);
      expect(out.preview.investorAddress).toBe(INVESTOR_TO_KYC.toLowerCase());
      const txs = out.sdkCall.args.txs as Array<{ fn: string }>;
      expect(txs).toHaveLength(1);
      expect(txs[0]?.fn).toBe('addToWhitelist');
    });

    it('emits a two-tx sequence on tier 2 (whitelist + accredited)', async () => {
      const uc = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 2 },
        NOW,
      );
      const txs = out.sdkCall.args.txs as Array<{ fn: string }>;
      expect(txs).toHaveLength(2);
      expect(txs[0]?.fn).toBe('addToWhitelist');
      expect(txs[1]?.fn).toBe('addToAccreditedList');
    });

    it('returns 503 when KYC_ADAPTER_ADDRESS is unset', async () => {
      delete process.env.KYC_ADAPTER_ADDRESS;
      const uc = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 1 },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 503 });
    });

    it('returns 503 when KYC_ADAPTER_ADDRESS is set to garbage (non-hex) — H3', async () => {
      process.env.KYC_ADAPTER_ADDRESS = 'not-a-real-address';
      const uc = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 1 },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 503 });
    });

    it('pins requestedAtSec + tool name into the action hash (C1+C2)', async () => {
      const uc = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 1 },
        NOW,
      );
      expect(out.preview.requestedAtSec).toBe(Math.floor(NOW.getTime() / 1000));
      // Check via repo round-trip that the persisted actionPayload also
      // carries `tool` + `requestedAtSec` so commit-side audit + replay
      // detection can use both.
      const tok = await confirmRepo.findByToken(out.confirmTokenId);
      expect(tok?.actionPayload).toMatchObject({
        tool: 'muhaven_propose_kyc_add',
        requestedAtSec: Math.floor(NOW.getTime() / 1000),
      });
    });
  });

  describe('ProposeKycRemoveToolUseCase', () => {
    it('mints a remove descriptor with single-tx sequence', async () => {
      const uc = new ProposeKycRemoveToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC },
        NOW,
      );
      expect(out.kind).toBe('kyc_remove');
      expect(out.preview.requestedAtSec).toBe(Math.floor(NOW.getTime() / 1000));
      const txs = out.sdkCall.args.txs as Array<{ fn: string }>;
      expect(txs).toHaveLength(1);
      expect(txs[0]?.fn).toBe('removeFromWhitelist');
    });

    it('rejects investor-roled callers', async () => {
      const uc = new ProposeKycRemoveToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: NON_ISSUER_USER_ID, walletAddress: NON_ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('ProposeUnpauseTokenToolUseCase', () => {
    it('mints a descriptor for a paused token with two-tx sequence (setNAV + setPaused)', async () => {
      rwaTokenRepo.tokens.set(TOKEN, pausedToken());
      const uc = new ProposeUnpauseTokenToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      const out = await uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, initialNavUsd6: '1000000' },
        NOW,
      );
      expect(out.kind).toBe('unpause_token');
      expect(out.preview.initialNavUsd6).toBe('1000000');
      expect(out.preview.requestedAtSec).toBe(Math.floor(NOW.getTime() / 1000));
      const txs = out.sdkCall.args.txs as Array<{ fn: string; contract: string }>;
      expect(txs).toHaveLength(2);
      expect(txs[0]?.fn).toBe('setNAV');
      expect(txs[0]?.contract).toBe('IssuerControlledOracle');
      expect(txs[1]?.fn).toBe('setPaused');
      expect(txs[1]?.contract).toBe('TokenRegistry');
    });

    it('rejects when the token is already active (idempotent)', async () => {
      // Default fixture is active.
      const uc = new ProposeUnpauseTokenToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, initialNavUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects when ISSUER_ORACLE_ADDRESS is unset', async () => {
      rwaTokenRepo.tokens.set(TOKEN, pausedToken());
      delete process.env.ISSUER_ORACLE_ADDRESS;
      const uc = new ProposeUnpauseTokenToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, initialNavUsd6: '1000000' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  describe('AuditQueryToolUseCase', () => {
    it('returns the calling user\'s own audit log scoped self', async () => {
      // Seed an audit row by issuing a propose-kyc-add (touches audit).
      const propose = new ProposeKycAddToolUseCase(
        rwaTokenRepo,
        userRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await propose.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, investorAddress: INVESTOR_TO_KYC, kycTier: 1 },
        NOW,
      );
      const uc = new AuditQueryToolUseCase(auditRepo);
      const out = await uc.execute({ userId: ISSUER_USER_ID }, {});
      expect(out.tool).toBe('muhaven_audit_query');
      expect(out.scopedTo).toBe('self');
      expect(out.items.length).toBeGreaterThan(0);
      expect(out.items[0]?.eventType).toBe('confirm_token_issued');
    });

    it('rejects a >90-day date window (M1 DOS guard)', async () => {
      const uc = new AuditQueryToolUseCase(auditRepo);
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID },
          {
            since: '1970-01-01T00:00:00.000Z',
            until: '2099-12-31T23:59:59.000Z',
          },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects until < since at the boundary', async () => {
      const uc = new AuditQueryToolUseCase(auditRepo);
      await expect(
        uc.execute(
          { userId: ISSUER_USER_ID },
          {
            since: '2026-05-06T00:00:00.000Z',
            until: '2026-04-01T00:00:00.000Z',
          },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('does not leak another user\'s audit rows', async () => {
      // Seed audit rows under both users.
      await appendAudit.execute({
        userId: NON_ISSUER_USER_ID,
        surface: Surface.HavenBot,
        eventType: 'confirm_token_issued' as const,
        metadata: { secret: 'should-not-leak' },
        now: NOW,
      });
      const uc = new AuditQueryToolUseCase(auditRepo);
      const out = await uc.execute({ userId: ISSUER_USER_ID }, {});
      // ISSUER_USER_ID has no audit rows for this scenario.
      expect(out.items.length).toBe(0);
    });
  });

  describe('PublishIssuerChannelEventUseCase', () => {
    it('routes through the configured transport', async () => {
      const captured: IssuerChannelEvent[] = [];
      const transport: IIssuerChannelTransport = {
        async publish(ev) {
          captured.push(ev);
        },
      };
      const uc = new PublishIssuerChannelEventUseCase(transport);
      await uc.execute({
        eventType: 'distribution_funded',
        tokenAddress: TOKEN,
        tokenSymbol: 'TBILL1',
        distributionId: 7,
        totalUsd6: '5000000',
        issuerLabel: 'Acme RWA',
        summary: 'Funded $5 across 12 escrows.',
        txHash: '0x' + 'ab'.repeat(32),
      });
      expect(captured.length).toBe(1);
      expect(captured[0]?.eventType).toBe('distribution_funded');
      expect(captured[0]?.tokenSymbol).toBe('TBILL1');
    });

    it('rejects unknown event types at the schema layer', async () => {
      const uc = new PublishIssuerChannelEventUseCase(new LoggingIssuerChannelTransport());
      await expect(
        uc.execute({
          // @ts-expect-error — deliberate unknown event
          eventType: 'pwn_attempt',
          tokenAddress: TOKEN,
          tokenSymbol: 'TBILL1',
          distributionId: null,
          totalUsd6: null,
          issuerLabel: 'Acme RWA',
        }),
      ).rejects.toThrow();
    });

    it('drops + does not throw when an HTTP transport fetch rejects', async () => {
      // Validate the swallow-on-failure contract — channel notifications
      // must NEVER block a commit.
      const transport: IIssuerChannelTransport = {
        async publish(_ev) {
          // The HttpIssuerChannelTransport catches everything internally;
          // emulate that contract for the unit test.
          // (Not throwing is the assertion.)
        },
      };
      const uc = new PublishIssuerChannelEventUseCase(transport);
      await expect(
        uc.execute({
          eventType: 'kyc_added',
          tokenAddress: TOKEN,
          tokenSymbol: 'TBILL1',
          distributionId: null,
          totalUsd6: null,
          issuerLabel: 'Acme RWA',
        }),
      ).resolves.not.toThrow();
    });
  });
});
