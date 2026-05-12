import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentConfirmTokenRepository,
  MemoryUserRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { GetPolicyStateUseCase } from '../../policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { ConfirmTokenService } from '../../policy/confirm-token.service.js';
import { ProposeCreateCheckoutToolUseCase } from '../propose-create-checkout.use-case.js';
import { User, type IssuerStatus } from '../../../../../domain/auth/model/user.js';
import { RwaToken, type AssetClass } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';

const NOW = new Date('2026-05-12T10:00:00.000Z');
const ISSUER_USER_ID = 'iss_1';
const ISSUER_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INVESTOR_USER_ID = 'inv_1';
const INVESTOR_WALLET = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = '0xc1d6c9ca5177ee876e0eda81d649c1859516f2fc';

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

function makeUser(issuerStatus: IssuerStatus = 'approved', role: 'investor' | 'issuer' = 'issuer'): User {
  return new User({
    id: ISSUER_USER_ID,
    walletAddress: ISSUER_WALLET,
    walletProvider: 'zerodev',
    role,
    createdAt: NOW,
    issuerStatus,
  });
}

function makeToken(opts: { issuerAddress?: string; status?: 'active' | 'paused' } = {}): RwaToken {
  return new RwaToken({
    id: 'tok_aura88',
    address: TOKEN,
    name: 'Aura Series A',
    symbol: 'AURA88',
    issuerAddress: opts.issuerAddress ?? ISSUER_WALLET,
    kycTier: 1,
    assetClass: 'private_credit' as AssetClass,
    status: opts.status ?? 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('ProposeCreateCheckoutToolUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let userRepo: MemoryUserRepository;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;
  let rwaTokenRepo: StubRwaTokenRepo;
  let uc: ProposeCreateCheckoutToolUseCase;

  beforeEach(async () => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    userRepo = new MemoryUserRepository();
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
    rwaTokenRepo = new StubRwaTokenRepo();
    rwaTokenRepo.tokens.set(TOKEN, makeToken());
    await userRepo.save(makeUser());
    await userRepo.save(
      new User({
        id: INVESTOR_USER_ID,
        walletAddress: INVESTOR_WALLET,
        walletProvider: 'zerodev',
        role: 'investor',
        createdAt: NOW,
      }),
    );
    uc = new ProposeCreateCheckoutToolUseCase(
      rwaTokenRepo,
      userRepo,
      getPolicy,
      confirmTokens,
      appendAudit,
    );
  });

  it('mints a confirm token + create_checkout descriptor + audit row on happy path', async () => {
    const out = await uc.execute(
      { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
      {
        tokenAddress: TOKEN,
        amountUsd6: '5000000',
        memo: 'Series A allocation',
      },
      NOW,
    );

    expect(out.kind).toBe('create_checkout');
    expect(out.preview.tokenSymbol).toBe('AURA88');
    expect(out.preview.amountUsd6).toBe('5000000');
    expect(out.preview.memo).toBe('Series A allocation');
    expect(out.preview.issuerAddress).toBe(ISSUER_WALLET.toLowerCase());
    expect(out.preview.requestedAtSec).toBeGreaterThan(0);
    expect(out.confirmTokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.summary).toMatch(/\$5/);
    expect(out.summary).toMatch(/AURA88/);

    const audits = await auditRepo.findByUserId(ISSUER_USER_ID);
    expect(audits.items[0]?.metadata?.tool).toBe('muhaven_propose_create_checkout');
    expect(audits.items[0]?.metadata?.amountUsd6).toBe('5000000');
  });

  it('normalises empty memo to null', async () => {
    const out = await uc.execute(
      { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
      { tokenAddress: TOKEN, amountUsd6: '1000000', memo: '   ' },
      NOW,
    );
    expect(out.preview.memo).toBeNull();
  });

  it('rejects non-approved issuers (pending → 403)', async () => {
    await userRepo.save(makeUser('pending'));
    await expect(
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects investor-role callers (403)', async () => {
    await expect(
      uc.execute(
        { userId: INVESTOR_USER_ID, walletAddress: INVESTOR_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects when caller is not the token\'s issuer-of-record (403)', async () => {
    rwaTokenRepo.tokens.set(
      TOKEN,
      makeToken({ issuerAddress: '0xdead' + '0'.repeat(36) }),
    );
    await expect(
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects when token is not active (paused → 409)', async () => {
    rwaTokenRepo.tokens.set(TOKEN, makeToken({ status: 'paused' }));
    await expect(
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects unknown token (404)', async () => {
    await expect(
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: '0x' + '9'.repeat(40), amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects on Paused tier (423)', async () => {
    await stateRepo.upsert(
      new AgentUserState({
        userId: ISSUER_USER_ID,
        surface: Surface.HavenBot,
        tier: Tier.Paused,
        pausedAt: NOW,
        pauseTrigger: 'T-1-pause',
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        validatorInstalledAt: null,
        validatorUninstalledAt: null,
        confirmedActionCount: 0,
        kycRevoked: false,
        risksConfirmedAt: null,
        updatedAt: NOW,
      }),
    );
    await expect(
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '1000000' },
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 423 });
  });

  it('rejects amountUsd6 = 0 — schema regex forbids zero so reaches schema layer', async () => {
    // The Zod schema regex `^[1-9]\d*$` rejects '0' upstream — exercise
    // here directly via the use-case to confirm a 0n branch is unreachable
    // even with a bypass; the BigInt check is defense-in-depth.
    await expect(
      // Bypass schema by typing as any and passing through.
      // The use-case still rejects with 400 if it ever reaches the inner
      // amount <= 0 check.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uc.execute(
        { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, amountUsd6: '0' } as never,
        NOW,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('round-trips action payload through ConfirmTokenService.consume', async () => {
    const out = await uc.execute(
      { userId: ISSUER_USER_ID, walletAddress: ISSUER_WALLET, surface: Surface.HavenBot },
      {
        tokenAddress: TOKEN,
        amountUsd6: '7500000',
        memo: 'Replay-defense test',
        successUrl: 'https://issuer.example/success',
        cancelUrl: 'https://issuer.example/cancel',
      },
      NOW,
    );

    // Byte-exact payload reconstruction (mirrors the commit-side
    // schema). Confirms there's no surprise field that would diverge
    // between propose-time hash + commit-time hash.
    const reconstructed = {
      tool: 'muhaven_propose_create_checkout',
      action: 'create_checkout',
      tokenAddress: TOKEN,
      amountUsd6: '7500000',
      memo: 'Replay-defense test',
      successUrl: 'https://issuer.example/success',
      cancelUrl: 'https://issuer.example/cancel',
      issuerAddress: ISSUER_WALLET.toLowerCase(),
      requestedAtSec: out.preview.requestedAtSec,
    };
    const consumed = await confirmTokens.consume(
      out.confirmTokenId,
      ISSUER_USER_ID,
      'permit_grant',
      reconstructed,
      NOW,
    );
    expect(consumed.token).toBe(out.confirmTokenId);
  });
});
