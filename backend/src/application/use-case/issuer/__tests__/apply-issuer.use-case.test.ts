/**
 * Phase 9.A · Expansion (F2) — apply-issuer use-case tests.
 *
 * Coverage:
 *   - happy path: investor → issuer flip + JWT reissue
 *   - 409 ALREADY_APPROVED on double-click
 *   - 403 HAS_INVESTOR_ACTIVITY when wallet has any portfolio row
 *   - 403 HAS_INVESTOR_ACTIVITY when wallet has any RWA-related
 *     tax_event row (Acquisition / Disposition / IncomeAccrual /
 *     FeeEvent / Transfer)
 *   - cash-rail tax_events (Wrap / Unwrap on MuHavenStable) do NOT
 *     trigger HAS_INVESTOR_ACTIVITY — wrapping USDC is a payment-rail
 *     step, not investor history. Regression for the issuer-onboarding
 *     bug surfaced 2026-05-09 (fresh wallet wraps USDC then is locked
 *     out of /apply-issuer).
 *   - 403 ISSUER_SUSPENDED guard
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApplyIssuerUseCase } from '../apply-issuer.use-case.js';
import { JwtService } from '../../../../infrastructure/auth/jwt.service.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { MemorySessionRepository } from '../../../../infrastructure/repository/memory/memory-session.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { User } from '../../../../domain/auth/model/user.js';
import type { IPortfolioRepository } from '../../../../domain/portfolio/repository/portfolio.repository.js';
import type { ITaxEventRepository } from '../../../../domain/tax-event/repository/tax-event.repository.js';
import { Portfolio } from '../../../../domain/portfolio/model/portfolio.js';
import {
  CASH_RAIL_EVENT_TYPES,
  INVESTOR_ACTIVITY_EVENT_TYPES,
  TaxEvent,
} from '../../../../domain/tax-event/model/tax-event.js';

class StubPortfolioRepo implements IPortfolioRepository {
  rows: Portfolio[] = [];
  async save(p: Portfolio): Promise<void> {
    this.rows.push(p);
  }
  async findByUserId(userId: string): Promise<Portfolio[]> {
    return this.rows.filter((r) => r.userId === userId);
  }
  async findByUserAndToken(userId: string, tokenAddress: string): Promise<Portfolio | null> {
    return this.rows.find((r) => r.userId === userId && r.tokenAddress === tokenAddress) ?? null;
  }
  async delete(): Promise<void> {}
}

class StubTaxEventRepo implements ITaxEventRepository {
  rows: TaxEvent[] = [];
  async saveMany(events: TaxEvent[]): Promise<number> {
    this.rows.push(...events);
    return events.length;
  }
  async findByHolder(addr: string, limit: number): Promise<TaxEvent[]> {
    const lower = addr.toLowerCase();
    return this.rows
      .filter((r) => r.holderAddress.toLowerCase() === lower)
      .slice(0, limit);
  }
  async hasInvestorActivity(addr: string): Promise<boolean> {
    const lower = addr.toLowerCase();
    return this.rows.some(
      (r) =>
        r.holderAddress.toLowerCase() === lower
        && INVESTOR_ACTIVITY_EVENT_TYPES.includes(r.eventType),
    );
  }
  async hasCashRailActivity(addr: string): Promise<boolean> {
    const lower = addr.toLowerCase();
    return this.rows.some(
      (r) =>
        r.holderAddress.toLowerCase() === lower
        && CASH_RAIL_EVENT_TYPES.includes(r.eventType),
    );
  }
  async aggregateCounts() {
    return {
      Acquisition: 0,
      Disposition: 0,
      IncomeAccrual: 0,
      FeeEvent: 0,
      Wrap: 0,
      Unwrap: 0,
      Transfer: 0,
      UsdcSend: 0,
    };
  }
  async dailyCounts() {
    return [];
  }
  async acquisitionsByToken() {
    return [];
  }
  async dispositionsByKind() {
    return { totals: { instant: 0, queued: 0, escalatedToQueue: 0 }, byDay: [] };
  }
}

const WALLET = '0xabCDEF1234567890ABcDEF1234567890aBCDeF12';

const PAYLOAD = {
  display_name: 'Acme SPV Cayman Ltd.',
  jurisdiction: 'KY',
  contact_email: 'ops@acme-spv.example',
  attestation: 'kyb_skipped' as const,
};

describe('ApplyIssuerUseCase', () => {
  let useCase: ApplyIssuerUseCase;
  let userRepo: MemoryUserRepository;
  let sessionRepo: MemorySessionRepository;
  let portfolioRepo: StubPortfolioRepo;
  let taxEventRepo: StubTaxEventRepo;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
    process.env.JWT_ISSUER = 'test-issuer';

    userRepo = new MemoryUserRepository();
    sessionRepo = new MemorySessionRepository();
    portfolioRepo = new StubPortfolioRepo();
    taxEventRepo = new StubTaxEventRepo();

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

    useCase = new ApplyIssuerUseCase(
      userRepo,
      sessionRepo,
      portfolioRepo,
      taxEventRepo,
      new JwtService(),
    );
  });

  it('flips role + status to issuer/approved and reissues a token pair', async () => {
    const result = await useCase.execute('user-1', PAYLOAD);

    expect(result.user.role).toBe('issuer');
    expect(result.user.issuer_status).toBe('approved');
    expect(result.user.issuer_display_name).toBe('Acme SPV Cayman Ltd.');
    expect(result.user.issuer_jurisdiction).toBe('KY');
    expect(result.tokens.access_token).toBeTruthy();
    expect(result.tokens.refresh_token).toBeTruthy();

    const persisted = await userRepo.findById('user-1');
    expect(persisted?.role).toBe('issuer');
    expect(persisted?.issuerStatus).toBe('approved');
    expect(persisted?.issuerKybSubmission?.attestation).toBe('kyb_skipped');
  });

  it('rejects with 409 ALREADY_APPROVED on double-click', async () => {
    await useCase.execute('user-1', PAYLOAD);
    await expect(useCase.execute('user-1', PAYLOAD)).rejects.toBeInstanceOf(
      ApplicationHttpError,
    );
    await expect(useCase.execute('user-1', PAYLOAD)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'ALREADY_APPROVED' },
    });
  });

  it('rejects with 403 HAS_INVESTOR_ACTIVITY when wallet has portfolio rows', async () => {
    await portfolioRepo.save(
      new Portfolio({
        id: 'p-1',
        userId: 'user-1',
        tokenAddress: '0xToken',
        tokenSymbol: 'TBILL1',
      }),
    );
    await expect(useCase.execute('user-1', PAYLOAD)).rejects.toMatchObject({
      statusCode: 403,
      details: { code: 'HAS_INVESTOR_ACTIVITY', source: 'portfolios' },
    });
  });

  it('rejects with 403 HAS_INVESTOR_ACTIVITY when wallet has tax_event rows', async () => {
    await taxEventRepo.saveMany([
      new TaxEvent({
        txHash: '0xabc',
        logIndex: 0,
        eventType: 'Acquisition',
        holderAddress: WALLET,
        tokenAddress: '0xToken',
        blockNumber: '100',
        blockTimestamp: new Date(),
        navAtTime: null,
        referenceId: null,
        metadata: null,
      }),
    ]);
    await expect(useCase.execute('user-1', PAYLOAD)).rejects.toMatchObject({
      statusCode: 403,
      details: { code: 'HAS_INVESTOR_ACTIVITY', source: 'tax_events' },
    });
  });

  it.each([
    ['Disposition', 'Disposition'],
    ['IncomeAccrual', 'IncomeAccrual'],
    ['FeeEvent', 'FeeEvent'],
    ['Transfer', 'Transfer'],
  ] as const)(
    'rejects with 403 HAS_INVESTOR_ACTIVITY when wallet has %s tax_event',
    async (_label, eventType) => {
      await taxEventRepo.saveMany([
        new TaxEvent({
          txHash: `0x${eventType}`,
          logIndex: 0,
          eventType,
          holderAddress: WALLET,
          tokenAddress: '0xToken',
          blockNumber: '100',
          blockTimestamp: new Date(),
          navAtTime: null,
          referenceId: null,
          metadata: null,
        }),
      ]);
      await expect(useCase.execute('user-1', PAYLOAD)).rejects.toMatchObject({
        statusCode: 403,
        details: { code: 'HAS_INVESTOR_ACTIVITY', source: 'tax_events' },
      });
    },
  );

  // Regression: cash-rail conversion (USDC↔mhUSDC) must NOT lock a
  // fresh applicant out of issuer onboarding. The pre-fix gate caught
  // any tax_event row, including Wrap, so wallets that funded mhUSDC
  // before applying received a misleading "investor activity" 403.
  it.each(['Wrap', 'Unwrap'] as const)(
    'allows issuer onboarding when only cash-rail %s tax_event exists',
    async (eventType) => {
      await taxEventRepo.saveMany([
        new TaxEvent({
          txHash: `0x${eventType}`,
          logIndex: 0,
          eventType,
          holderAddress: WALLET,
          tokenAddress: null,
          blockNumber: '100',
          blockTimestamp: new Date(),
          navAtTime: null,
          referenceId: null,
          metadata: { kind: eventType.toLowerCase() },
        }),
      ]);
      const result = await useCase.execute('user-1', PAYLOAD);
      expect(result.user.role).toBe('issuer');
      expect(result.user.issuer_status).toBe('approved');
    },
  );

  it('rejects with 403 ISSUER_SUSPENDED for suspended users', async () => {
    await userRepo.save(
      new User({
        id: 'user-1',
        walletAddress: WALLET,
        walletProvider: 'zerodev',
        role: 'issuer',
        createdAt: new Date(),
        issuerStatus: 'suspended',
      }),
    );
    await expect(useCase.execute('user-1', PAYLOAD)).rejects.toMatchObject({
      statusCode: 403,
      details: { code: 'ISSUER_SUSPENDED' },
    });
  });

  it('rejects with 401 when user not found', async () => {
    await expect(useCase.execute('missing', PAYLOAD)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
