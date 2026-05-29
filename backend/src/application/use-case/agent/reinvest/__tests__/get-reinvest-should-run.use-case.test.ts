import { describe, it, expect, vi } from 'vitest';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../../domain/agent/repository/scoped-session.repository.js';
import { RwaToken } from '../../../../../domain/token-registry/model/rwa-token.js';
import type { IRwaTokenRepository } from '../../../../../domain/token-registry/repository/rwa-token.repository.js';
import { GetReinvestShouldRunUseCase } from '../get-reinvest-should-run.use-case.js';
import type { ClaimableEpoch, IReinvestGateReader } from '../reinvest-gate.port.js';

const USER = 'user-uuid-1';
const INVESTOR = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const SNAPSHOT = '0x3333333333333333333333333333333333333333';
const NOW = new Date('2026-05-29T12:00:00.000Z');

function makeSession(reinvestEnabled: boolean): ScopedSession {
  return new ScopedSession({
    sessionId: 's1',
    userId: USER,
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0x9999999999999999999999999999999999999999',
    permissionId: null,
    targetContracts: [],
    selectorCaps: [],
    maxPerOpUsd6: 0n,
    totalSpentUsd6: 0n,
    validUntilSec: Math.floor(NOW.getTime() / 1000) + 3600,
    mintedAtSec: Math.floor(NOW.getTime() / 1000),
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    reinvestEnabled,
  });
}

function makeScopedRepo(session: ScopedSession | null): IScopedSessionRepository {
  return { findLatestActive: vi.fn(async () => session) } as unknown as IScopedSessionRepository;
}

function makeTokenRepo(tokens: RwaToken[]): IRwaTokenRepository {
  return { findByStatus: vi.fn(async () => tokens) } as unknown as IRwaTokenRepository;
}

function token(address: string, snapshotAddr: string | undefined): RwaToken {
  return new RwaToken({
    id: address,
    address,
    name: 'T',
    symbol: 'T',
    issuerAddress: '0x0000000000000000000000000000000000000099',
    kycTier: 1,
    assetClass: 'money_market',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...(snapshotAddr ? { yieldSnapshotAddress: snapshotAddr } : {}),
  });
}

function makeReader(epochs: ClaimableEpoch[]): {
  reader: IReinvestGateReader;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => epochs);
  return { reader: { findClaimableEpochs: spy } as IReinvestGateReader, spy };
}

const EPOCH: ClaimableEpoch = {
  token: TOKEN as `0x${string}`,
  snapshotAddress: SNAPSHOT as `0x${string}`,
  epochId: '5',
  ratePerShare: '40000',
};

describe('GetReinvestShouldRunUseCase', () => {
  it('shouldRun:true with epochs when active+opted-in+claimable', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      makeTokenRepo([token(TOKEN, SNAPSHOT)]),
      reader,
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(true);
    expect(out.epochs).toEqual([EPOCH]);
    // The reader was handed the (token, snapshot) target + lower-cased investor.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        investorAddress: INVESTOR,
        tokens: [{ token: TOKEN, snapshotAddress: SNAPSHOT }],
      }),
    );
  });

  it('refuses (no_active_session) when there is no active Scoped session — revoke kill-switch', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(null),
      makeTokenRepo([token(TOKEN, SNAPSHOT)]),
      reader,
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(false);
    expect(out.reason).toBe('no_active_session');
    expect(spy).not.toHaveBeenCalled(); // never reads on-chain when gated out
  });

  it('refuses (reinvest_disabled) when the session has NOT opted in', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(false)),
      makeTokenRepo([token(TOKEN, SNAPSHOT)]),
      reader,
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(false);
    expect(out.reason).toBe('reinvest_disabled');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses (no_snapshot_tokens) when no active token has a snapshot address', async () => {
    const { reader } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      makeTokenRepo([token(TOKEN, undefined)]), // no snapshot, no fallback
      reader,
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(false);
    expect(out.reason).toBe('no_snapshot_tokens');
  });

  it('uses the defaultSnapshotAddress fallback for tokens with null yieldSnapshotAddress', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      makeTokenRepo([token(TOKEN, undefined)]),
      reader,
      { defaultSnapshotAddress: SNAPSHOT },
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: [{ token: TOKEN, snapshotAddress: SNAPSHOT }] }),
    );
  });

  it('refuses (no_claimable_epochs) when opted-in but the reader finds nothing', async () => {
    const { reader } = makeReader([]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      makeTokenRepo([token(TOKEN, SNAPSHOT)]),
      reader,
    );
    const out = await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(out.shouldRun).toBe(false);
    expect(out.reason).toBe('no_claimable_epochs');
  });

  it('dedupes (token, snapshot) targets', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      // two tokens sharing the SAME snapshot, plus a dup of the first
      makeTokenRepo([token(TOKEN, SNAPSHOT), token(TOKEN, SNAPSHOT)]),
      reader,
    );
    await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    const arg = spy.mock.calls[0]![0] as { tokens: unknown[] };
    expect(arg.tokens).toHaveLength(1);
  });

  it('passes the minRatePerShare floor through to the reader', async () => {
    const { reader, spy } = makeReader([EPOCH]);
    const uc = new GetReinvestShouldRunUseCase(
      makeScopedRepo(makeSession(true)),
      makeTokenRepo([token(TOKEN, SNAPSHOT)]),
      reader,
      { minRatePerShare: 1234n, maxEpochLookback: 6 },
    );
    await uc.execute({ userId: USER, investorAddress: INVESTOR, now: NOW });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ minRatePerShare: 1234n, maxEpochLookback: 6 }),
    );
  });
});
