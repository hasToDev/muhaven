// `OnChainRiskParamsAdapter` calls `getLogger()` which lazy-loads
// `getEnv()`. Provide a JWT_SECRET so the env-schema parse doesn't fail
// when the suite runs in isolation.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { OnChainRiskParamsAdapter } from '../on-chain-risk-params.adapter.js';
import { BreachCode } from '../risk-params.adapter.js';
import { ActionId } from '../../../domain/agent/model/action-id.enum.js';
import type { FheWorkerClient, FheBatchResponse } from '../../fhe/fhe-worker.client.js';

const RISK_PARAMS_ADDR = '0x1111111111111111111111111111111111111111' as const;
const INVESTOR = '0x2222222222222222222222222222222222222222' as const;
// Hardhat account #0 — pre-funded; only used as the agent EOA for tests.
const AGENT_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RPC_URL = 'http://127.0.0.1:8545';

// PolicyChecked event topic0 — keccak256("PolicyChecked(address,uint8,bytes32,uint8)")
const POLICY_CHECKED_TOPIC =
  '0xc1c14e9e92ba32f49ff7d6df0e72a14d4ec05ad95d4e3d5e89dee47a1a5a3c1d';

/**
 * Synthesise a PolicyChecked event log for the receipt mock. We do this
 * by computing the topic0 hash dynamically — typed addresses for indexed
 * params, raw data for non-indexed. The event signature:
 *   PolicyChecked(address indexed, uint8 indexed, bytes32, uint8)
 */
function buildPolicyCheckedLog(opts: {
  contract: `0x${string}`;
  investor: `0x${string}`;
  actionId: number;
  ePassedHandle: `0x${string}`;
  breachId: number;
  topicHash: `0x${string}`;
}): {
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  transactionIndex: number;
  blockHash: `0x${string}`;
  logIndex: number;
  removed: boolean;
} {
  const padHex = (hex: string, bytes = 32): `0x${string}` => {
    const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
    return `0x${stripped.padStart(bytes * 2, '0')}` as `0x${string}`;
  };
  return {
    address: opts.contract,
    topics: [
      opts.topicHash,
      padHex(opts.investor),
      padHex(opts.actionId.toString(16)),
    ],
    data: ((): `0x${string}` => {
      const handleNoPrefix = opts.ePassedHandle.startsWith('0x')
        ? opts.ePassedHandle.slice(2)
        : opts.ePassedHandle;
      const breachNoPrefix = opts.breachId.toString(16).padStart(64, '0');
      return `0x${handleNoPrefix.padStart(64, '0')}${breachNoPrefix}` as `0x${string}`;
    })(),
    blockNumber: 1n,
    transactionHash: '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
    transactionIndex: 0,
    blockHash: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
    logIndex: 0,
    removed: false,
  };
}

function fakeEncryptResponse(): FheBatchResponse {
  return {
    results: [
      {
        type: 'euint64',
        data: '0x0000000000000000000000000000000000000000000000000000000000000abc',
        securityZone: 0,
        utype: 0,
        inputProof: '0xabcd',
        encryptionTimeMs: 100,
      },
    ],
    totalEncryptionTimeMs: 100,
  };
}

function makeMockFheWorker(overrides?: Partial<FheWorkerClient>): FheWorkerClient {
  const base = {
    encryptBatch: vi.fn().mockResolvedValue(fakeEncryptResponse()),
    decryptForTx: vi.fn().mockResolvedValue({
      ctHash: '0x0',
      decryptedValue: '0',
      signature: '0xfeedfeed',
      durationMs: 1200,
    }),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
  return Object.assign(base, overrides) as unknown as FheWorkerClient;
}

/**
 * Create an adapter with stubbed clients. We override `walletClient.writeContract`
 * and `publicClient.waitForTransactionReceipt` after construction by Object.assign
 * so the adapter never reaches a real RPC.
 */
function makeAdapter(opts: {
  fheWorker: FheWorkerClient;
  receiptLogs: ReturnType<typeof buildPolicyCheckedLog>[];
  txStatus?: 'success' | 'reverted';
  writeFails?: boolean;
}): OnChainRiskParamsAdapter {
  const adapter = new OnChainRiskParamsAdapter(
    {
      rpcUrl: RPC_URL,
      riskParamsAddress: RISK_PARAMS_ADDR,
      agentPrivateKey: AGENT_PK,
    },
    opts.fheWorker,
  );

  const wallet = (adapter as unknown as { walletClient: { writeContract: unknown } })
    .walletClient;
  wallet.writeContract = opts.writeFails
    ? vi.fn().mockRejectedValue(new Error('rpc Forbidden'))
    : vi.fn().mockResolvedValue(
        '0xabc1230000000000000000000000000000000000000000000000000000000000',
      );

  const pub = (adapter as unknown as {
    publicClient: { waitForTransactionReceipt: unknown };
  }).publicClient;
  pub.waitForTransactionReceipt = vi.fn().mockResolvedValue({
    status: opts.txStatus ?? 'success',
    logs: opts.receiptLogs,
  });

  return adapter;
}

describe('OnChainRiskParamsAdapter', () => {
  // Resolve the actual topic0 once — viem's keccak256-on-string is the
  // canonical way; we re-derive at runtime so the test is robust to a
  // future event-signature change.
  let topicHash: `0x${string}`;

  beforeEach(async () => {
    const { keccak256, toHex } = await import('viem');
    topicHash = keccak256(toHex('PolicyChecked(address,uint8,bytes32,uint8)'));
  });

  it('encrypts a candidate spend, submits checkAndExecute, returns BreachCode.None on clean check', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: INVESTOR,
          actionId: ActionId.Buy,
          ePassedHandle:
            '0x0000000000000000000000000000000000000000000000000000000000000777',
          breachId: 0,
          topicHash,
        }),
      ],
    });

    const out = await adapter.checkAndExecute(INVESTOR, null, ActionId.Buy);

    expect(out.breachCode).toBe(BreachCode.None);
    expect(out.ePassedHandle).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000777',
    );
    expect(fheWorker.encryptBatch).toHaveBeenCalledOnce();
  });

  it('translates breachId 1 → BreachCode.OracleStale and skips decrypt', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: INVESTOR,
          actionId: ActionId.Buy,
          ePassedHandle: '0x0',
          breachId: 1,
          topicHash,
        }),
      ],
    });
    const out = await adapter.checkAndExecute(INVESTOR, null, ActionId.Buy);
    expect(out.breachCode).toBe(BreachCode.OracleStale);
    expect(out.ePassedHandle).toBeNull();
  });

  it('translates breachId 2 → BreachCode.KycRevoked', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: INVESTOR,
          actionId: ActionId.Buy,
          ePassedHandle: '0x0',
          breachId: 2,
          topicHash,
        }),
      ],
    });
    const out = await adapter.checkAndExecute(INVESTOR, null, ActionId.Buy);
    expect(out.breachCode).toBe(BreachCode.KycRevoked);
  });

  it('translates breachId 3 → BreachCode.UserPaused', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: INVESTOR,
          actionId: ActionId.Buy,
          ePassedHandle: '0x0',
          breachId: 3,
          topicHash,
        }),
      ],
    });
    const out = await adapter.checkAndExecute(INVESTOR, null, ActionId.Buy);
    expect(out.breachCode).toBe(BreachCode.UserPaused);
  });

  it('treats UNKNOWN_ACTION (4) as None — defence-in-depth code, audit-only', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: INVESTOR,
          actionId: ActionId.Buy,
          ePassedHandle: '0x0',
          breachId: 4,
          topicHash,
        }),
      ],
    });
    const out = await adapter.checkAndExecute(INVESTOR, null, ActionId.Buy);
    expect(out.breachCode).toBe(BreachCode.None);
  });

  it('throws when receipt has no PolicyChecked event for the investor', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      // Event for a different investor — adapter should NOT pick it up.
      receiptLogs: [
        buildPolicyCheckedLog({
          contract: RISK_PARAMS_ADDR,
          investor: '0x9999999999999999999999999999999999999999',
          actionId: ActionId.Buy,
          ePassedHandle: '0x0',
          breachId: 0,
          topicHash,
        }),
      ],
    });
    await expect(adapter.checkAndExecute(INVESTOR, null, ActionId.Buy)).rejects.toThrow(
      /PolicyChecked event missing/,
    );
  });

  it('throws on tx revert (status=reverted)', async () => {
    const fheWorker = makeMockFheWorker();
    const adapter = makeAdapter({
      fheWorker,
      receiptLogs: [],
      txStatus: 'reverted',
    });
    await expect(adapter.checkAndExecute(INVESTOR, null, ActionId.Buy)).rejects.toThrow(
      /reverted/,
    );
  });

  it('passes through transient FHE worker errors verbatim (PolicyEngineTickUseCase recognises them)', async () => {
    const fheWorker = makeMockFheWorker({
      encryptBatch: vi.fn().mockRejectedValue(new Error('Forbidden')),
    } as Partial<FheWorkerClient>);
    const adapter = makeAdapter({ fheWorker, receiptLogs: [] });
    await expect(adapter.checkAndExecute(INVESTOR, null, ActionId.Buy)).rejects.toThrow(
      /Forbidden/,
    );
  });

  it('decryptBreachFlag maps "0" → cleartext 0, "1" → cleartext 1', async () => {
    const fheWorker0 = makeMockFheWorker();
    const adapter0 = makeAdapter({ fheWorker: fheWorker0, receiptLogs: [] });
    const out0 = await adapter0.decryptBreachFlag('0xabcd');
    expect(out0.cleartext).toBe(0);
    expect(out0.signature).toBe('0xfeedfeed');

    const fheWorker1 = makeMockFheWorker({
      decryptForTx: vi.fn().mockResolvedValue({
        ctHash: '0xabcd',
        decryptedValue: '1',
        signature: '0xbeef',
        durationMs: 800,
      }),
    } as Partial<FheWorkerClient>);
    const adapter1 = makeAdapter({ fheWorker: fheWorker1, receiptLogs: [] });
    const out1 = await adapter1.decryptBreachFlag('0xabcd');
    expect(out1.cleartext).toBe(1);
  });

  it('decryptBreachFlag also handles the "false"/"true" string variant from cofhejs', async () => {
    const fheWorker = makeMockFheWorker({
      decryptForTx: vi.fn().mockResolvedValue({
        ctHash: '0xabcd',
        decryptedValue: 'false',
        signature: '0xfeed',
        durationMs: 700,
      }),
    } as Partial<FheWorkerClient>);
    const adapter = makeAdapter({ fheWorker, receiptLogs: [] });
    const out = await adapter.decryptBreachFlag('0xabcd');
    expect(out.cleartext).toBe(0);
  });

  it('decryptBreachFlag propagates upstream FHE worker errors', async () => {
    const fheWorker = makeMockFheWorker({
      decryptForTx: vi.fn().mockRejectedValue(new Error('decrypt request failed: Forbidden')),
    } as Partial<FheWorkerClient>);
    const adapter = makeAdapter({ fheWorker, receiptLogs: [] });
    await expect(adapter.decryptBreachFlag('0xabcd')).rejects.toThrow(/Forbidden/);
  });

  it('decryptBreachFlag rejects non-bool cleartext (Code Review #5 hardening)', async () => {
    // Code Review #5 (post-port hardening): the FHE worker's `fheType`
    // parameter is computed but silently dropped at the SDK call site.
    // Without this assertion, a wrong-type handle would surface as a
    // numeric string here and silently map to `cleartext=1` ("no
    // breach"), causing the adapter to fail-open on a real breach.
    const fheWorker = makeMockFheWorker({
      decryptForTx: vi.fn().mockResolvedValue({
        ctHash: '0xabcd',
        decryptedValue: '12345', // a euint64 cleartext, not an ebool
        signature: '0xfeed',
        durationMs: 500,
      }),
    } as Partial<FheWorkerClient>);
    const adapter = makeAdapter({ fheWorker, receiptLogs: [] });
    await expect(adapter.decryptBreachFlag('0xabcd')).rejects.toThrow(
      /expected ebool cleartext.*got "12345"/,
    );
  });
});
