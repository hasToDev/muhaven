import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

vi.mock('../../../core/logger.js', () => ({
  getLogger: (_name?: string) => {
    const stub = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => stub,
    };
    return stub;
  },
}));

import {
  encodeAbiParameters,
  toEventSelector,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { ScopedSession } from '../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../domain/agent/model/surface.enum.js';
import { MemoryScopedSessionRepository } from '../../repository/memory/memory-scoped-session.repository.js';
import { MemoryAgentAuditRepository } from '../../repository/memory/memory-agent-audit.repository.js';
import { AppendAuditEventUseCase } from '../../../application/use-case/agent/policy/append-audit-event.use-case.js';
import { MarkScopedSessionValidatorEnabledUseCase } from '../../../application/use-case/agent/policy/mark-scoped-session-validator-enabled.use-case.js';
import { PermissionInstalledIndexer } from '../permission-installed-indexer.js';

const KERNEL_ADDR = '0x678d2e3F778C4528911b137ED4db282834f3735E' as `0x${string}`;
const PERMISSION_ID = '0xa2500760' as `0x${string}`;
const TX_HASH = ('0x' + '1'.repeat(64)) as `0x${string}`;
const KERNEL_EXECUTE_SELECTOR = '0xe9ae5c53' as `0x${string}`;

/**
 * Build a kernel `SelectorSet(bytes4 selector, bytes21 vId, bool allowed)`
 * log — the ACTUAL on-chain signal of an enable-mode permission install
 * (the deployed kernel does NOT emit `PermissionInstalled`). `vId` =
 * `<typeByte><permissionId(4 bytes)><16 zero bytes>`; default type `0x02`
 * (PERMISSION). All three args are non-indexed → ABI-encoded in `data`.
 */
function makeSelectorSetLog(args: {
  permissionId: Hex; // 0x + 8 hex
  emittedBy: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
  allowed?: boolean;
  /** 2-hex validation-type byte; default '02' (PERMISSION). */
  validationType?: string;
}): Log {
  const typeByte = args.validationType ?? '02';
  // bytes21 = type(1) + permissionId(4) + 16 zero bytes = 42 hex.
  const vId = (`0x${typeByte}${args.permissionId.slice(2)}${'0'.repeat(32)}`) as `0x${string}`;
  const data = encodeAbiParameters(
    [{ type: 'bytes4' }, { type: 'bytes21' }, { type: 'bool' }],
    [KERNEL_EXECUTE_SELECTOR, vId, args.allowed ?? true],
  );
  const sigHash = toEventSelector('SelectorSet(bytes4,bytes21,bool)');
  return {
    address: args.emittedBy,
    blockHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
    blockNumber: args.blockNumber,
    data,
    logIndex: args.logIndex,
    topics: [sigHash] as [`0x${string}`],
    transactionHash: args.txHash,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

function seed(
  repo: MemoryScopedSessionRepository,
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  const session = new ScopedSession({
    sessionId: 'sess-indexer-1',
    userId: 'u1',
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0x38e018e95ead91bb9d91590d3856c2f324d5c3bd',
    permissionId: PERMISSION_ID,
    targetContracts: ['0xbbbb000000000000000000000000000000000002'],
    selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1000000' }],
    maxPerOpUsd6: 100_000_000n,
    totalSpentUsd6: 0n,
    validUntilSec: 2_000_000_000,
    mintedAtSec: 1_000_000_000,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: new Date('2026-05-23T20:00:00.000Z'),
    revokedAt: null,
    expiredAt: null,
    enableStatus: 'pending',
    validatorEnabledAt: null,
    validatorEnabledTxHash: null,
    validatorNonce: 1,
    ...overrides,
  });
  void repo.create(session);
  return session;
}

class StubPublicClient {
  blockNumber = 100n;
  logs: Log[] = [];
  getBlockNumber = vi.fn(async () => this.blockNumber);
  getLogs = vi.fn(async () => this.logs);
}

describe('PermissionInstalledIndexer', () => {
  let repo: MemoryScopedSessionRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let markEnabled: MarkScopedSessionValidatorEnabledUseCase;
  let client: StubPublicClient;
  let indexer: PermissionInstalledIndexer;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    markEnabled = new MarkScopedSessionValidatorEnabledUseCase(repo, appendAudit);
    client = new StubPublicClient();
    indexer = new PermissionInstalledIndexer(
      repo,
      markEnabled,
      { rpcUrl: 'http://stub', intervalMs: 10_000 },
      client as unknown as PublicClient,
    );
  });

  it('first tick anchors cursor at the current head (no re-scan)', async () => {
    seed(repo);
    await indexer.tickOnce();
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
    expect(client.getLogs).not.toHaveBeenCalled();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('pending');
  });

  it('flips a pending row when a matching log appears', async () => {
    seed(repo);
    indexer.setCursorForTests(99n);
    client.blockNumber = 100n;
    client.logs = [
      makeSelectorSetLog({
        permissionId: PERMISSION_ID,
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
      }),
    ];
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('enabled');
    expect(row?.validatorEnabledTxHash).toBe(TX_HASH);
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
  });

  it('skips logs for permissionIds we do not track', async () => {
    seed(repo, { permissionId: '0xabcdabcd' });
    indexer.setCursorForTests(99n);
    client.logs = [
      makeSelectorSetLog({
        permissionId: '0xdeaddead', // different
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
      }),
    ];
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('pending');
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
  });

  it('idempotent — re-processing the same log is a no-op', async () => {
    seed(repo);
    indexer.setCursorForTests(99n);
    client.logs = [
      makeSelectorSetLog({
        permissionId: PERMISSION_ID,
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
      }),
    ];
    await indexer.tickOnce();
    // Reset cursor; re-process same log. Already-enabled row → no
    // throw, no double-audit.
    indexer.setCursorForTests(99n);
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('enabled');
    const audits = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(audits.items).toHaveLength(1);
  });

  it('skips a log when the matching row is already failed (terminal state)', async () => {
    seed(repo, { enableStatus: 'failed' });
    indexer.setCursorForTests(99n);
    client.logs = [
      makeSelectorSetLog({
        permissionId: PERMISSION_ID,
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
      }),
    ];
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    // Row stays failed; the indexer treats failed as a terminal state
    // and does not retry (also no throw → cursor advances).
    expect(row?.enableStatus).toBe('failed');
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
  });

  it('ignores SelectorSet with allowed=false (unbind, not an install)', async () => {
    seed(repo);
    indexer.setCursorForTests(99n);
    client.logs = [
      makeSelectorSetLog({
        permissionId: PERMISSION_ID,
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
        allowed: false,
      }),
    ];
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('pending');
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
  });

  it('ignores SelectorSet for a non-permission validation type (e.g. secondary 0x01)', async () => {
    seed(repo);
    indexer.setCursorForTests(99n);
    client.logs = [
      makeSelectorSetLog({
        permissionId: PERMISSION_ID,
        emittedBy: KERNEL_ADDR,
        blockNumber: 100n,
        txHash: TX_HASH,
        logIndex: 0,
        validationType: '01', // secondary validator, not a permission
      }),
    ];
    await indexer.tickOnce();
    const row = await repo.findById('sess-indexer-1');
    expect(row?.enableStatus).toBe('pending');
    expect(indexer.getStatus().lastProcessedBlock).toBe(100n);
  });

  it('does not advance cursor on getLogs throw', async () => {
    indexer.setCursorForTests(99n);
    client.getLogs.mockRejectedValueOnce(new Error('rpc transient'));
    await indexer.tickOnce();
    expect(indexer.getStatus().lastProcessedBlock).toBe(99n);
  });
});
