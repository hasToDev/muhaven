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
  };
}

function fakeRwaTokenRepo(): IRwaTokenRepository & { updateIssuer: ReturnType<typeof vi.fn> } {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    findByAddress: vi.fn(),
    findByIssuer: vi.fn().mockResolvedValue([]),
    findByStatus: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateIssuer: vi.fn().mockResolvedValue(undefined),
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

    await indexer.tick(); // init at 100
    await indexer.tick(); // throws — cursor stays at 100

    expect(indexer.getStatus().lastProcessedBlock).toBe('100');
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
});
