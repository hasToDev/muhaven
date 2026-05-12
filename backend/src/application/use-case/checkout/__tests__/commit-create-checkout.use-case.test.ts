import { describe, it, expect, beforeEach } from 'vitest';
import { CommitCreateCheckoutUseCase } from '../commit-create-checkout.use-case.js';
import { CreateCheckoutSessionUseCase } from '../create-session.use-case.js';
import { ProposeCreateCheckoutToolUseCase } from '../../agent/tool/propose-create-checkout.use-case.js';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentConfirmTokenRepository,
  MemoryUserRepository,
  MemoryCheckoutSessionRepository,
} from '../../../../infrastructure/repository/memory/index.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { GetPolicyStateUseCase } from '../../agent/policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../agent/policy/append-audit-event.use-case.js';
import { ConfirmTokenService } from '../../agent/policy/confirm-token.service.js';
import { StubIssuerLabelResolver } from '../../../../infrastructure/checkout/issuer-label-resolver.js';
import { User } from '../../../../domain/auth/model/user.js';
import { RwaToken, type AssetClass } from '../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';

const NOW = new Date('2026-05-12T10:00:00.000Z');
const ISSUER_USER_ID = 'iss_1';
const ISSUER_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = '0xc1d6c9ca5177ee876e0eda81d649c1859516f2fc';
const BASE_URL = 'https://pay.example.test';

class StubRwaTokenRepo implements IRwaTokenRepository {
  tokens = new Map<string, RwaToken>();
  async save(t: RwaToken): Promise<void> {
    this.tokens.set(t.address.toLowerCase(), t);
  }
  async findById(): Promise<RwaToken | null> {
    return null;
  }
  async findAll(): Promise<RwaToken[]> {
    return [...this.tokens.values()];
  }
  async findByAddress(address: string): Promise<RwaToken | null> {
    return this.tokens.get(address.toLowerCase()) ?? null;
  }
  async findByIssuer(): Promise<RwaToken[]> {
    return [];
  }
  async findByStatus(): Promise<RwaToken[]> {
    return [];
  }
  async update(t: RwaToken): Promise<void> {
    this.tokens.set(t.address.toLowerCase(), t);
  }
  async updateIssuer(): Promise<void> {}
  async updatePausedStatus(): Promise<void> {}
}

describe('CommitCreateCheckoutUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let userRepo: MemoryUserRepository;
  let sessionRepo: MemoryCheckoutSessionRepository;
  let rwaTokenRepo: StubRwaTokenRepo;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;
  let propose: ProposeCreateCheckoutToolUseCase;
  let createSession: CreateCheckoutSessionUseCase;
  let commit: CommitCreateCheckoutUseCase;

  beforeEach(async () => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    userRepo = new MemoryUserRepository();
    sessionRepo = new MemoryCheckoutSessionRepository();
    rwaTokenRepo = new StubRwaTokenRepo();
    rwaTokenRepo.tokens.set(
      TOKEN,
      new RwaToken({
        id: 'tok_aura88',
        address: TOKEN,
        name: 'Aura Series A',
        symbol: 'AURA88',
        issuerAddress: ISSUER_WALLET,
        kycTier: 1,
        assetClass: 'private_credit' as AssetClass,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await userRepo.save(
      new User({
        id: ISSUER_USER_ID,
        walletAddress: ISSUER_WALLET,
        walletProvider: 'zerodev',
        role: 'issuer',
        createdAt: NOW,
        issuerStatus: 'approved',
      }),
    );
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
    createSession = new CreateCheckoutSessionUseCase(sessionRepo, BASE_URL, userRepo);
    propose = new ProposeCreateCheckoutToolUseCase(
      rwaTokenRepo,
      userRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
    );
    commit = new CommitCreateCheckoutUseCase(
      confirmTokens,
      appendAudit,
      rwaTokenRepo,
      createSession,
      new StubIssuerLabelResolver(),
    );
  });

  async function proposeFirst(memo: string | null = 'Series A allocation') {
    const args = {
      tokenAddress: TOKEN,
      amountUsd6: '5000000',
      ...(memo ? { memo } : {}),
    } as { tokenAddress: string; amountUsd6: string; memo?: string };
    const out = await propose.execute(
      { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
      args,
      NOW,
    );
    return out;
  }

  function reconstructPayload(out: { preview: { requestedAtSec: number } }, memo: string | null = 'Series A allocation') {
    return {
      tool: 'muhaven_propose_create_checkout',
      action: 'create_checkout',
      tokenAddress: TOKEN,
      amountUsd6: '5000000',
      memo,
      successUrl: null,
      cancelUrl: null,
      issuerAddress: ISSUER_WALLET.toLowerCase(),
      requestedAtSec: out.preview.requestedAtSec,
    };
  }

  it('mints a session + surfaces the URL on the happy path', async () => {
    const out = await proposeFirst();
    const result = await commit.execute({
      userId: ISSUER_USER_ID,
      surface: Surface.HavenBot,
      confirmToken: out.confirmTokenId,
      actionPayload: reconstructPayload(out),
      now: NOW,
    });

    expect(result.consumed).toBe(true);
    expect(result.session.sessionId).toMatch(/^cs_[A-Z0-9]{26}$/);
    expect(result.session.url).toMatch(/^https:\/\/pay\.example\.test\/c\/cs_/);
    expect(result.session.url).toContain('#k=');
    expect(result.session.status).toBe('pending');
    expect(result.session.fragmentKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Audit rows tagged with surface + actionKind. Two rows: PermitGranted
    // + ConfirmTokenConsumed.
    const audits = await auditRepo.findByUserId(ISSUER_USER_ID);
    const granted = audits.items.find(
      (a) => a.eventType === 'permit_granted'
        && (a.metadata as { tool?: string })?.tool === 'muhaven_propose_create_checkout',
    );
    expect(granted).toBeDefined();
    expect((granted!.metadata as { actionKind?: string }).actionKind).toBe('create_checkout');
    expect((granted!.metadata as { sessionId?: string }).sessionId).toBe(result.session.sessionId);
  });

  it('rejects replay — second commit with same token fails 410', async () => {
    const out = await proposeFirst();
    await commit.execute({
      userId: ISSUER_USER_ID,
      surface: Surface.HavenBot,
      confirmToken: out.confirmTokenId,
      actionPayload: reconstructPayload(out),
      now: NOW,
    });
    await expect(
      commit.execute({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: reconstructPayload(out),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  it('rejects when actionPayload is byte-modified — hash mismatch (403)', async () => {
    const out = await proposeFirst();
    const tampered = { ...reconstructPayload(out), amountUsd6: '1000000' };
    await expect(
      commit.execute({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: tampered,
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects when commit caller userId differs (403)', async () => {
    const out = await proposeFirst();
    await expect(
      commit.execute({
        userId: 'someone_else',
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: reconstructPayload(out),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects when token issuer-of-record rotated between propose + commit (409)', async () => {
    const out = await proposeFirst();
    // Rotate the token's issuerAddress to a different wallet (mimics
    // an admin transfer / IssuerUpdated event landing between propose
    // and commit).
    rwaTokenRepo.tokens.set(
      TOKEN,
      new RwaToken({
        id: 'tok_aura88',
        address: TOKEN,
        name: 'Aura Series A',
        symbol: 'AURA88',
        issuerAddress: '0xdead' + '0'.repeat(36),
        kycTier: 1,
        assetClass: 'private_credit' as AssetClass,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await expect(
      commit.execute({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: reconstructPayload(out),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects when token was paused between propose + commit (409)', async () => {
    const out = await proposeFirst();
    rwaTokenRepo.tokens.set(
      TOKEN,
      new RwaToken({
        id: 'tok_aura88',
        address: TOKEN,
        name: 'Aura Series A',
        symbol: 'AURA88',
        issuerAddress: ISSUER_WALLET,
        kycTier: 1,
        assetClass: 'private_credit' as AssetClass,
        status: 'paused',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await expect(
      commit.execute({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: reconstructPayload(out),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects malformed actionPayload (schema fail → 400)', async () => {
    const out = await proposeFirst();
    await expect(
      commit.execute({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        confirmToken: out.confirmTokenId,
        actionPayload: { not: 'the right shape' },
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('does NOT log the fragment key into audit metadata (privacy invariant)', async () => {
    const out = await proposeFirst();
    const result = await commit.execute({
      userId: ISSUER_USER_ID,
      surface: Surface.HavenBot,
      confirmToken: out.confirmTokenId,
      actionPayload: reconstructPayload(out),
      now: NOW,
    });
    const audits = await auditRepo.findByUserId(ISSUER_USER_ID);
    for (const a of audits.items) {
      const meta = JSON.stringify(a.metadata ?? {});
      expect(meta).not.toContain(result.session.fragmentKey);
      expect(meta).not.toContain('fragmentKey');
    }
  });
});
