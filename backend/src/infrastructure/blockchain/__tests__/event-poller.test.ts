import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { BlockchainEventPoller } from '../event-poller.js';
import { ProcessEscrowEventUseCase } from '../../../application/use-case/webhook/process-escrow-event.use-case.js';
import { MemoryEscrowRepository } from '../../repository/memory/memory-escrow.repository.js';
import { MemoryEscrowEventRepository } from '../../repository/memory/memory-escrow-event.repository.js';
import { MemoryYieldRecordRepository } from '../../repository/memory/memory-yield-record.repository.js';
import { MemoryUserRepository } from '../../repository/memory/memory-user.repository.js';

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
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
    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick();

    expect(client.getBlockNumber).toHaveBeenCalledOnce();
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(poller.getStatus().lastProcessedBlock).toBe('500');
  });

  it('skips when no new blocks since last tick', async () => {
    const client = createMockClient({ getBlockNumber: vi.fn().mockResolvedValue(100n) });
    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    // First tick sets cursor
    await poller.tick();
    // Second tick — same block
    await poller.tick();

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

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick(); // init cursor at 100
    await poller.tick(); // fetch 101–105

    expect(client.getLogs).toHaveBeenCalled();
    // No events means execute not called (0 payloads)
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('enriches EscrowCreated with distribution context when BatchProcessed found in same tx', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;

    const escrowLogs = [
      {
        eventName: 'EscrowCreated',
        args: { escrowId: 42n, beneficiary: '0xInvestor', gate: '0xGate' },
        transactionHash: '0xtx1',
        blockNumber: 102n,
      },
    ];

    const distributorLogs = [
      {
        eventName: 'BatchProcessed',
        args: { distributionId: 7n, processedCount: 1n, investorCount: 5n },
        transactionHash: '0xtx1',
        blockNumber: 102n,
      },
    ];

    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        // Return escrow logs for escrow address, distributor logs for distributor address
        if (params.address === '0x1') return Promise.resolve(escrowLogs);
        if (params.address === '0x2') return Promise.resolve(distributorLogs);
        return Promise.resolve([]);
      }),
    });

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick(); // init
    await poller.tick(); // fetch

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads).toHaveLength(1);
    expect(payloads[0].event_type).toBe('EscrowCreated');
    expect(payloads[0].escrow_id).toBe('42');
    expect(payloads[0].beneficiary).toBe('0xInvestor');
    expect(payloads[0].distribution_id).toBe(7);
  });

  it('enriches token_address from DistributionStarted by distributionId', async () => {
    const executeSpy = vi.spyOn(useCase, 'execute');
    let callCount = 0;

    const escrowLogs = [
      {
        eventName: 'EscrowCreated',
        args: { escrowId: 42n, beneficiary: '0xInvestor', gate: '0xGate' },
        transactionHash: '0xtxBatch',
        blockNumber: 102n,
      },
    ];

    // DistributionStarted is in a DIFFERENT tx than BatchProcessed/EscrowCreated
    const distributorLogs = [
      {
        eventName: 'DistributionStarted',
        args: { distributionId: 7n, token: '0xTokenAddr', investorCount: 5n },
        transactionHash: '0xtxStart', // different tx!
        blockNumber: 101n,
      },
      {
        eventName: 'BatchProcessed',
        args: { distributionId: 7n, processedCount: 1n, investorCount: 5n },
        transactionHash: '0xtxBatch', // same tx as EscrowCreated
        blockNumber: 102n,
      },
    ];

    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 100n : 105n);
      }),
      getLogs: vi.fn().mockImplementation((params: any) => {
        if (params.address === '0x1') return Promise.resolve(escrowLogs);
        if (params.address === '0x2') return Promise.resolve(distributorLogs);
        return Promise.resolve([]);
      }),
    });

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick();
    await poller.tick();

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads[0].distribution_id).toBe(7);
    expect(payloads[0].token_address).toBe('0xTokenAddr');
  });

  it('handles EscrowRedeemed events', async () => {
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

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick();
    await poller.tick();

    expect(executeSpy).toHaveBeenCalledOnce();
    const payloads = executeSpy.mock.calls[0][0];
    expect(payloads).toHaveLength(1);
    expect(payloads[0].event_type).toBe('EscrowRedeemed');
    expect(payloads[0].escrow_id).toBe('99');
  });

  it('does not advance cursor on error', async () => {
    let callCount = 0;
    const client = createMockClient({
      getBlockNumber: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(100n);
        if (callCount === 2) return Promise.resolve(105n);
        return Promise.resolve(105n);
      }),
      getLogs: vi.fn().mockRejectedValue(new Error('RPC error')),
    });

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    await poller.tick(); // init at 100
    await poller.tick(); // should fail — cursor stays at 100

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

    const poller = new BlockchainEventPoller(
      useCase,
      { rpcUrl: '', escrowAddress: '0x1', yieldDistributorAddress: '0x2', intervalMs: 1000 },
      client,
    );

    // Start first tick (will block on getBlockNumber)
    const tick1 = poller.tick();

    // Second tick should return immediately (reentrancy guard)
    await poller.tick();

    // Only one getBlockNumber call
    expect(client.getBlockNumber).toHaveBeenCalledOnce();

    // Resolve the first tick
    resolveGetBlock!(100n);
    await tick1;
  });
});
