import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { CheckoutSettlementIndexer } from '../checkout-settlement-indexer.js';
import { SettleFromEventUseCase } from '../../../application/use-case/checkout/settle-from-event.use-case.js';
import { MemoryCheckoutSessionRepository } from '../../repository/memory/memory-checkout-session.repository.js';
import { SseChannelService } from '../../checkout/sse-channel.js';
import {
  CheckoutSession,
  CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';

const SUBSCRIPTION_ADDRESS = '0x39D49B2614d24ba189B613bEAa903d829A73eA9e' as const;
const TX_HASH_OURS =
  '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as const;
const TX_HASH_OTHER =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const BUYER_ADDRESS = '0xb18ca2122b31Df9Aaef8226f6218Bd93B852F40A' as const;
const TOKEN_ADDRESS = '0xF95c9aA19e974e4cA0778AAdb76580423eEEeb03' as const;
const ISSUER_USER_ID = 'usr_iss_test';

function makeSession(
  overrides: Partial<{
    sessionId: string;
    status: CheckoutSessionStatus;
    purchaseTxHash: string | null;
  }> = {},
): CheckoutSession {
  const now = new Date('2026-05-14T00:00:00Z');
  return new CheckoutSession({
    sessionId: overrides.sessionId ?? 'cs_TEST00000000000000000000',
    issuerUserId: ISSUER_USER_ID,
    status: overrides.status ?? CheckoutSessionStatus.Purchased,
    metadata: {
      issuerAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: TOKEN_ADDRESS,
      tokenSymbol: 'TBILL1',
      issuerLabel: 'Test Issuer',
      description: 'test',
      successUrl: null,
      cancelUrl: null,
    },
    buyerAddress: BUYER_ADDRESS,
    encPayload: 'iv:authTag:ciphertext',
    purchaseTxHash:
      overrides.purchaseTxHash !== undefined ? overrides.purchaseTxHash : TX_HASH_OURS,
    expiresAt: new Date(now.getTime() + 3600_000),
    createdAt: now,
    updatedAt: now,
  });
}

function makeLog(opts: { txHash: string; blockNumber: bigint }): {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  address: `0x${string}`;
  eventName: string;
  args: { token: `0x${string}`; investor: `0x${string}`; maxSharesHint: bigint };
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  logIndex: number;
  transactionIndex: number;
  blockHash: `0x${string}`;
  removed: boolean;
} {
  return {
    transactionHash: opts.txHash as `0x${string}`,
    blockNumber: opts.blockNumber,
    address: SUBSCRIPTION_ADDRESS as `0x${string}`,
    eventName: 'Purchased',
    args: {
      token: TOKEN_ADDRESS,
      investor: BUYER_ADDRESS,
      maxSharesHint: 100n,
    },
    topics: ['0x' as `0x${string}`],
    data: '0x' as `0x${string}`,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: '0x' as `0x${string}`,
    removed: false,
  };
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(500n),
    getLogs: vi.fn().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  void overrides;
}

function createMockClientWith(overrides: Record<string, unknown>) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(500n),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('CheckoutSettlementIndexer', () => {
  let repo: MemoryCheckoutSessionRepository;
  let sse: SseChannelService;
  let settleUseCase: SettleFromEventUseCase;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = new MemoryCheckoutSessionRepository();
    sse = new SseChannelService();
    // Webhook dispatcher null — tests don't exercise the dispatch leg
    // (covered separately in webhook-dispatcher tests).
    settleUseCase = new SettleFromEventUseCase(repo, sse, null);
    publishSpy = vi.spyOn(sse, 'publish');
  });

  it('initializes cursor on first tick without fetching logs', async () => {
    const client = createMockClientWith({
      getBlockNumber: vi.fn().mockResolvedValue(500n),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce();

    expect(client.getBlockNumber).toHaveBeenCalledOnce();
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(indexer.getStatus().lastProcessedBlock).toBe(500n);
  });

  it('skips logs that do not match any tracked session', async () => {
    await repo.issue({ session: makeSession() });
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n)
        .mockResolvedValue(510n),
      getLogs: vi
        .fn()
        .mockResolvedValue([makeLog({ txHash: TX_HASH_OTHER, blockNumber: 505n })]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init cursor at 500
    await indexer.tickOnce(); // fetch 501..510

    expect(client.getLogs).toHaveBeenCalledOnce();
    // The session is still in purchased state — no transition fired.
    const after = await repo.findById('cs_TEST00000000000000000000');
    expect(after?.status).toBe(CheckoutSessionStatus.Purchased);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('flips a matching session to settled and publishes SSE', async () => {
    await repo.issue({ session: makeSession() });
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n)
        .mockResolvedValue(510n),
      getLogs: vi
        .fn()
        .mockResolvedValue([makeLog({ txHash: TX_HASH_OURS, blockNumber: 505n })]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init
    await indexer.tickOnce(); // match

    const after = await repo.findById('cs_TEST00000000000000000000');
    expect(after?.status).toBe(CheckoutSessionStatus.Settled);
    expect(publishSpy).toHaveBeenCalledOnce();
    expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
      type: CheckoutSessionStatus.Settled,
      sessionId: 'cs_TEST00000000000000000000',
      data: expect.objectContaining({
        status: CheckoutSessionStatus.Settled,
        purchaseTxHash: TX_HASH_OURS,
        blockNumber: 505,
      }),
    });
  });

  it('is idempotent — a re-poll of the same event does not re-fire side effects', async () => {
    await repo.issue({ session: makeSession() });
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n)
        .mockResolvedValueOnce(510n)
        .mockResolvedValueOnce(515n),
      getLogs: vi
        .fn()
        .mockResolvedValue([makeLog({ txHash: TX_HASH_OURS, blockNumber: 505n })]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init
    await indexer.tickOnce(); // settles
    expect(publishSpy).toHaveBeenCalledOnce();
    // Re-poll the same event by replaying the log result (chain re-org
    // simulation — or a stuck cursor from a backend restart):
    await indexer.tickOnce(); // settles again? no — already terminal
    expect(publishSpy).toHaveBeenCalledOnce(); // unchanged
  });

  it('does not advance cursor when getLogs throws', async () => {
    const client = createMockClientWith({
      getBlockNumber: vi.fn().mockResolvedValue(510n),
      getLogs: vi.fn().mockRejectedValue(new Error('rpc 503')),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init at 510
    expect(indexer.getStatus().lastProcessedBlock).toBe(510n);
    // Bump head + force getLogs to throw on the next fetch
    client.getBlockNumber.mockResolvedValue(515n);
    await indexer.tickOnce(); // fetches 511..515 → throws
    // Cursor stays at 510 so next tick retries the same window.
    expect(indexer.getStatus().lastProcessedBlock).toBe(510n);
  });

  it('caps fetches at MAX_BLOCK_RANGE (2000) per tick', async () => {
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(5000n),
      getLogs: vi.fn().mockResolvedValue([]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init at 0
    await indexer.tickOnce(); // fetches 1..2000 (capped)

    const callArgs = client.getLogs.mock.calls[0]?.[0];
    expect(callArgs?.fromBlock).toBe(1n);
    expect(callArgs?.toBlock).toBe(2000n);
    expect(indexer.getStatus().lastProcessedBlock).toBe(2000n);
  });

  it('processes multiple matching events in one tick', async () => {
    await repo.issue({
      session: makeSession({ sessionId: 'cs_A00000000000000000000000', purchaseTxHash: TX_HASH_OURS }),
    });
    const otherHash =
      '0x2222222222222222222222222222222222222222222222222222222222222222' as const;
    await repo.issue({
      session: makeSession({ sessionId: 'cs_B00000000000000000000000', purchaseTxHash: otherHash }),
    });

    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n)
        .mockResolvedValue(510n),
      getLogs: vi.fn().mockResolvedValue([
        makeLog({ txHash: TX_HASH_OURS, blockNumber: 505n }),
        makeLog({ txHash: otherHash, blockNumber: 506n }),
      ]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init
    await indexer.tickOnce(); // both fire

    const a = await repo.findById('cs_A00000000000000000000000');
    const b = await repo.findById('cs_B00000000000000000000000');
    expect(a?.status).toBe(CheckoutSessionStatus.Settled);
    expect(b?.status).toBe(CheckoutSessionStatus.Settled);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('skips sessions that are not in purchased state (race window)', async () => {
    // Indexer sees the on-chain Purchased event before the buyer's
    // HTTP transition() call lands. Session is still `pending` /
    // `funded` / `wrapped`. The use-case should bail without flipping.
    await repo.issue({
      session: makeSession({
        sessionId: 'cs_RACE0000000000000000000',
        status: CheckoutSessionStatus.Wrapped,
        purchaseTxHash: TX_HASH_OURS,
      }),
    });
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n)
        .mockResolvedValue(510n),
      getLogs: vi
        .fn()
        .mockResolvedValue([makeLog({ txHash: TX_HASH_OURS, blockNumber: 505n })]),
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init
    await indexer.tickOnce(); // session is wrapped, indexer bails

    const after = await repo.findById('cs_RACE0000000000000000000');
    expect(after?.status).toBe(CheckoutSessionStatus.Wrapped);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('clamps the cursor when a log lands in the race-window so the next tick retries', async () => {
    // Post-review fix (Finding #7) — race-window logs MUST be
    // retried. Without the clamp the cursor advances past the failing
    // block and the session is stranded permanently in
    // `funded`/`wrapped`. Sequence:
    //   tick 1: cursor init at 500.
    //   tick 2: getLogs([logAt505]). Session is `wrapped` (race
    //           window). Clamp cursor to 504 (i.e., re-scan 505+
    //           next tick).
    //   tick 3: session has advanced to `purchased`. getLogs returns
    //           the SAME log at 505. Settle fires. Cursor advances
    //           past.
    await repo.issue({
      session: makeSession({
        sessionId: 'cs_CLAMP000000000000000000',
        status: CheckoutSessionStatus.Wrapped,
        purchaseTxHash: TX_HASH_OURS,
      }),
    });
    const logFn = vi.fn().mockResolvedValue([
      makeLog({ txHash: TX_HASH_OURS, blockNumber: 505n }),
    ]);
    const client = createMockClientWith({
      getBlockNumber: vi
        .fn()
        .mockResolvedValueOnce(500n) // tick 1: init
        .mockResolvedValueOnce(510n) // tick 2: fetch 501..510
        .mockResolvedValue(515n), //    tick 3: fetch 505..515 (clamped)
      getLogs: logFn,
    });
    const indexer = new CheckoutSettlementIndexer(
      repo,
      settleUseCase,
      {
        rpcUrl: '',
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        intervalMs: 1000,
      },
      client,
    );

    await indexer.tickOnce(); // init at 500
    await indexer.tickOnce(); // race window — clamp cursor to 504
    expect(indexer.getStatus().lastProcessedBlock).toBe(504n);
    expect(publishSpy).not.toHaveBeenCalled();

    // Now simulate the buyer's HTTP transition({purchased}) landing.
    // Move the session to `purchased` so the next tick can settle it.
    await repo.transition({
      sessionId: 'cs_CLAMP000000000000000000',
      expectedStatus: CheckoutSessionStatus.Wrapped,
      newStatus: CheckoutSessionStatus.Purchased,
      purchaseTxHash: TX_HASH_OURS,
      now: new Date(),
    });

    await indexer.tickOnce(); // re-scans 505..515, sees the log again, settles

    // Verify the fetch window started at 505 (the clamped block).
    const lastCall = logFn.mock.calls[logFn.mock.calls.length - 1]?.[0];
    expect(lastCall?.fromBlock).toBe(505n);
    const after = await repo.findById('cs_CLAMP000000000000000000');
    expect(after?.status).toBe(CheckoutSessionStatus.Settled);
    expect(publishSpy).toHaveBeenCalledOnce();
  });
});

describe('SettleFromEventUseCase (unit)', () => {
  it('flips purchased → settled and publishes SSE', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const sse = new SseChannelService();
    const publishSpy = vi.spyOn(sse, 'publish');
    const useCase = new SettleFromEventUseCase(repo, sse, null);
    const session = makeSession();
    await repo.issue({ session });

    const result = await useCase.execute({ session, blockNumber: 100 });

    expect(result.transitioned).toBe(true);
    expect(result.session.status).toBe(CheckoutSessionStatus.Settled);
    expect(publishSpy).toHaveBeenCalledOnce();
  });

  it('is idempotent on already-settled sessions', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const sse = new SseChannelService();
    const useCase = new SettleFromEventUseCase(repo, sse, null);
    const session = makeSession({ status: CheckoutSessionStatus.Settled });
    await repo.issue({ session });

    const result = await useCase.execute({ session });

    expect(result.transitioned).toBe(false);
    expect(result.session.status).toBe(CheckoutSessionStatus.Settled);
  });

  it('skips when session is in a non-purchased, non-terminal state', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const sse = new SseChannelService();
    const useCase = new SettleFromEventUseCase(repo, sse, null);
    const session = makeSession({ status: CheckoutSessionStatus.Funded });
    await repo.issue({ session });

    const result = await useCase.execute({ session });

    expect(result.transitioned).toBe(false);
    expect(result.session.status).toBe(CheckoutSessionStatus.Funded);
  });

  it('skips when session has been flipped to failed by another path', async () => {
    const repo = new MemoryCheckoutSessionRepository();
    const sse = new SseChannelService();
    const useCase = new SettleFromEventUseCase(repo, sse, null);
    const session = makeSession({ status: CheckoutSessionStatus.Failed });
    await repo.issue({ session });

    const result = await useCase.execute({ session });

    expect(result.transitioned).toBe(false);
    expect(result.session.status).toBe(CheckoutSessionStatus.Failed);
  });
});
