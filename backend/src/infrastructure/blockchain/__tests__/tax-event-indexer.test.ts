import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { TaxEventIndexer } from '../tax-event-indexer.js';
import { TokenRegistryHandler } from '../token-registry-handler.js';
import type { ITaxEventRepository } from '../../../domain/tax-event/repository/tax-event.repository.js';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { Address } from 'viem';

/**
 * Phase 9.A · Expansion (F1) — `TokenRegistry.IssuerUpdated` indexer
 * subscription tests. The existing tax-event paths (Subscription /
 * Queue / Snapshot / Stable / Token) have their own end-to-end coverage
 * in the broader test totals (the indexer is exercised live on staging
 * after every redeploy); these tests scope to the new registry leg —
 * dispatch correctness, idempotency, mixed-batch order independence,
 * and the no-config skip path.
 */

const TOKEN_A: Address = '0x3E570bDb3928488b0092FBE149d4B7E8d12cb178';
const ISSUER_OLD: Address = '0xe11E83398C33A37CaC02C01c43F14A7f95876986';
const ISSUER_NEW: Address = '0x728389aaBf17BD0E54A24a67BC5a1366c92e3932';
const REGISTRY_ADDR: Address = '0x9079E96DF0e1Ea1028d8809D8Ce083d5e912f219';

function emptyTaxEventRepo(): ITaxEventRepository {
  return {
    saveMany: vi.fn().mockResolvedValue(0),
    findByHolder: vi.fn().mockResolvedValue([]),
    hasInvestorActivity: vi.fn().mockResolvedValue(false),
    hasCashRailActivity: vi.fn().mockResolvedValue(false),
    aggregateCounts: vi.fn().mockResolvedValue({
      Acquisition: 0,
      Disposition: 0,
      IncomeAccrual: 0,
      FeeEvent: 0,
      Wrap: 0,
      Unwrap: 0,
      Transfer: 0,
      UsdcSend: 0,
    }),
    dailyCounts: vi.fn().mockResolvedValue([]),
    acquisitionsByToken: vi.fn().mockResolvedValue([]),
    dispositionsByKind: vi
      .fn()
      .mockResolvedValue({ totals: { instant: 0, queued: 0, escalatedToQueue: 0 }, byDay: [] }),
  };
}

function fakeRwaTokenRepo(): IRwaTokenRepository & {
  updateIssuer: ReturnType<typeof vi.fn>;
  updatePausedStatus: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    findByAddress: vi.fn(),
    findByIssuer: vi.fn().mockResolvedValue([]),
    findByStatus: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateIssuer: vi.fn().mockResolvedValue(undefined),
    updatePausedStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function issuerUpdatedLog(opts: {
  token?: Address;
  oldIssuer?: Address;
  newIssuer?: Address;
  txHash?: `0x${string}`;
  blockNumber?: bigint;
  logIndex?: number;
}) {
  return {
    eventName: 'IssuerUpdated',
    args: {
      token: opts.token ?? TOKEN_A,
      oldIssuer: opts.oldIssuer ?? ISSUER_OLD,
      newIssuer: opts.newIssuer ?? ISSUER_NEW,
    },
    transactionHash: opts.txHash ?? '0xRegistryTx',
    blockNumber: opts.blockNumber ?? 102n,
    logIndex: opts.logIndex ?? 0,
    address: REGISTRY_ADDR,
  } as any;
}

function defaultIndexerConfig(overrides: Record<string, unknown> = {}) {
  return {
    rpcUrl: '',
    redemptionQueueAddresses: [] as Address[],
    yieldSnapshotAddresses: [] as Address[],
    intervalMs: 1000,
    ...overrides,
  };
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlock: vi
      .fn()
      .mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    readContract: vi.fn(),
    ...overrides,
  } as any;
}

describe('TaxEventIndexer · IssuerUpdated dispatch (F1)', () => {
  let taxEventRepo: ITaxEventRepository;
  let rwaTokenRepo: ReturnType<typeof fakeRwaTokenRepo>;

  beforeEach(() => {
    taxEventRepo = emptyTaxEventRepo();
    rwaTokenRepo = fakeRwaTokenRepo();
  });

  it('dispatches an IssuerUpdated log to the repo via the handler', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([issuerUpdatedLog({ blockNumber: 101n })]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick(); // init cursor at 100
    await indexer.tick(); // fetch 101–105

    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledTimes(1);
    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledWith(TOKEN_A, ISSUER_NEW);
  });

  it('is idempotent — same log re-injected results in two repo calls but final state is the latest issuer', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          // Same log object delivered twice (e.g. RPC re-org-replay edge).
          const log = issuerUpdatedLog({ blockNumber: 101n });
          return Promise.resolve([log, log]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledTimes(2);
    // Last call still maps token → newIssuer; UPDATE is idempotent at the
    // SQL layer (the repo does WHERE address=… SET issuer=…), so a re-
    // apply doesn't thrash the column.
    const lastCall =
      rwaTokenRepo.updateIssuer.mock.calls[
        rwaTokenRepo.updateIssuer.mock.calls.length - 1
      ];
    expect(lastCall).toEqual([TOKEN_A, ISSUER_NEW]);
  });

  it('handles a mixed batch — registry log dispatched alongside other event paths in one chunk', async () => {
    let blockCallCount = 0;
    const queueLog = {
      eventName: 'QueueClaimed',
      args: { investor: '0xInvestorA', requestId: 7n },
      transactionHash: '0xQueueTx',
      blockNumber: 101n,
      logIndex: 1,
      address: '0xQueueAddr',
    } as any;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      readContract: vi.fn().mockImplementation((call: any) => {
        // Queue token() lookup — bypass NAV by returning null pathologically.
        if (call.functionName === 'token') return Promise.resolve(TOKEN_A);
        throw new Error(`unexpected readContract ${call.functionName}`);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([issuerUpdatedLog({ blockNumber: 101n })]);
        }
        if (
          (Array.isArray(params.address) &&
            params.address.includes('0xQueueAddr')) ||
          params.address === '0xQueueAddr'
        ) {
          return Promise.resolve([queueLog]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({
        tokenRegistryAddress: REGISTRY_ADDR,
        redemptionQueueAddresses: ['0xQueueAddr' as Address],
      }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    // Both legs landed in the same chunk — registry update applied,
    // queue tax-event row enqueued for save.
    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledOnce();
    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('Disposition');
  });

  it('skips the registry leg entirely when no tokenRegistryAddress is configured', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockResolvedValue([]),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: undefined }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    // No getLogs call should have been made with the registry address (no
    // address means no fetch task; the indexer pushes a Promise.resolve([])
    // placeholder instead).
    const calls = (client.getLogs as any).mock.calls;
    for (const [params] of calls) {
      const addrs = Array.isArray(params.address) ? params.address : [params.address];
      expect(addrs.some((a: string) => a === REGISTRY_ADDR)).toBe(false);
    }
    expect(rwaTokenRepo.updateIssuer).not.toHaveBeenCalled();
  });

  it('does NOT advance cursor when the registry handler throws — re-run replays the rotation', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([issuerUpdatedLog({ blockNumber: 101n })]);
        }
        return Promise.resolve([]);
      }),
    });

    rwaTokenRepo.updateIssuer.mockRejectedValueOnce(new Error('DB unreachable'));
    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick(); // init at 99 (currentBlock - 1)
    await indexer.tick(); // throws — cursor stays at 99

    // Cursor stays one block behind the current head — that's what
    // "didn't advance" means after the post-init shift. The next tick
    // re-fetches blocks 100..105 inclusively.
    expect(indexer.getStatus().lastProcessedBlock).toBe('99');
    // Subsequent tick replays the same chunk; the second updateIssuer
    // invocation now succeeds (mockRejectedValueOnce only affects the
    // first call).
    await indexer.tick();
    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledTimes(2);
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
  });

  it('does not throw when the registry log is missing required args — defensive fallback', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          // Missing newIssuer in args — the handler should warn-and-skip
          // rather than throw an unhandled error.
          return Promise.resolve([
            { eventName: 'IssuerUpdated', args: { token: TOKEN_A } } as any,
          ]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updateIssuer).not.toHaveBeenCalled();
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
  });

  it('dispatches a PausedUpdated log to updatePausedStatus (true)', async () => {
    let blockCallCount = 0;
    const pausedLog = {
      eventName: 'PausedUpdated',
      args: { token: TOKEN_A, paused: true },
      transactionHash: '0xPausedTx',
      blockNumber: 102n,
      logIndex: 0,
      address: REGISTRY_ADDR,
    } as any;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([pausedLog]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updatePausedStatus).toHaveBeenCalledTimes(1);
    expect(rwaTokenRepo.updatePausedStatus).toHaveBeenCalledWith(TOKEN_A, true);
    // The IssuerUpdated leg must NOT have fired on a PausedUpdated log.
    expect(rwaTokenRepo.updateIssuer).not.toHaveBeenCalled();
  });

  it('dispatches paused=false (the unpause-token.ts case) so /tokens flips to active', async () => {
    let blockCallCount = 0;
    const unpausedLog = {
      eventName: 'PausedUpdated',
      args: { token: TOKEN_A, paused: false },
      transactionHash: '0xUnpausedTx',
      blockNumber: 102n,
      logIndex: 0,
      address: REGISTRY_ADDR,
    } as any;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([unpausedLog]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updatePausedStatus).toHaveBeenCalledWith(TOKEN_A, false);
  });

  it('handles a mixed batch with both IssuerUpdated and PausedUpdated logs in one chunk', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          return Promise.resolve([
            issuerUpdatedLog({ blockNumber: 101n }),
            {
              eventName: 'PausedUpdated',
              args: { token: TOKEN_A, paused: false },
              transactionHash: '0xUnpausedTx',
              blockNumber: 102n,
              logIndex: 0,
              address: REGISTRY_ADDR,
            } as any,
          ]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledWith(TOKEN_A, ISSUER_NEW);
    expect(rwaTokenRepo.updatePausedStatus).toHaveBeenCalledWith(TOKEN_A, false);
  });

  it('PausedUpdated with non-boolean `paused` arg → defensive skip (no repo call)', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (
          params.address === REGISTRY_ADDR ||
          (Array.isArray(params.address) && params.address.includes(REGISTRY_ADDR))
        ) {
          // Args missing the `paused` boolean — defensive guard kicks in.
          return Promise.resolve([
            { eventName: 'PausedUpdated', args: { token: TOKEN_A } } as any,
          ]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );

    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updatePausedStatus).not.toHaveBeenCalled();
    // Cursor still advances — defensive skip is not a failure.
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
  });
});

/**
 * Phase 9.A · Option Z follow-up — Transfer leg coverage. The transfer
 * mapper had no unit tests at landing time (commit `8c7880a`); this suite
 * exercises every branch of `fromTransferLog` so future regressions
 * (protocol-filter drift, mint/burn skip, two-row insertion, metadata
 * shape, missing amount handle) surface in CI rather than via the
 * "transfer didn't appear in /activity" symptom on staging.
 */

const TOKEN_PROXY: Address = '0xe80a64C13759e9b823265e2691c7C481EaAaf6e2';
const SUBSCRIPTION: Address = '0x6238d7f702F192dE4B84f7d9A38A4F569fc04466';
const QUEUE: Address = '0x994989781f221b59985DD7b30eE10906b95fa2Be';
const TREASURY: Address = '0x46a304002A7c02e387726af06d9C640B39D75064';
const KERNEL_A: Address = '0xAaaaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const KERNEL_B: Address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const ZERO_ADDR: Address = '0x0000000000000000000000000000000000000000';
const AMOUNT_HANDLE: `0x${string}` =
  '0x000000000000000000000000000000000000000000000000000000000000002a';

function transferLog(opts: {
  from: Address;
  to: Address;
  amount?: `0x${string}`;
  txHash?: `0x${string}`;
  blockNumber?: bigint;
  logIndex?: number;
  address?: Address;
}) {
  return {
    eventName: 'Transfer',
    args: {
      from: opts.from,
      to: opts.to,
      amount: opts.amount ?? AMOUNT_HANDLE,
    },
    transactionHash: opts.txHash ?? '0xTransferTx',
    blockNumber: opts.blockNumber ?? 102n,
    logIndex: opts.logIndex ?? 0,
    address: opts.address ?? TOKEN_PROXY,
  } as any;
}

describe('TaxEventIndexer · Transfer dispatch (Option Z follow-up)', () => {
  let taxEventRepo: ITaxEventRepository;
  let rwaTokenRepo: ReturnType<typeof fakeRwaTokenRepo>;

  beforeEach(() => {
    taxEventRepo = emptyTaxEventRepo();
    rwaTokenRepo = fakeRwaTokenRepo();
  });

  function transferIndexerConfig(overrides: Record<string, unknown> = {}) {
    return defaultIndexerConfig({
      muHavenTokenAddresses: [TOKEN_PROXY],
      protocolFilterAddresses: [SUBSCRIPTION, QUEUE, TREASURY],
      ...overrides,
    });
  }

  function clientWithTransferLogs(logs: any[]) {
    let blockCallCount = 0;
    return createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === TOKEN_PROXY.toLowerCase())) {
          return Promise.resolve(logs);
        }
        return Promise.resolve([]);
      }),
    });
  }

  it('inserts TWO rows (sender + recipient) for a kernel→kernel P2P transfer', async () => {
    const client = clientWithTransferLogs([
      transferLog({ from: KERNEL_A, to: KERNEL_B }),
    ]);

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(2);

    // Sender-keyed row.
    const sender = events.find((e: any) => e.holderAddress === KERNEL_A);
    expect(sender).toBeDefined();
    expect(sender.eventType).toBe('Transfer');
    expect(sender.tokenAddress).toBe(TOKEN_PROXY);
    expect(sender.metadata).toMatchObject({
      kind: 'transfer',
      direction: 'outbound',
      counterparty: KERNEL_B,
      encrypted_amount_handle: AMOUNT_HANDLE,
    });

    // Recipient-keyed row.
    const recipient = events.find((e: any) => e.holderAddress === KERNEL_B);
    expect(recipient).toBeDefined();
    expect(recipient.eventType).toBe('Transfer');
    expect(recipient.tokenAddress).toBe(TOKEN_PROXY);
    expect(recipient.metadata).toMatchObject({
      kind: 'transfer',
      direction: 'inbound',
      counterparty: KERNEL_A,
      encrypted_amount_handle: AMOUNT_HANDLE,
    });

    // Both rows share (txHash, logIndex) — the PK widening to include
    // holderAddress is what lets them coexist.
    expect(sender.txHash).toBe(recipient.txHash);
    expect(sender.logIndex).toBe(recipient.logIndex);
  });

  // RWA-transfer activity fix (2026-05-31) — the watch-set is (env list) ∪
  // (DB resolver). A token supplied ONLY by the dynamic resolver (e.g. onboarded
  // after boot, never added to MUHAVEN_TOKEN_ADDRESSES_JSON) must still be
  // watched, or its P2P transfers produce zero /activity rows — the reported bug.
  it('indexes a transfer on a token supplied ONLY by the dynamic resolver (empty env list)', async () => {
    // Lower-cased like a DB row (vs the checksummed env addresses).
    const DYNAMIC_TOKEN = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === DYNAMIC_TOKEN.toLowerCase())) {
          return Promise.resolve([
            transferLog({ from: KERNEL_A, to: KERNEL_B, address: DYNAMIC_TOKEN }),
          ]);
        }
        return Promise.resolve([]);
      }),
    });

    const indexer = new TaxEventIndexer(
      taxEventRepo,
      transferIndexerConfig({
        muHavenTokenAddresses: [],
        getMuHavenTokenAddresses: async () => [DYNAMIC_TOKEN],
      }),
      client,
    );
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events.map((e: any) => e.holderAddress).sort()).toEqual(
      [KERNEL_A, KERNEL_B].sort(),
    );
    expect(events.every((e: any) => e.tokenAddress === DYNAMIC_TOKEN)).toBe(true);
  });

  it('falls back to the static env token list when the dynamic resolver throws', async () => {
    const client = clientWithTransferLogs([
      transferLog({ from: KERNEL_A, to: KERNEL_B }),
    ]);

    const indexer = new TaxEventIndexer(
      taxEventRepo,
      transferIndexerConfig({
        getMuHavenTokenAddresses: async () => {
          throw new Error('DB unreachable');
        },
      }),
      client,
    );
    await indexer.tick();
    await indexer.tick();

    // The env list still carries TOKEN_PROXY → the transfer is indexed despite
    // the resolver failure (never regress below env-only behaviour).
    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    expect((taxEventRepo.saveMany as any).mock.calls[0][0]).toHaveLength(2);
  });

  // Leg-isolation: a Transfer getLogs rejection (e.g. the DB-driven address
  // array exceeds the RPC limit) must NOT propagate into Promise.all and stall
  // the WHOLE indexer — it degrades to "no transfer rows this chunk" and the
  // cursor still advances on the other legs.
  it('does NOT stall the indexer when the Transfer getLogs rejects', async () => {
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === TOKEN_PROXY.toLowerCase())) {
          return Promise.reject(new Error('eth_getLogs: too many addresses'));
        }
        return Promise.resolve([]);
      }),
    });

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    // Second tick must resolve (not reject) despite the transfer-leg rejection.
    await expect(indexer.tick()).resolves.toBeUndefined();
    // Cursor advanced past the rejected leg's blocks (other legs succeeded).
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
    // The transfer leg degraded to [] → no rows written.
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('skips mints (from == 0) — covered by Subscription.Purchased', async () => {
    const client = clientWithTransferLogs([
      transferLog({ from: ZERO_ADDR, to: KERNEL_B }),
    ]);

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('skips burns (to == 0) — covered by Redeemed / QueueClaimed', async () => {
    const client = clientWithTransferLogs([
      transferLog({ from: KERNEL_A, to: ZERO_ADDR }),
    ]);

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it.each([
    ['from is subscription', SUBSCRIPTION, KERNEL_B],
    ['to is subscription', KERNEL_A, SUBSCRIPTION],
    ['from is queue', QUEUE, KERNEL_B],
    ['to is queue', KERNEL_A, QUEUE],
    ['from is treasury', TREASURY, KERNEL_B],
    ['to is treasury', KERNEL_A, TREASURY],
  ] as const)(
    'skips protocol-mediated moves — %s',
    async (_label, from, to) => {
      const client = clientWithTransferLogs([transferLog({ from, to })]);
      const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
      await indexer.tick();
      await indexer.tick();
      expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
    },
  );

  it('protocol-filter check is case-insensitive at the address boundary', async () => {
    const upper = TREASURY.toUpperCase() as Address;
    // Filter contains the checksummed address, log carries upper-case from.
    // Both legs lower() at the comparison so the skip still fires.
    const client = clientWithTransferLogs([
      transferLog({ from: upper, to: KERNEL_B }),
    ]);

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('falls back to encrypted_amount_handle: null when amount arg missing', async () => {
    const log = transferLog({ from: KERNEL_A, to: KERNEL_B });
    delete (log.args as any).amount;
    const client = clientWithTransferLogs([log]);

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect((e.metadata as any).encrypted_amount_handle).toBeNull();
    }
  });

  it('handles a mixed batch — Transfer + IssuerUpdated land in one chunk', async () => {
    // Two registry hits + one Transfer. Cursor should advance, both legs fire.
    let blockCallCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === TOKEN_PROXY.toLowerCase())) {
          return Promise.resolve([transferLog({ from: KERNEL_A, to: KERNEL_B })]);
        }
        if (addrs.some((a: string) => a?.toLowerCase() === REGISTRY_ADDR.toLowerCase())) {
          return Promise.resolve([issuerUpdatedLog({ blockNumber: 101n })]);
        }
        return Promise.resolve([]);
      }),
    });

    const handler = new TokenRegistryHandler(rwaTokenRepo);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      transferIndexerConfig({ tokenRegistryAddress: REGISTRY_ADDR }),
      client,
      handler,
    );
    await indexer.tick();
    await indexer.tick();

    expect(rwaTokenRepo.updateIssuer).toHaveBeenCalledOnce();
    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.eventType === 'Transfer')).toBe(true);
  });

  it('does NOT subscribe to Transfer logs when muHavenTokenAddresses is empty', async () => {
    const client = clientWithTransferLogs([
      transferLog({ from: KERNEL_A, to: KERNEL_B }),
    ]);

    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ muHavenTokenAddresses: [], protocolFilterAddresses: [] }),
      client,
    );
    await indexer.tick();
    await indexer.tick();

    // Neither getLogs targeted the token proxy nor saveMany fired. The
    // empty-array path pushes Promise.resolve([]) instead of issuing a
    // request, so the operator-visible "muHavenTokens: 0" log is the only
    // signal that the leg is inert.
    const calls = (client.getLogs as any).mock.calls;
    for (const [params] of calls) {
      const addrs = Array.isArray(params.address) ? params.address : [params.address];
      expect(addrs.some((a: string) => a?.toLowerCase() === TOKEN_PROXY.toLowerCase())).toBe(false);
    }
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('cursor init does NOT skip the boot block — events at currentBlock are processed on next tick', async () => {
    // Regression test for the pre-bd304e5 bug where `lastProcessedBlock
    // = currentBlock` on init, so events in the boot block were lost
    // forever (next tick's `fromBlock = cursor + 1` skipped past it).
    // Post-fix: init sets `lastProcessedBlock = currentBlock - 1n`, so
    // a transfer that confirmed in the boot block is fetched on the
    // next tick.
    let blockCallCount = 0;
    const fromBlocks: bigint[] = [];
    const toBlocks: bigint[] = [];
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        // Tick 1 sees block 100 (init). Tick 2 sees the same block —
        // simulates the realistic case where the operator restarted
        // the backend and the user's transfer landed in the same
        // 12s window before the next chain block.
        return Promise.resolve(100n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (params.fromBlock !== undefined) fromBlocks.push(params.fromBlock as bigint);
        if (params.toBlock !== undefined) toBlocks.push(params.toBlock as bigint);
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === TOKEN_PROXY.toLowerCase())) {
          return Promise.resolve([
            transferLog({ from: KERNEL_A, to: KERNEL_B, blockNumber: 100n }),
          ]);
        }
        return Promise.resolve([]);
      }),
    });

    const indexer = new TaxEventIndexer(taxEventRepo, transferIndexerConfig(), client);
    await indexer.tick(); // init: lastProcessedBlock = 99 (NOT 100).
    await indexer.tick(); // currentBlock=100 > 99 → fromBlock=100, toBlock=100.

    // The boot-block transfer was indexed on tick 2.
    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(2);
    // Cursor advanced to currentBlock; subsequent ticks won't re-fetch.
    expect(indexer.getStatus().lastProcessedBlock).toBe('100');
    // Sanity: at least one getLogs call covered fromBlock=100, not 101.
    expect(fromBlocks).toContain(100n);
  });
});

/**
 * Wave 5 — UsdcSend leg coverage. Cleartext USDC sent OUT of a kernel
 * (CashPage "Send"). The leg topic-filters the GLOBAL USDC contract to our
 * users' outbound sends and inserts ONE sender-keyed row per send to a
 * non-protocol address, with the PUBLIC amount in metadata.cleartext_amount.
 */

const USDC_ADDR: Address = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const STABLE_ADDR: Address = '0x1111111111111111111111111111111111111111';
const EXTERNAL_ADDR: Address = '0xCccccCCCcccCCcCcCCcCcCcCCcCcccCccCcCccc1';

function usdcSendLog(opts: {
  from: Address;
  to: Address;
  value?: bigint;
  txHash?: `0x${string}`;
  blockNumber?: bigint;
  logIndex?: number;
}) {
  return {
    eventName: 'Transfer',
    args: {
      from: opts.from,
      to: opts.to,
      value: opts.value ?? 1_000_000n,
    },
    transactionHash: opts.txHash ?? '0xUsdcSendTx',
    blockNumber: opts.blockNumber ?? 102n,
    logIndex: opts.logIndex ?? 0,
    address: USDC_ADDR,
  } as any;
}

describe('TaxEventIndexer · UsdcSend dispatch (Wave 5)', () => {
  let taxEventRepo: ITaxEventRepository;

  beforeEach(() => {
    taxEventRepo = emptyTaxEventRepo();
  });

  function usdcConfig(overrides: Record<string, unknown> = {}) {
    return defaultIndexerConfig({
      usdcAddress: USDC_ADDR,
      getKernelAddresses: async () => [KERNEL_A],
      protocolFilterAddresses: [STABLE_ADDR],
      ...overrides,
    });
  }

  function clientWithUsdcLogs(logs: any[]) {
    let blockCallCount = 0;
    return createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        blockCallCount++;
        return Promise.resolve(blockCallCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        const addrs = Array.isArray(params.address) ? params.address : [params.address];
        if (addrs.some((a: string) => a?.toLowerCase() === USDC_ADDR.toLowerCase())) {
          return Promise.resolve(logs);
        }
        return Promise.resolve([]);
      }),
    });
  }

  it('inserts ONE sender-keyed row for a kernel→external USDC send', async () => {
    const client = clientWithUsdcLogs([
      usdcSendLog({ from: KERNEL_A, to: EXTERNAL_ADDR, value: 2_500_000n }),
    ]);
    const indexer = new TaxEventIndexer(taxEventRepo, usdcConfig(), client);
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('UsdcSend');
    expect(events[0].holderAddress).toBe(KERNEL_A);
    expect(events[0].tokenAddress).toBeNull();
    expect(events[0].navAtTime).toBeNull();
    expect(events[0].metadata).toMatchObject({
      kind: 'usdc-send',
      direction: 'outbound',
      counterparty: EXTERNAL_ADDR,
      cleartext_amount: '2500000',
    });
  });

  it('excludes sends to a protocol address (wrap deposit already shown as Wrap)', async () => {
    const client = clientWithUsdcLogs([usdcSendLog({ from: KERNEL_A, to: STABLE_ADDR })]);
    const indexer = new TaxEventIndexer(taxEventRepo, usdcConfig(), client);
    await indexer.tick();
    await indexer.tick();
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('excludes burns (to == 0)', async () => {
    const client = clientWithUsdcLogs([usdcSendLog({ from: KERNEL_A, to: ZERO_ADDR })]);
    const indexer = new TaxEventIndexer(taxEventRepo, usdcConfig(), client);
    await indexer.tick();
    await indexer.tick();
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('does NOT subscribe to USDC logs when usdcAddress is unset', async () => {
    const client = clientWithUsdcLogs([usdcSendLog({ from: KERNEL_A, to: EXTERNAL_ADDR })]);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ getKernelAddresses: async () => [KERNEL_A] }),
      client,
    );
    await indexer.tick();
    await indexer.tick();
    const calls = (client.getLogs as any).mock.calls;
    for (const [params] of calls) {
      const addrs = Array.isArray(params.address) ? params.address : [params.address];
      expect(addrs.some((a: string) => a?.toLowerCase() === USDC_ADDR.toLowerCase())).toBe(false);
    }
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('skips the leg when the kernel set is empty (fresh DB)', async () => {
    const client = clientWithUsdcLogs([usdcSendLog({ from: KERNEL_A, to: EXTERNAL_ADDR })]);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      usdcConfig({ getKernelAddresses: async () => [] }),
      client,
    );
    await indexer.tick();
    await indexer.tick();
    const calls = (client.getLogs as any).mock.calls;
    for (const [params] of calls) {
      const addrs = Array.isArray(params.address) ? params.address : [params.address];
      expect(addrs.some((a: string) => a?.toLowerCase() === USDC_ADDR.toLowerCase())).toBe(false);
    }
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
  });

  it('falls back to cleartext_amount: null when value arg missing', async () => {
    const log = usdcSendLog({ from: KERNEL_A, to: EXTERNAL_ADDR });
    delete (log.args as any).value;
    const client = clientWithUsdcLogs([log]);
    const indexer = new TaxEventIndexer(taxEventRepo, usdcConfig(), client);
    await indexer.tick();
    await indexer.tick();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect((events[0].metadata as any).cleartext_amount).toBeNull();
  });

  it('tolerates getKernelAddresses throwing — skips the leg, no crash', async () => {
    const client = clientWithUsdcLogs([usdcSendLog({ from: KERNEL_A, to: EXTERNAL_ADDR })]);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      usdcConfig({
        getKernelAddresses: async () => {
          throw new Error('DB unreachable');
        },
      }),
      client,
    );
    await indexer.tick();
    await indexer.tick();
    expect(taxEventRepo.saveMany).not.toHaveBeenCalled();
    // Cursor still advances — a failed kernel fetch is not a tick failure.
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
  });
});

// W3 Phase 9 cash-rail fix — the single-step direct USDC→mhUSDC deposit
// (CashPage "Convert to mhUSDC") emits `WrapUsdc`, NOT `Wrap`. It must be
// indexed as a cash-rail `Wrap` row, otherwise `hasCashRailActivity` is false
// and the agent buy path falsely tells the user "you have no mhUSDC".
describe('TaxEventIndexer · WrapUsdc dispatch (W3 Phase 9 cash-rail)', () => {
  const STABLE: Address = '0xF9bc25b67238C870255c33EC75fA37A09C00edE7';
  const KERNEL: Address = '0xAaaaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  const EPH: Address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
  const HANDLE =
    '0x000000000000000000000000000000000000000000000000000000000000002a' as `0x${string}`;
  let taxEventRepo: ITaxEventRepository;

  beforeEach(() => {
    taxEventRepo = emptyTaxEventRepo();
  });

  function clientWithStableLogs(logs: any[]) {
    let n = 0;
    return createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        n++;
        return Promise.resolve(n === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((p: any) => {
        const addrs = Array.isArray(p.address) ? p.address : [p.address];
        if (addrs.some((a: string) => a?.toLowerCase() === STABLE.toLowerCase())) {
          return Promise.resolve(logs);
        }
        return Promise.resolve([]);
      }),
    });
  }

  it('indexes WrapUsdc as a cash-rail Wrap row keyed by `from`', async () => {
    const log = {
      eventName: 'WrapUsdc',
      args: { from: KERNEL, ephemeralEOA: EPH, amount: 14_000_000n, amountHandle: HANDLE },
      transactionHash: '0xWrapUsdcTx',
      blockNumber: 102n,
      logIndex: 0,
      address: STABLE,
    } as any;
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ muHavenStableAddress: STABLE }),
      clientWithStableLogs([log]),
    );
    await indexer.tick();
    await indexer.tick();

    expect(taxEventRepo.saveMany).toHaveBeenCalledOnce();
    const events = (taxEventRepo.saveMany as any).mock.calls[0][0];
    expect(events).toHaveLength(1);
    const row = events[0];
    expect(row.eventType).toBe('Wrap'); // counts toward CASH_RAIL_EVENT_TYPES
    expect(row.holderAddress).toBe(KERNEL);
    expect(row.tokenAddress).toBeNull();
    expect(row.metadata).toMatchObject({
      kind: 'wrap',
      encrypted_amount_handle: HANDLE,
      cleartext_amount: '14000000',
      ephemeral_eoa: EPH,
    });
  });
});

// Yield-claim activity fix — the YieldSnapshot watch-list is (env list) ∪ (DB
// token registry's per-token yieldSnapshotAddress). A token whose snapshot
// proxy is only in the DB (onboarded after boot, never added to
// YIELD_SNAPSHOT_ADDRESSES_JSON) must still be watched, or its YieldClaimed →
// IncomeAccrual → /activity 'yield' row never appears.
describe('TaxEventIndexer · YieldSnapshot dynamic watch-list', () => {
  const DYNAMIC_SNAP: Address = '0xcccccccccccccccccccccccccccccccccccccccc';
  const ENV_SNAP: Address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  let taxEventRepo: ITaxEventRepository;

  beforeEach(() => {
    taxEventRepo = emptyTaxEventRepo();
  });

  function twoTickClient(getLogs: ReturnType<typeof vi.fn>) {
    let n = 0;
    return createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        n++;
        return Promise.resolve(n === 1 ? 100n : 105n);
      }),
      getLogs,
    });
  }

  function snapAddrsOf(getLogs: ReturnType<typeof vi.fn>): string[] {
    return getLogs.mock.calls.flatMap((call: any[]) => {
      const addr = call[0]?.address;
      return Array.isArray(addr) ? addr : addr ? [addr] : [];
    }).map((a: string) => a.toLowerCase());
  }

  it('watches a YieldSnapshot address supplied ONLY by the dynamic resolver (empty env)', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({
        yieldSnapshotAddresses: [],
        getYieldSnapshotAddresses: async () => [DYNAMIC_SNAP, null, undefined],
      }),
      twoTickClient(getLogs),
    );
    await indexer.tick();
    await indexer.tick();
    expect(snapAddrsOf(getLogs)).toContain(DYNAMIC_SNAP.toLowerCase());
  });

  it('falls back to the env snapshot list when the resolver throws', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({
        yieldSnapshotAddresses: [ENV_SNAP],
        getYieldSnapshotAddresses: async () => {
          throw new Error('DB unreachable');
        },
      }),
      twoTickClient(getLogs),
    );
    await indexer.tick();
    await indexer.tick();
    expect(snapAddrsOf(getLogs)).toContain(ENV_SNAP.toLowerCase());
  });

  it('does NOT stall the indexer when the YieldSnapshot getLogs rejects', async () => {
    const getLogs = vi.fn().mockImplementation((p: any) => {
      const addrs = Array.isArray(p.address) ? p.address : [p.address];
      if (addrs.some((a: string) => a?.toLowerCase() === ENV_SNAP.toLowerCase())) {
        return Promise.reject(new Error('eth_getLogs: too many addresses'));
      }
      return Promise.resolve([]);
    });
    const indexer = new TaxEventIndexer(
      taxEventRepo,
      defaultIndexerConfig({ yieldSnapshotAddresses: [ENV_SNAP] }),
      twoTickClient(getLogs),
    );
    await indexer.tick();
    await expect(indexer.tick()).resolves.toBeUndefined();
    expect(indexer.getStatus().lastProcessedBlock).toBe('105');
  });
});
