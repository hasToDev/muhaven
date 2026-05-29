/**
 * Wave 5 Slice 2c — unit tests for the shared reinvest-execution core
 * (`src/reinvest/execute.ts::buildAndSubmitReinvestBatch`).
 *
 * Self-contained stubs (broker / bundler / backend cast to the client
 * types) — the core is a focused pipeline, so we exercise each gate +
 * the happy atomic-batch submit without the full ToolDeps harness.
 */

import { describe, it, expect, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { buildAndSubmitReinvestBatch } from '../src/reinvest/execute.js';
import type { ReinvestBatchDeps, ReinvestBatchInput } from '../src/reinvest/execute.js';
import type { BrokerClient } from '../src/clients/broker-client.js';
import type { BundlerClient } from '../src/clients/bundler-client.js';
import type { BackendClient } from '../src/clients/backend-client.js';
import type { PolicySnapshotWire } from '../src/broker/protocol.js';
import { encodeKernelExecuteBatch } from '../src/clients/kernel-encoder.js';
import {
  PLACEHOLDER_SIGNATURE,
  SUBSCRIPTION_PURCHASE_ABI,
  SUBSCRIPTION_PURCHASE_SELECTOR,
  YIELD_SNAPSHOT_CLAIM_ABI,
  YIELD_SNAPSHOT_CLAIM_SELECTOR,
} from '../src/clients/path-d-encoding.js';

const SIGNER = ('0x' + '1'.repeat(40)) as `0x${string}`;
const KERNEL = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const SUBSCRIPTION = ('0x' + '2'.repeat(40)) as `0x${string}`;
const SNAPSHOT_ADDR = ('0x' + '3'.repeat(40)) as `0x${string}`;
const TOKEN = ('0x' + '4'.repeat(40)) as `0x${string}`;
const EPH = ('0x' + '5'.repeat(40)) as `0x${string}`;
const PERMISSION_ID = '0xdeadbeef' as `0x${string}`;
const ENTRY_POINT = ('0x' + '7'.repeat(40)) as `0x${string}`;
const CHAIN_ID = 421614;
const NONCE = 5n;
const FEE = {
  maxFeePerGas: '0x3b9aca00' as `0x${string}`,
  maxPriorityFeePerGas: '0x3b9aca00' as `0x${string}`,
};
const SPONSORED = {
  paymaster: ('0x' + '8'.repeat(40)) as `0x${string}`,
  paymasterVerificationGasLimit: '0x186a0' as `0x${string}`,
  paymasterPostOpGasLimit: '0x186a0' as `0x${string}`,
  paymasterData: '0x' as `0x${string}`,
  callGasLimit: '0x30d40' as `0x${string}`,
  verificationGasLimit: '0x30d40' as `0x${string}`,
  preVerificationGas: '0x15f90' as `0x${string}`,
};
const ENC = {
  encShares: {
    ctHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
    securityZone: 0,
    utype: 5,
    signature: ('0x' + 'dd'.repeat(65)) as `0x${string}`,
  },
  ephemeralEOA: ('0x' + '6'.repeat(40)) as `0x${string}`,
};

function snapshotWith(over: Partial<PolicySnapshotWire> = {}): PolicySnapshotWire {
  return {
    sessionId: 'sess_reinvest',
    mode: 'scoped',
    signerAddress: SIGNER,
    targetContracts: [SUBSCRIPTION, SNAPSHOT_ADDR],
    selectorCaps: [
      { selector: SUBSCRIPTION_PURCHASE_SELECTOR, capArgIndex: 2, maxAmount: '1000' },
      { selector: YIELD_SNAPSHOT_CLAIM_SELECTOR, capArgIndex: null, maxAmount: null },
    ],
    validUntilSec: 9_999_999_999,
    mintedAtSec: 1_700_000_000,
    permissionId: PERMISSION_ID,
    ...over,
  };
}

interface BrokerOver {
  preflight?: unknown;
  activeSessionId?: string | null;
  snapshot?: PolicySnapshotWire | null;
  signUserOpSig?: `0x${string}`;
}
function stubBroker(over: BrokerOver = {}): {
  broker: BrokerClient;
  signUserOp: ReturnType<typeof vi.fn>;
  clearPolicySnapshot: ReturnType<typeof vi.fn>;
} {
  const signUserOp = vi.fn().mockResolvedValue({
    type: 'sign_userop',
    sessionId: 'sess_reinvest',
    signerAddress: SIGNER,
    signature: over.signUserOpSig ?? (('0x' + 'ab'.repeat(65)) as `0x${string}`),
  });
  const clearPolicySnapshot = vi.fn().mockResolvedValue({ type: 'clear_policy_snapshot', cleared: true });
  const broker = {
    preflight: vi.fn().mockResolvedValue(
      over.preflight ?? { supported: true, daemonVersion: '0.6.0', signerAddress: SIGNER },
    ),
    getActiveSessionId: vi.fn().mockResolvedValue({
      type: 'get_active_session_id',
      sessionId: 'activeSessionId' in over ? over.activeSessionId : 'sess_reinvest',
    }),
    getPolicySnapshot: vi.fn().mockResolvedValue({
      type: 'get_policy_snapshot',
      snapshot: over.snapshot === undefined ? snapshotWith() : over.snapshot,
    }),
    signUserOp,
    clearPolicySnapshot,
  } as unknown as BrokerClient;
  return { broker, signUserOp, clearPolicySnapshot };
}

interface BackendOver {
  enableStatus?: 'pending' | 'enabled' | 'failed' | null;
  mirrorNull?: boolean;
  accountAddress?: string;
}
function stubBackend(over: BackendOver = {}): BackendClient {
  return {
    get: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/v1/agent/policy/state') {
        return { accountAddress: over.accountAddress ?? KERNEL };
      }
      if (path === '/api/v1/agent/policy/scoped-session') {
        if (over.mirrorNull) return { session: null };
        return { session: { enableStatus: over.enableStatus ?? 'enabled' } };
      }
      throw new Error(`unstubbed backend.get ${path}`);
    }),
    post: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/v1/agent/path-d/mint-ephemeral') return { ephemeralEOA: EPH };
      if (path === '/api/v1/agent/path-d/encrypt-shares') return ENC;
      throw new Error(`unstubbed backend.post ${path}`);
    }),
  } as unknown as BackendClient;
}

/** Recompute the userOpHash the core will produce for buyShares, so the
 *  bundler stub can echo it (the core refuses on hash mismatch). */
function expectedHash(buyShares: bigint): `0x${string}` {
  const claimCallData = encodeFunctionData({
    abi: YIELD_SNAPSHOT_CLAIM_ABI,
    functionName: 'claimYield',
    args: [6n, EPH],
  } as Parameters<typeof encodeFunctionData>[0]) as `0x${string}`;
  const buyCallData = encodeFunctionData({
    abi: SUBSCRIPTION_PURCHASE_ABI,
    functionName: 'purchase',
    args: [
      TOKEN,
      {
        ctHash: BigInt(ENC.encShares.ctHash),
        securityZone: ENC.encShares.securityZone,
        utype: ENC.encShares.utype,
        signature: ENC.encShares.signature,
      },
      buyShares,
      ENC.ephemeralEOA,
    ],
  } as Parameters<typeof encodeFunctionData>[0]) as `0x${string}`;
  const kernelCallData = encodeKernelExecuteBatch({
    calls: [
      { target: SNAPSHOT_ADDR, value: 0n, callData: claimCallData },
      { target: SUBSCRIPTION, value: 0n, callData: buyCallData },
    ],
  });
  return getUserOperationHash({
    userOperation: {
      sender: KERNEL,
      nonce: NONCE,
      factory: undefined,
      factoryData: undefined,
      callData: kernelCallData,
      callGasLimit: BigInt(SPONSORED.callGasLimit),
      verificationGasLimit: BigInt(SPONSORED.verificationGasLimit),
      preVerificationGas: BigInt(SPONSORED.preVerificationGas),
      maxFeePerGas: BigInt(FEE.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(FEE.maxPriorityFeePerGas),
      paymaster: SPONSORED.paymaster,
      paymasterVerificationGasLimit: BigInt(SPONSORED.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(SPONSORED.paymasterPostOpGasLimit),
      paymasterData: SPONSORED.paymasterData,
      signature: PLACEHOLDER_SIGNATURE,
    } as unknown as Parameters<typeof getUserOperationHash>[0]['userOperation'],
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: '0.7',
    chainId: CHAIN_ID,
  });
}

function stubBundler(opts: {
  sendUserOp?: `0x${string}`;
  waitForReceipt?: unknown | Error;
}): { bundler: BundlerClient; sendUserOp: ReturnType<typeof vi.fn>; getReceipt: ReturnType<typeof vi.fn> } {
  const sendUserOp = vi.fn().mockResolvedValue(opts.sendUserOp ?? (('0x' + '0'.repeat(64)) as `0x${string}`));
  const getReceipt = vi.fn().mockResolvedValue(null);
  const bundler = {
    drainTrace: vi.fn().mockReturnValue([]),
    getNonce: vi.fn().mockResolvedValue(NONCE),
    getFeeData: vi.fn().mockResolvedValue(FEE),
    sponsorUserOp: vi.fn().mockResolvedValue(SPONSORED),
    sendUserOp,
    waitForReceipt: vi.fn().mockImplementation(async () => {
      const v = opts.waitForReceipt;
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error('receipt_timeout');
      return v;
    }),
    getReceipt,
  } as unknown as BundlerClient;
  return { bundler, sendUserOp, getReceipt };
}

function baseInput(over: Partial<ReinvestBatchInput> = {}): ReinvestBatchInput {
  return {
    epochId: 6n,
    tokenAddress: TOKEN,
    tokenSymbol: 'CETES',
    snapshotAddress: SNAPSHOT_ADDR,
    requestedShares: 1n,
    budgetUsd6: 1_000_000n,
    reinvestCycleId: '11111111-2222-4333-8444-555555555555',
    ...over,
  };
}

function deps(broker: BrokerClient, bundler: BundlerClient, backend: BackendClient): ReinvestBatchDeps {
  return { broker, bundler, backend, entryPointAddress: ENTRY_POINT, chainId: CHAIN_ID, subscriptionAddress: SUBSCRIPTION };
}

const happyReceipt = (h: `0x${string}`) => ({
  userOpHash: h,
  sender: KERNEL,
  success: true,
  receipt: {
    transactionHash: ('0x' + 'd'.repeat(64)) as `0x${string}`,
    blockNumber: '0x10' as `0x${string}`,
    blockHash: ('0x' + 'e'.repeat(64)) as `0x${string}`,
  },
});

describe('buildAndSubmitReinvestBatch', () => {
  it('builds + signs + submits the atomic [claim, buy] batch on the happy path', async () => {
    const hash = expectedHash(1n);
    const { broker, signUserOp } = stubBroker();
    const { bundler } = stubBundler({ sendUserOp: hash, waitForReceipt: happyReceipt(hash) });
    const backend = stubBackend();
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, backend));
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.userOpHash).toBe(hash);
      expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.buyShares).toBe(1n);
    }
    // The broker MUST receive innerCalls=[claim, buy] (per-leg policy check).
    const arg = signUserOp.mock.calls[0][0];
    expect(arg.innerCalls).toHaveLength(2);
    expect(arg.innerCalls[0].target.toLowerCase()).toBe(SNAPSHOT_ADDR.toLowerCase());
    expect(arg.innerCalls[1].target.toLowerCase()).toBe(SUBSCRIPTION.toLowerCase());
    // innerCall (single, back-compat) = the claim leg.
    expect(arg.innerCall.target.toLowerCase()).toBe(SNAPSHOT_ADDR.toLowerCase());
  });

  it('skips when the broker is not ready (preflight unsupported)', async () => {
    const { broker } = stubBroker({
      preflight: { supported: false, reason: 'broker_unreachable', message: 'down', requiredVersion: '0.6.0' },
    });
    const { bundler } = stubBundler({});
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, stubBackend()));
    expect(res).toMatchObject({ kind: 'skip', reason: 'broker_not_ready' });
  });

  it('skips when the broker has no active session snapshot', async () => {
    const { broker } = stubBroker({ activeSessionId: null });
    const { bundler } = stubBundler({});
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, stubBackend()));
    expect(res).toMatchObject({ kind: 'skip', reason: 'no_active_snapshot' });
  });

  it('skips on signer mismatch (key rotated)', async () => {
    const { broker } = stubBroker({ snapshot: snapshotWith({ signerAddress: ('0x' + '9'.repeat(40)) as `0x${string}` }) });
    const { bundler } = stubBundler({});
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, stubBackend()));
    expect(res).toMatchObject({ kind: 'skip', reason: 'signer_mismatch' });
  });

  it('skips when the validator is not enabled (pending) — MODE.DEFAULT-only v1', async () => {
    const { broker } = stubBroker();
    const { bundler } = stubBundler({});
    const res = await buildAndSubmitReinvestBatch(
      baseInput(),
      deps(broker, bundler, stubBackend({ enableStatus: 'pending' })),
    );
    expect(res).toMatchObject({ kind: 'skip', reason: 'validator_not_enabled' });
  });

  it('skips + purges the broker snapshot when the session was revoked (mirror null)', async () => {
    const { broker, clearPolicySnapshot } = stubBroker();
    const { bundler } = stubBundler({});
    const res = await buildAndSubmitReinvestBatch(
      baseInput(),
      deps(broker, bundler, stubBackend({ mirrorNull: true })),
    );
    expect(res).toMatchObject({ kind: 'skip', reason: 'session_revoked' });
    expect(clearPolicySnapshot).toHaveBeenCalledWith('sess_reinvest');
  });

  it('clamps the buy to the per-op cap when the budget converts to more shares', async () => {
    // requestedShares 5000 > cap 1000 → clamps to 1000.
    const hash = expectedHash(1000n);
    const { broker, signUserOp } = stubBroker();
    const { bundler } = stubBundler({ sendUserOp: hash, waitForReceipt: happyReceipt(hash) });
    const res = await buildAndSubmitReinvestBatch(
      baseInput({ requestedShares: 5000n }),
      deps(broker, bundler, stubBackend()),
    );
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.buyShares).toBe(1000n);
    expect(signUserOp).toHaveBeenCalled();
  });

  it('returns submitted_no_receipt when the receipt does not land in time', async () => {
    const hash = expectedHash(1n);
    const { broker } = stubBroker();
    const { bundler } = stubBundler({ sendUserOp: hash, waitForReceipt: new Error('receipt_timeout') });
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, stubBackend()));
    expect(res).toMatchObject({ kind: 'submitted_no_receipt', userOpHash: hash });
  });

  it('treats a bundler hash mismatch as submitted (fail-closed) — sets cooldown, does NOT re-submit', async () => {
    // The bundler accepted the op but echoed a different hash than we signed.
    // The headless runner has no LLM to verify, so it must fail CLOSED:
    // return submitted_no_receipt (with OUR signed hash) so the daemon waits
    // out the cooldown instead of re-submitting into a double-fill window.
    const { broker } = stubBroker();
    const ourHash = expectedHash(1n);
    const { bundler } = stubBundler({ sendUserOp: ('0x' + 'f'.repeat(64)) as `0x${string}` });
    const res = await buildAndSubmitReinvestBatch(baseInput(), deps(broker, bundler, stubBackend()));
    expect(res).toMatchObject({ kind: 'submitted_no_receipt', userOpHash: ourHash });
  });
});
