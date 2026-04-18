import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { BlockchainEventPoller } from '../event-poller.js';
import { ProcessEscrowEventUseCase } from '../../../application/use-case/webhook/process-escrow-event.use-case.js';
import { MemoryEscrowRepository } from '../../repository/memory/memory-escrow.repository.js';
import { MemoryEscrowEventRepository } from '../../repository/memory/memory-escrow-event.repository.js';
import { MemoryYieldRecordRepository } from '../../repository/memory/memory-yield-record.repository.js';
import { MemoryUserRepository } from '../../repository/memory/memory-user.repository.js';

/**
 * Default `readContract` handler for tests that don't care about enrichment.
 * Tests that exercise the EscrowIdsAttached path override this.
 */
function defaultReadContract(_args: unknown) {
  throw new Error('readContract not configured for this test');
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getLogs: vi.fn().mockResolvedValue([]),
    readContract: vi.fn(defaultReadContract),
    ...overrides,
  } as any;
}

function defaultConfig() {
  return {
    rpcUrl: '',
    escrowAddress: '0x1' as `0x${string}`,
    yieldDistributorAddress: '0x2' as `0x${string}`,
    investorRegistryAddress: '0x3' as `0x${string}`,
    intervalMs: 1000,
  };
}

function createUseCase() {
  return new ProcessEscrowEventUseCase(
    new MemoryEscrowRepository(),
    new MemoryEscrowEventRepository(),
    new MemoryYieldRecordRepository(),
    new MemoryUserRepository(),
  );
}

describe('BlockchainEventPoller', () => {
  let useCase: ProcessEscrowEventUseCase;

  beforeEach(() => {
    useCase = createUseCase();
  });

  it('initializes cursor on first tick without fetching logs', async () => {
    const client = createMockClient({ getBlockNumber: vi.fn().mockResolvedValue(500n) });
    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick();

    expect(client.getBlockNumber).toHaveBeenCalledOnce();
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(poller.getStatus().lastProcessedBlock).toBe('500');
  });

  it('skips when no new blocks since last tick', async () => {
    const client = createMockClient({ getBlockNumber: vi.fn().mockResolvedValue(100n) });
    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick(); // init
    await poller.tick(); // same block → no fetch

    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('fetches logs for new block range and feeds pipeline', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockResolvedValue([]),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick(); // init cursor at 100
    await poller.tick(); // fetch 101–105, no events

    expect(client.getLogs).toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('enriches EscrowIdsAttached by reading on-chain escrowIds + investors + token', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;

    const distributorLogs = [
      {
        eventName: 'DistributionStarted',
        args: { distributionId: 7n, token: '0xTokenAddr', investorCount: 2n },
        transactionHash: '0xtxStart',
        blockNumber: 101n,
      },
      {
        eventName: 'EscrowIdsAttached',
        args: { distributionId: 7n, count: 2n },
        transactionHash: '0xtxAttach',
        blockNumber: 102n,
      },
    ];

    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (params.address === '0x2') return Promise.resolve(distributorLogs);
        return Promise.resolve([]);
      }),
      readContract: vi.fn().mockImplementation((call: any) => {
        if (call.functionName === 'getEscrowIds') return Promise.resolve([42n, 43n]);
        if (call.functionName === 'getInvestorsPaginated') return Promise.resolve(['0xInvestorA', '0xInvestorB']);
        throw new Error(`unexpected readContract ${call.functionName}`);
      }),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick(); // init
    await poller.tick(); // fetch

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      event_type: 'EscrowCreated',
      escrow_id: '42',
      beneficiary: '0xInvestorA',
      distribution_id: 7,
      token_address: '0xTokenAddr',
    });
    expect(payloads[1]).toMatchObject({
      event_type: 'EscrowCreated',
      escrow_id: '43',
      beneficiary: '0xInvestorB',
      distribution_id: 7,
      token_address: '0xTokenAddr',
    });
  });

  it('falls back to getDistribution for token when DistributionStarted is outside the window', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;

    const distributorLogs = [
      // No DistributionStarted in this window — it was in an earlier poll.
      {
        eventName: 'EscrowIdsAttached',
        args: { distributionId: 7n, count: 1n },
        transactionHash: '0xtxAttach',
        blockNumber: 102n,
      },
    ];

    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (params.address === '0x2') return Promise.resolve(distributorLogs);
        return Promise.resolve([]);
      }),
      readContract: vi.fn().mockImplementation((call: any) => {
        if (call.functionName === 'getEscrowIds') return Promise.resolve([42n]);
        if (call.functionName === 'getInvestorsPaginated') return Promise.resolve(['0xInvestorA']);
        if (call.functionName === 'getDistribution') {
          return Promise.resolve(['0xTokenAddr', '0x00', '0x00', 1n, 1n, 1n, 2]);
        }
        throw new Error(`unexpected readContract ${call.functionName}`);
      }),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick();
    await poller.tick();

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.token_address).toBe('0xTokenAddr');
  });

  it('handles EscrowRedeemed events as a pass-through', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;

    const escrowLogs = [
      {
        eventName: 'EscrowRedeemed',
        args: { escrowId: 99n },
        transactionHash: '0xtx2',
        blockNumber: 103n,
      },
    ];

    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (params.address === '0x1') return Promise.resolve(escrowLogs);
        return Promise.resolve([]);
      }),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick();
    await poller.tick();

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event_type: 'EscrowRedeemed',
      escrow_id: '99',
    });
  });

  it('does not advance cursor on error', async () => {
    let callCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(100n);
        return Promise.resolve(105n);
      }),
      getLogs: vi.fn().mockRejectedValue(new Error('RPC error')),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    await poller.tick(); // init at 100
    await poller.tick(); // getLogs throws → cursor stays at 100

    expect(poller.getStatus().lastProcessedBlock).toBe('100');
  });

  it('prevents concurrent ticks', async () => {
    let resolveGetBlock: ((v: bigint) => void) | null = null;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        return new Promise<bigint>((resolve) => {
          resolveGetBlock = resolve;
        });
      }),
    });

    const poller = new BlockchainEventPoller(useCase, defaultConfig(), client);

    const tick1 = poller.tick();
    await poller.tick(); // reentrancy guard

    expect(client.getBlockNumber).toHaveBeenCalledOnce();

    resolveGetBlock!(100n);
    await tick1;
  });
});
