import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentConfirmTokenRepository,
  MemoryEscrowRepository,
  MemoryYieldRecordRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';
import { GetPolicyStateUseCase } from '../../policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { PauseAgentUseCase } from '../../policy/pause-agent.use-case.js';
import { ConfirmTokenService } from '../../policy/confirm-token.service.js';
import {
  ProposeBuyToolUseCase,
  ProposeClaimToolUseCase,
  ProposeRebalanceToolUseCase,
  SetPolicyToolUseCase,
  PauseToolUseCase,
  PortfolioSummaryToolUseCase,
  QuoteToolUseCase,
  UnsealPositionToolUseCase,
  CommitToolActionUseCase,
} from '../index.js';
import { parseDecimalToUsd6 } from '../quote.use-case.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../../domain/nav-history/repository/nav-history.repository.js';
import type { IPortfolioRepository } from '../../../../../domain/portfolio/repository/portfolio.repository.js';
import type { ITaxEventRepository } from '../../../../../domain/tax-event/repository/tax-event.repository.js';
import { RwaToken, type AssetClass } from '../../../../../domain/token-registry/model/rwa-token.js';
import { NavSnapshot } from '../../../../../domain/nav-history/model/nav-snapshot.js';
import { YieldRecord } from '../../../../../domain/yield-history/model/yield-record.js';
import { Portfolio } from '../../../../../domain/portfolio/model/portfolio.js';

const NOW = new Date('2026-05-06T00:00:00.000Z');
const USER_ID = 'user-123';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = '0x3e570bdb3928488b0092fbe149d4b7e8d12cb178';
const TBILL_SYMBOL = 'TBILL1';

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

class StubNavHistoryRepo implements INavHistoryRepository {
  latest = new Map<string, NavSnapshot>();
  async save(s: NavSnapshot): Promise<void> {
    this.latest.set(s.tokenAddress.toLowerCase(), s);
  }
  async findByToken(): Promise<NavSnapshot[]> {
    return [];
  }
  async findLatestByToken(addr: string): Promise<NavSnapshot | null> {
    return this.latest.get(addr.toLowerCase()) ?? null;
  }
  async findLatestForAllTokens(): Promise<NavSnapshot[]> {
    return [...this.latest.values()];
  }
}

class StubPortfolioRepo implements IPortfolioRepository {
  positions: Portfolio[] = [];
  async save(p: Portfolio): Promise<void> {
    this.positions.push(p);
  }
  async findByUserId(userId: string): Promise<Portfolio[]> {
    return this.positions.filter((p) => p.userId === userId);
  }
  async findByUserAndToken(): Promise<Portfolio | null> {
    return null;
  }
  async delete(): Promise<void> {}
}

function activeToken(): RwaToken {
  return new RwaToken({
    id: 'tok_1',
    address: TOKEN,
    name: 'Treasury Bond Fund',
    symbol: TBILL_SYMBOL,
    issuerAddress: '0xissuer',
    kycTier: 1,
    assetClass: 'treasury' as AssetClass,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/**
 * Build a NavSnapshot fixture. `navDecimal` is the human-readable price
 * the nav-worker writes to `token_nav_history.nav` (e.g. "1.0" for
 * treasury par, "2400.5" for gold) — NOT the 6dp base-unit integer.
 * The repo layer hands this string through unchanged; the agent / SDK
 * layer is the one that converts to base units (see
 * `parseDecimalToUsd6` in `quote.use-case.ts`).
 */
function navAt(navDecimal: string, ts: Date = NOW): NavSnapshot {
  return new NavSnapshot({
    id: 'nav_1',
    tokenAddress: TOKEN.toLowerCase(),
    nav: navDecimal,
    source: 'test',
    sourceType: 'manual',
    sourceTimestamp: ts,
    fetchedAt: ts,
    createdAt: ts,
  });
}

describe('parseDecimalToUsd6', () => {
  it('parses an integer decimal as 6-dp base units (1.0 → 1000000)', () => {
    expect(parseDecimalToUsd6('1')).toBe(1_000_000n);
    expect(parseDecimalToUsd6('1.0')).toBe(1_000_000n);
    expect(parseDecimalToUsd6('1.000000')).toBe(1_000_000n);
  });

  it('parses fractional decimals (gold price) without precision drift', () => {
    expect(parseDecimalToUsd6('2400.5')).toBe(2_400_500_000n);
    expect(parseDecimalToUsd6('0.5')).toBe(500_000n);
    // 6dp boundary — pads exactly.
    expect(parseDecimalToUsd6('0.123456')).toBe(123_456n);
  });

  it('truncates (does NOT round) past 6dp to match fhERC-20 shares=integer floor', () => {
    expect(parseDecimalToUsd6('0.1234567')).toBe(123_456n); // not 123_457n
    expect(parseDecimalToUsd6('0.999999999')).toBe(999_999n); // not 1_000_000n
  });

  it('rejects malformed inputs', () => {
    expect(() => parseDecimalToUsd6('')).toThrow();
    expect(() => parseDecimalToUsd6('abc')).toThrow();
    expect(() => parseDecimalToUsd6('1e6')).toThrow(); // scientific notation refused
    expect(() => parseDecimalToUsd6('-1.0')).toThrow(); // negatives refused
    expect(() => parseDecimalToUsd6('1.0.0')).toThrow();
    expect(() => parseDecimalToUsd6(' 1.0 ')).toThrow(); // no whitespace handling
  });
});

describe('Wave 4 P2 — tool use cases', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let confirmRepo: MemoryAgentConfirmTokenRepository;
  let getPolicy: GetPolicyStateUseCase;
  let appendAudit: AppendAuditEventUseCase;
  let confirmTokens: ConfirmTokenService;
  let rwaTokenRepo: StubRwaTokenRepo;
  let navRepo: StubNavHistoryRepo;
  let portfolioRepo: StubPortfolioRepo;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    confirmRepo = new MemoryAgentConfirmTokenRepository();
    getPolicy = new GetPolicyStateUseCase(stateRepo);
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    confirmTokens = new ConfirmTokenService(confirmRepo);
    rwaTokenRepo = new StubRwaTokenRepo();
    navRepo = new StubNavHistoryRepo();
    portfolioRepo = new StubPortfolioRepo();
    rwaTokenRepo.tokens.set(TOKEN, activeToken());
    navRepo.latest.set(TOKEN, navAt('1.0')); // NAV = $1.00 (decimal-price; matches nav-worker schema)
  });

  describe('PortfolioSummaryToolUseCase', () => {
    it('returns empty positions + null signals when no positions exist', async () => {
      const uc = new PortfolioSummaryToolUseCase(portfolioRepo, rwaTokenRepo, navRepo);
      const out = await uc.execute(USER_ID, WALLET, {});
      expect(out.tool).toBe('muhaven_portfolio_summary');
      expect(out.totalPositions).toBe(0);
      expect(out.signals.isOverexposed).toBeNull();
      expect(out.signals.isUnderYield).toBeNull();
    });

    it('joins last-known NAV onto each position', async () => {
      portfolioRepo.positions.push(
        new Portfolio({
          id: 'p1',
          userId: USER_ID,
          tokenAddress: TOKEN,
          tokenSymbol: TBILL_SYMBOL,
          lastSyncedAt: NOW,
        }),
      );
      portfolioRepo.positions.push(
        new Portfolio({
          id: 'p2',
          userId: USER_ID,
          tokenAddress: '0xother',
          tokenSymbol: 'OTHER',
          lastSyncedAt: NOW,
        }),
      );
      const uc = new PortfolioSummaryToolUseCase(portfolioRepo, rwaTokenRepo, navRepo);
      const out = await uc.execute(USER_ID, WALLET, {});
      expect(out.totalPositions).toBe(2);
      expect(out.positions[0]?.lastKnownNavUsd6).toBe('1000000');
      expect(out.signals.isOverexposed).toBe(false);
    });

    it('filters to a single token when tokenAddress is provided', async () => {
      portfolioRepo.positions.push(
        new Portfolio({
          id: 'p1',
          userId: USER_ID,
          tokenAddress: TOKEN,
          tokenSymbol: TBILL_SYMBOL,
          lastSyncedAt: NOW,
        }),
      );
      portfolioRepo.positions.push(
        new Portfolio({
          id: 'p2',
          userId: USER_ID,
          tokenAddress: '0xother',
          tokenSymbol: 'OTHER',
          lastSyncedAt: NOW,
        }),
      );
      const uc = new PortfolioSummaryToolUseCase(portfolioRepo, rwaTokenRepo, navRepo);
      const out = await uc.execute(USER_ID, WALLET, { tokenAddress: TOKEN });
      expect(out.totalPositions).toBe(1);
      expect(out.positions[0]?.tokenAddress).toBe(TOKEN);
    });
  });

  describe('QuoteToolUseCase', () => {
    it('returns floor(notional/nav) shares with maxSharesHint pinned to estimated', async () => {
      const uc = new QuoteToolUseCase(rwaTokenRepo, navRepo);
      const out = await uc.execute({ tokenAddress: TOKEN, notionalUsd6: '500000000' }); // $500
      expect(out.estimatedShares).toBe('500');
      expect(out.maxSharesHint).toBe('500');
      expect(out.tokenSymbol).toBe(TBILL_SYMBOL);
      // Wire-shape: navUsd6 must be the 6-dp base-unit integer string,
      // not the raw decimal price. Stub synthesiser does
      // `(Number(navUsd6) / 1_000_000).toFixed(4)` — ensure that math
      // produces "1.0000" not "0.000001" or NaN.
      expect(out.navUsd6).toBe('1000000');
    });

    it('handles fractional NAV (gold price) without BigInt failure', async () => {
      // 2026-05-09 regression — `BigInt("2400.5")` throws; the helper
      // must convert "2400.5" → 2400500000n base units for the
      // notional-divided-by-NAV math to produce "0 shares" cleanly.
      navRepo.latest.set(TOKEN, navAt('2400.5'));
      const uc = new QuoteToolUseCase(rwaTokenRepo, navRepo);
      // $5000 notional / $2400.50 NAV ≈ 2 shares (floor).
      const out = await uc.execute({ tokenAddress: TOKEN, notionalUsd6: '5000000000' });
      expect(out.estimatedShares).toBe('2');
      expect(out.navUsd6).toBe('2400500000');
    });

    it('rejects unregistered tokens', async () => {
      const uc = new QuoteToolUseCase(rwaTokenRepo, navRepo);
      await expect(
        uc.execute({ tokenAddress: '0xnotregistered', notionalUsd6: '1000000' }),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
    });

    it('rejects archived tokens', async () => {
      const archived = new RwaToken({ ...activeToken(), status: 'archived' as const });
      rwaTokenRepo.tokens.set(TOKEN, archived);
      const uc = new QuoteToolUseCase(rwaTokenRepo, navRepo);
      await expect(
        uc.execute({ tokenAddress: TOKEN, notionalUsd6: '1000000' }),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
    });

    it('rejects sub-NAV notional that floors to zero shares', async () => {
      const uc = new QuoteToolUseCase(rwaTokenRepo, navRepo);
      // $0.50 at NAV $1.00 = 0 shares
      await expect(
        uc.execute({ tokenAddress: TOKEN, notionalUsd6: '500000' }),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
    });
  });

  describe('ProposeBuyToolUseCase', () => {
    it('round-trips through commit — descriptor preview reproduces the actionPayload (C1 regression)', async () => {
      const propose = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        null, // gate skipped — this case asserts the round-trip wire shape, not the gate.
      );
      const descriptor = await propose.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, shares: '100' },
        NOW,
      );
      // Mirror the frontend ConfirmModal.extractActionPayload — must
      // match the propose-time payload BYTE-FOR-BYTE so the action hash
      // recovers cleanly.
      const reconstructedPayload = {
        action: 'buy',
        tokenAddress: descriptor.preview.tokenAddress,
        shares: descriptor.preview.shares,
        maxSharesHint: descriptor.preview.maxSharesHint,
        navUsd6: descriptor.preview.navUsd6,
        navAt: descriptor.preview.navAt,
      };
      const commit = new CommitToolActionUseCase(confirmTokens, appendAudit, stateRepo);
      // Commit must NOT throw (would prove the hash matched).
      const out = await commit.execute(
        USER_ID,
        Surface.HavenBot,
        reconstructedPayload,
        'permit_grant',
        { confirmToken: descriptor.confirmTokenId, txHash: '0x' + 'cd'.repeat(32) },
        NOW,
      );
      expect(out.consumed).toBe(true);
    });

    it('mints a confirm token + appends a ConfirmTokenIssued audit event', async () => {
      const uc = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        null, // gate skipped — this case asserts the audit event, not the gate.
      );
      const out = await uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, shares: '100' },
        NOW,
      );
      expect(out.kind).toBe('buy');
      expect(out.confirmTokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(out.preview.shares).toBe('100');
      expect(out.preview.estimatedTotalUsd6).toBe('100000000');
      const audits = await auditRepo.findByUserId(USER_ID);
      expect(audits.items.length).toBe(1);
      expect(audits.items[0]?.eventType).toBe('confirm_token_issued');
    });

    it('rejects on Paused tier with HTTP 423', async () => {
      await stateRepo.upsert(
        new AgentUserState({
          userId: USER_ID,
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
      const uc = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        null, // gate skipped — this case asserts the Paused tier rejection.
      );
      await expect(
        uc.execute(
          { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, shares: '100' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 423 });
    });

    it('rejects shares > maxSharesHint (silent-fail prevention)', async () => {
      const uc = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        null, // gate skipped — this case asserts the maxSharesHint guard.
      );
      await expect(
        uc.execute(
          { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, shares: '100', maxSharesHint: '50' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
    });

    it('rejects fresh wallets with INSUFFICIENT_MHUSDC when no cash-rail history', async () => {
      // Stub repo: holder has zero events.
      const taxEventRepo: Pick<ITaxEventRepository, 'hasCashRailActivity'> = {
        hasCashRailActivity: async () => false,
      };
      const uc = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        taxEventRepo as ITaxEventRepository,
      );
      await expect(
        uc.execute(
          { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
          { tokenAddress: TOKEN, shares: '100' },
          NOW,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('INSUFFICIENT_MHUSDC'),
      });
    });

    it('allows propose when cash-rail history exists (gate is best-effort)', async () => {
      // Stub repo: holder has wrap activity.
      const taxEventRepo: Pick<ITaxEventRepository, 'hasCashRailActivity'> = {
        hasCashRailActivity: async () => true,
      };
      const uc = new ProposeBuyToolUseCase(
        rwaTokenRepo,
        navRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
        taxEventRepo as ITaxEventRepository,
      );
      const desc = await uc.execute(
        { userId: USER_ID, walletAddress: WALLET, surface: Surface.HavenBot },
        { tokenAddress: TOKEN, shares: '100' },
        NOW,
      );
      expect(desc.kind).toBe('buy');
    });
  });

  describe('ProposeClaimToolUseCase', () => {
    it('rejects when yield record does not belong to caller', async () => {
      const yieldRepo = new MemoryYieldRecordRepository();
      const escrowRepo = new MemoryEscrowRepository();
      const otherUserRecord = new YieldRecord({
        id: '11111111-1111-1111-1111-111111111111',
        userId: 'other-user',
        distributionId: 1,
        tokenAddress: TOKEN,
        amount: '1000',
        status: 'pending',
        createdAt: NOW,
      });
      await yieldRepo.save(otherUserRecord);
      const uc = new ProposeClaimToolUseCase(
        yieldRepo,
        escrowRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute(
          { userId: USER_ID, surface: Surface.HavenBot },
          { yieldRecordId: '11111111-1111-1111-1111-111111111111' },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('rejects when no on-chain escrow id is indexed yet', async () => {
      const yieldRepo = new MemoryYieldRecordRepository();
      const escrowRepo = new MemoryEscrowRepository();
      const yrId = '22222222-2222-2222-2222-222222222222';
      await yieldRepo.save(
        new YieldRecord({
          id: yrId,
          userId: USER_ID,
          distributionId: 7,
          tokenAddress: TOKEN,
          amount: '1000',
          status: 'pending',
          escrowId: undefined, // no escrow id linked yet
          claimedAt: undefined,
          createdAt: NOW,
        }),
      );
      const uc = new ProposeClaimToolUseCase(
        yieldRepo,
        escrowRepo,
        getPolicy,
        confirmTokens,
        appendAudit,
      );
      await expect(
        uc.execute({ userId: USER_ID, surface: Surface.HavenBot }, { yieldRecordId: yrId }, NOW),
      ).rejects.toMatchObject({ statusCode: 425 });
    });
  });

  describe('ProposeRebalanceToolUseCase', () => {
    it('rejects an empty leg list at the schema layer (use-case still rejects 0 if reached)', async () => {
      const uc = new ProposeRebalanceToolUseCase(rwaTokenRepo, getPolicy, confirmTokens, appendAudit);
      const goodLeg = { kind: 'buy' as const, tokenAddress: TOKEN, shares: '10' };
      const out = await uc.execute(
        { userId: USER_ID, surface: Surface.HavenBot },
        { legs: [goodLeg] },
        NOW,
      );
      expect(out.preview.legCount).toBe(1);
    });

    it('hard-fails when any leg references an archived token', async () => {
      const archived = new RwaToken({ ...activeToken(), status: 'archived' as const });
      rwaTokenRepo.tokens.set(TOKEN, archived);
      const uc = new ProposeRebalanceToolUseCase(rwaTokenRepo, getPolicy, confirmTokens, appendAudit);
      await expect(
        uc.execute(
          { userId: USER_ID, surface: Surface.HavenBot },
          { legs: [{ kind: 'buy', tokenAddress: TOKEN, shares: '10' }] },
          NOW,
        ),
      ).rejects.toBeInstanceOf(ApplicationHttpError);
    });
  });

  describe('SetPolicyToolUseCase — transitions', () => {
    // Wave 5 Option D · Commit 4 "pick any tier" follow-up — the forced
    // climb is gone. Advisory → Policy-bound (was 409) and
    // Confirm-per-action → Policy-bound without ≥5 confirms (was 409) now
    // both mint a confirm token, mirroring the relaxed state machine.
    it('mints a confirm token on a direct Advisory → Policy-bound step (no climb)', async () => {
      const uc = new SetPolicyToolUseCase(getPolicy, confirmTokens, appendAudit);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        { surface: Surface.HavenBot, targetTier: Tier.PolicyBound },
        NOW,
      );
      expect(out.kind).toBe('set_policy');
      expect(out.preview.targetTier).toBe(Tier.PolicyBound);
      const tok = await confirmRepo.findByToken(out.confirmTokenId);
      expect(tok?.actionKind).toBe('tier_transition');
    });

    it('mints a confirm token on Confirm-per-action → Policy-bound without ≥5 confirms', async () => {
      await stateRepo.upsert(
        new AgentUserState({
          userId: USER_ID,
          surface: Surface.HavenBot,
          tier: Tier.ConfirmPerAction,
          pausedAt: null,
          pauseTrigger: null,
          pauseMetadata: null,
          enteredAt: NOW,
          validatorAddress: null,
          confirmedActionCount: 2, // < 5 — no longer a gate
          riskQuestionnaireComplete: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const uc = new SetPolicyToolUseCase(getPolicy, confirmTokens, appendAudit);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        { surface: Surface.HavenBot, targetTier: Tier.PolicyBound },
        NOW,
      );
      expect(out.kind).toBe('set_policy');
      expect(out.preview.targetTier).toBe(Tier.PolicyBound);
    });

    it('rejects targetTier=paused (use muhaven_pause instead)', async () => {
      const uc = new SetPolicyToolUseCase(getPolicy, confirmTokens, appendAudit);
      await expect(
        uc.execute(
          { userId: USER_ID, emittingSurface: Surface.HavenBot },
          { surface: Surface.HavenBot, targetTier: Tier.Paused },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('mints a tier_transition confirm token on a valid Advisory → Confirm step', async () => {
      const uc = new SetPolicyToolUseCase(getPolicy, confirmTokens, appendAudit);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        { surface: Surface.HavenBot, targetTier: Tier.ConfirmPerAction },
        NOW,
      );
      expect(out.kind).toBe('set_policy');
      expect(out.preview.targetTier).toBe(Tier.ConfirmPerAction);
      const tok = await confirmRepo.findByToken(out.confirmTokenId);
      expect(tok?.actionKind).toBe('tier_transition');
    });

    // Wave 5 Option D · Commit 4 — direct-to-Scoped (operator decision
    // 2026-05-24 "Uniform"). Pre-C4 this threw 409 ("Step through
    // Policy-bound first"); the climb was removed so a fresh Advisory
    // user (0 confirms, no risk Q&A) can mint a Scoped confirm token
    // directly. Stays mirrored with the relaxed `requestUserTierChange`.
    it('mints a tier_transition confirm token on a direct Advisory → Scoped step', async () => {
      const uc = new SetPolicyToolUseCase(getPolicy, confirmTokens, appendAudit);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        { surface: Surface.HavenBot, targetTier: Tier.Scoped },
        NOW,
      );
      expect(out.kind).toBe('set_policy');
      expect(out.preview.targetTier).toBe(Tier.Scoped);
      const tok = await confirmRepo.findByToken(out.confirmTokenId);
      expect(tok?.actionKind).toBe('tier_transition');
    });
  });

  describe('PauseToolUseCase', () => {
    it('cascades across every surface when surface is omitted', async () => {
      const pauseAgent = new PauseAgentUseCase(stateRepo, getPolicy, appendAudit);
      const uc = new PauseToolUseCase(pauseAgent);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        {},
        NOW,
      );
      expect(out.kind).toBe('pause');
      expect(out.preview.surface).toBeNull();
      // All four surfaces should have a Paused state row.
      const states = await stateRepo.findAllForUser(USER_ID);
      expect(states.length).toBe(4);
      for (const s of states) {
        expect(s.tier).toBe(Tier.Paused);
      }
    });

    it('mints a pause_-prefixed confirm-token id (no consume needed)', async () => {
      const pauseAgent = new PauseAgentUseCase(stateRepo, getPolicy, appendAudit);
      const uc = new PauseToolUseCase(pauseAgent);
      const out = await uc.execute(
        { userId: USER_ID, emittingSurface: Surface.HavenBot },
        { surface: Surface.HavenBot },
        NOW,
      );
      expect(out.confirmTokenId.startsWith('pause_tc_')).toBe(true);
    });
  });

  describe('UnsealPositionToolUseCase', () => {
    it('echoes the handle + signer hint with a client-side decrypt instruction', async () => {
      const uc = new UnsealPositionToolUseCase();
      const handle = '0x' + 'cd'.repeat(32);
      const out = await uc.execute({ handle, signerHint: 'session' });
      expect(out.handle).toBe(handle);
      expect(out.signerHint).toBe('session');
      expect(out.decryptInstruction).toMatch(/decryptForView/);
      expect(out.decryptInstruction).toMatch(/never sent to the agent/);
    });
  });

  describe('CommitToolActionUseCase', () => {
    it('consumes a fresh permit_grant token and writes the audit pair', async () => {
      // Issue a token through the same service to get the right action hash.
      const actionPayload = { action: 'buy', tokenAddress: TOKEN, shares: '10' };
      const issued = await confirmTokens.issue({
        userId: USER_ID,
        actionKind: 'permit_grant',
        actionPayload,
        now: NOW,
      });
      // Plant an Advisory state row so confirmedActionCount can bump.
      await stateRepo.upsert(
        new AgentUserState({
          userId: USER_ID,
          surface: Surface.HavenBot,
          tier: Tier.Advisory,
          pausedAt: null,
          pauseTrigger: null,
          pauseMetadata: null,
          enteredAt: NOW,
          validatorAddress: null,
          confirmedActionCount: 0,
          riskQuestionnaireComplete: false,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const uc = new CommitToolActionUseCase(confirmTokens, appendAudit, stateRepo);
      const out = await uc.execute(
        USER_ID,
        Surface.HavenBot,
        actionPayload,
        'permit_grant',
        {
          confirmToken: issued.token,
          txHash: '0x' + 'ab'.repeat(32),
          metadata: { gasUsed: '120000' },
        },
        NOW,
      );
      expect(out.consumed).toBe(true);
      const audits = await auditRepo.findByUserId(USER_ID);
      const types = audits.items.map((e) => e.eventType);
      expect(types).toContain('permit_granted');
      expect(types).toContain('confirm_token_consumed');
      // confirmedActionCount bumped from 0 → 1.
      const state = await stateRepo.findByUserAndSurface(USER_ID, Surface.HavenBot);
      expect(state?.confirmedActionCount).toBe(1);
    });

    it('rejects double-consume (R-3 replay)', async () => {
      const actionPayload = { action: 'buy', tokenAddress: TOKEN, shares: '10' };
      const issued = await confirmTokens.issue({
        userId: USER_ID,
        actionKind: 'permit_grant',
        actionPayload,
        now: NOW,
      });
      const uc = new CommitToolActionUseCase(confirmTokens, appendAudit, stateRepo);
      await uc.execute(
        USER_ID,
        Surface.HavenBot,
        actionPayload,
        'permit_grant',
        { confirmToken: issued.token, txHash: '0x' + 'ab'.repeat(32) },
        NOW,
      );
      await expect(
        uc.execute(
          USER_ID,
          Surface.HavenBot,
          actionPayload,
          'permit_grant',
          { confirmToken: issued.token, txHash: '0x' + 'ab'.repeat(32) },
          NOW,
        ),
      ).rejects.toMatchObject({ statusCode: 410 });
    });

    it('fast-paths pause_-prefixed tokens (idempotent, no consume)', async () => {
      const uc = new CommitToolActionUseCase(confirmTokens, appendAudit, stateRepo);
      const out = await uc.execute(
        USER_ID,
        Surface.HavenBot,
        { action: 'pause' },
        'permit_grant',
        { confirmToken: 'pause_tc_abc123', txHash: null },
        NOW,
      );
      expect(out.consumed).toBe(true);
      expect(out.auditEventId).toBeTypeOf('string');
    });
  });
});
