import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── ethers mock ──────────────────────────────────────────────────────
//
// The runner constructs `new Contract(addr, ABI, signer)` for the
// snapshot proxy, registry, pusdc, and a 4th `pusdc()`-only probe. Method
// names don't collide across those ABIs, so a SINGLE shared mock object
// (`contractImpl`) backs every constructed Contract. `Interface` +
// `ZeroAddress` stay real (importActual) — the finalized-resume path we
// exercise never opens an epoch, so `EpochOpened` parsing isn't reached.
let contractImpl: Record<string, any>;
vi.mock('ethers', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(() => contractImpl),
  };
});

// `Interface` + `ZeroAddress` resolve to the REAL ethers exports (the mock
// spreads `...actual` and only overrides `Contract`) — `Interface` encodes a
// genuine EpochOpened log for the fresh-tick path test; `ZeroAddress` backs
// the FU-3 stranded-epoch (`getEpoch.token == address(0)`) assertion.
import { Interface, ZeroAddress } from 'ethers';
import {
  runYieldEpoch,
  sizeSnapshotYield,
  type RunEpochInput,
  type AuditRow,
} from '../yield-epoch-runner.js';

const RATE_SCALE = 1_000_000n;
const SNAPSHOT_ADDR = '0x2222222222222222222222222222222222222222';
const TOKEN_ADDR = '0xabcdef0000000000000000000000000000000001';
const REGISTRY_ADDR = '0x3333333333333333333333333333333333333333';
const PUSDC_ADDR = '0x4444444444444444444444444444444444444444';
const ISSUER_ADDR = '0x1111111111111111111111111111111111111111';
const SUPPLY_HANDLE = '0x' + 'ab'.repeat(32); // non-zero bytes32

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ── sizeSnapshotYield (pure) ─────────────────────────────────────────

describe('sizeSnapshotYield', () => {
  it('sizes to the decrypted supply when below the cap', () => {
    // 100 supply × rate 96_901_369 / 1e6 = 9690 (floor)
    const { sizedSupply, amount, clamped } = sizeSnapshotYield({
      decryptedSupply: 100n,
      cap: 10_000_000n,
      ratePerShare: 96_901_369n,
    });
    expect(sizedSupply).toBe(100n);
    expect(amount).toBe((100n * 96_901_369n) / RATE_SCALE);
    expect(clamped).toBe(false);
  });

  it('clamps to the cap when supply exceeds it (safety ceiling) and flags clamped', () => {
    const { sizedSupply, amount, clamped } = sizeSnapshotYield({
      decryptedSupply: 50_000_000n,
      cap: 10_000n,
      ratePerShare: 96_901_369n,
    });
    expect(sizedSupply).toBe(10_000n);
    expect(amount).toBe((10_000n * 96_901_369n) / RATE_SCALE);
    expect(clamped).toBe(true);
  });

  it('does NOT flag clamped when supply equals the cap exactly', () => {
    const { sizedSupply, clamped } = sizeSnapshotYield({
      decryptedSupply: 10_000n,
      cap: 10_000n,
      ratePerShare: 96_901_369n,
    });
    expect(sizedSupply).toBe(10_000n);
    expect(clamped).toBe(false);
  });

  it('floors to 0 when supply × rate is sub-RATE_SCALE', () => {
    const { amount } = sizeSnapshotYield({
      decryptedSupply: 1n,
      cap: 10_000_000n,
      ratePerShare: 999_999n, // < RATE_SCALE → floor(1 × 999_999 / 1e6) = 0
    });
    expect(amount).toBe(0n);
  });

  it('matches the on-chain floor-division (sum-of-floor conservation)', () => {
    // amount must equal min(supply,cap) × rate / SCALE with integer floor.
    const supply = 7n;
    const rate = 123_456_789n;
    const { amount } = sizeSnapshotYield({ decryptedSupply: supply, cap: 9n, ratePerShare: rate });
    expect(amount).toBe((supply * rate) / RATE_SCALE);
  });
});

// ── snapshot-funding control flow (resume-finalized path) ────────────
//
// The cheapest reachable path to the fund-sizing block: a `snapshot_done`
// audit row on an already-finalized, not-yet-funded epoch. The runner
// resumes it (skipping openEpoch + snapshotBatch), so we only mock the
// reads the fund phase needs.

function auditRowFinalized(): AuditRow {
  return {
    tokenAddress: TOKEN_ADDR,
    epochId: 5n,
    ratePerShare: 96_901_369n,
    encTotalYieldUsd6: 9_690_136_900n, // cap-based estimate (insertInProgress)
    status: 'snapshot_done',
    fundEpochTxHash: null,
  };
}

function makeCofheClient(opts: {
  supply?: bigint;
  decryptRejects?: boolean;
}) {
  return {
    decryptForView: vi.fn().mockReturnValue({
      withPermit: () => ({
        execute: () =>
          opts.decryptRejects
            ? Promise.reject(new Error('coprocessor not ready'))
            : Promise.resolve(opts.supply ?? 100n),
      }),
    }),
    encryptInputs: vi.fn().mockReturnValue({
      setAccount: () => ({
        execute: () =>
          Promise.resolve([
            { ctHash: 1n, securityZone: 0, utype: 0, signature: '0x' },
          ]),
      }),
    }),
  };
}

function makeAudit(row: AuditRow | null) {
  return {
    insertInProgress: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    findLatestUnresolved: vi.fn().mockResolvedValue(row),
  };
}

function makeInput(overrides: {
  cofheClient?: any;
  audit?: any;
  floatLedger?: { remaining: bigint | null; consume: ReturnType<typeof vi.fn> };
  ratePerShare?: bigint;
  cap?: bigint;
}): RunEpochInput {
  const fundTx = {
    hash: '0xfund',
    wait: vi.fn().mockResolvedValue({ status: 1 }),
  };
  contractImpl = {
    // pusdc()-probe + isOperator (PUSDC_ABI)
    pusdc: vi.fn().mockResolvedValue(PUSDC_ADDR),
    isOperator: vi.fn().mockResolvedValue(true),
    setOperator: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) }),
    // registry
    holderCount: vi.fn().mockResolvedValue(2n),
    getHoldersPaginated: vi.fn().mockResolvedValue([]),
    // snapshot
    currentEpoch: vi.fn().mockResolvedValue(5n),
    getEpoch: vi.fn().mockResolvedValue({
      token: TOKEN_ADDR,
      finalized: true,
      funded: false,
      encTotalSupply: SUPPLY_HANDLE,
      ratePerShare: 0n,
    }),
    snapshotBatch: vi.fn(),
    finalizeSnapshot: vi.fn(),
    fundEpoch: vi.fn().mockResolvedValue(fundTx),
  };

  return {
    symbol: 'USYC',
    tokenAddr: TOKEN_ADDR as any,
    ratePerShare: overrides.ratePerShare ?? 96_901_369n,
    encTotalYield: 9_690_136_900n, // cap-based estimate (ignored in snapshot mode)
    effectiveMaxSupplyCap: overrides.cap ?? 10_000_000n,
    navAtTimeUsd: '1.13',
    apyAtTimePercent: '3.13',
    snapshotAddr: SNAPSHOT_ADDR as any,
    investorRegistryAddr: REGISTRY_ADDR as any,
    pusdcAddr: PUSDC_ADDR as any,
    signer: { address: ISSUER_ADDR, provider: {} } as any,
    cofheClient: overrides.cofheClient ?? makeCofheClient({ supply: 100n }),
    operatorGrantSeconds: 2n * 24n * 60n * 60n,
    revokeOperatorAfterFund: false,
    dryRun: false,
    snapshotBasedFunding: true,
    floatLedger: overrides.floatLedger ?? { remaining: 10_000_000_000n, consume: vi.fn() },
    logger: silentLogger(),
    audit: overrides.audit ?? makeAudit(auditRowFinalized()),
    tokenLock: { release: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('runYieldEpoch snapshot-based funding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrypts supply, sizes to min(supply,cap)×rate, funds, and consumes the float', async () => {
    const consume = vi.fn();
    const audit = makeAudit(auditRowFinalized());
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      audit,
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    const result = await runYieldEpoch(input);

    const expectedAmount = (100n * 96_901_369n) / RATE_SCALE;
    expect(result.status).toBe('resumed_success');
    expect(result.computedYield).toBe(expectedAmount);
    // fundEpoch called with the SNAPSHOT-sized amount, not the cap estimate.
    expect(contractImpl.fundEpoch).toHaveBeenCalledOnce();
    // float consumed by the actual funded amount.
    expect(consume).toHaveBeenCalledWith(expectedAmount);
    // audit row re-stamped with the actual amount at snapshot_done.
    const restamp = audit.updateStatus.mock.calls.find(
      (c: any[]) => c[2] === 'snapshot_done' && c[3]?.encTotalYieldUsd6 !== undefined,
    );
    expect(restamp).toBeTruthy();
    expect(restamp![3].encTotalYieldUsd6).toBe(expectedAmount);
  });

  it('funds the cap ceiling + flags clampedToCapCeiling when supply > cap', async () => {
    const consume = vi.fn();
    // supply (50M) > cap (10M, the default in makeInput) → clamp to cap.
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 50_000_000n }),
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('resumed_success');
    expect(result.clampedToCapCeiling).toBe(true);
    const cappedAmount = (10_000_000n * 96_901_369n) / RATE_SCALE;
    expect(result.computedYield).toBe(cappedAmount);
    expect(contractImpl.fundEpoch).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith(cappedAmount);
  });

  it('skips (supply_decrypt_failed) WITHOUT funding when the decrypt fails', async () => {
    const consume = vi.fn();
    const input = makeInput({
      cofheClient: makeCofheClient({ decryptRejects: true }),
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('supply_decrypt_failed');
    expect(contractImpl.fundEpoch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('skips (insufficient_mhusdc_float) with both amounts when the float is short', async () => {
    const consume = vi.fn();
    const expectedAmount = (100n * 96_901_369n) / RATE_SCALE;
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      // remaining < computed amount → float short.
      floatLedger: { remaining: expectedAmount - 1n, consume },
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('insufficient_mhusdc_float');
    expect(result.computedYield).toBe(expectedAmount);
    expect(result.floatRemaining).toBe(expectedAmount - 1n);
    expect(contractImpl.fundEpoch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('refuses to fund blind when the float read failed (remaining null)', async () => {
    const consume = vi.fn();
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      floatLedger: { remaining: null, consume },
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('insufficient_mhusdc_float');
    expect(contractImpl.fundEpoch).not.toHaveBeenCalled();
  });

  it('skips (zero_snapshot_yield) when supply×rate floors to 0', async () => {
    const consume = vi.fn();
    // On a resume the runner sizes with the STORED audit rate (idempotency),
    // so the sub-RATE_SCALE rate must live on the audit row, not just the
    // input. floor(1 × 999_999 / 1e6) = 0.
    const audit = makeAudit({ ...auditRowFinalized(), ratePerShare: 999_999n });
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 1n }),
      ratePerShare: 999_999n,
      audit,
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('zero_snapshot_yield');
    expect(contractImpl.fundEpoch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('throws when snapshotBasedFunding is set without effectiveMaxSupplyCap', async () => {
    const input = makeInput({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (input as any).effectiveMaxSupplyCap;
    await expect(runYieldEpoch(input)).rejects.toThrow(/effectiveMaxSupplyCap/);
  });

  // H-1 + H-2 crash-window regression (Code-Reviewer LOW-1 / Backend-Arch
  // H-1+H-2). Simulate a DB blip on the post-wait `updateStatus('success')`
  // write on a RESUME tick where the stored rate ≠ the per-tick input rate.
  // The catch reconcile MUST (a) compare on-chain `ep.ratePerShare` against
  // the FUNDED rate (`fundRate` = stored), not the input → write `success`
  // not `failure` (H-1, else next tick double-funds); AND (b) the float must
  // already be consumed before the throw (H-2).
  it('on a success-write crash, reconciles to success vs fundRate + keeps the float consumed', async () => {
    const consume = vi.fn();
    const STORED_RATE = 96_901_369n;
    const INPUT_RATE = 50_000_000n; // deliberately != stored
    const audit = {
      insertInProgress: vi.fn().mockResolvedValue(undefined),
      // Throw ONLY on the post-wait success write (no errorClass); allow the
      // catch reconcile's success write (carries errorClass).
      updateStatus: vi
        .fn()
        .mockImplementation((_e: bigint, _a: string, status: string, fields?: any) => {
          if (status === 'success' && !fields?.errorClass) {
            return Promise.reject(new Error('DB blip on success write'));
          }
          return Promise.resolve(undefined);
        }),
      findLatestUnresolved: vi
        .fn()
        .mockResolvedValue({ ...auditRowFinalized(), ratePerShare: STORED_RATE }),
    };
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      audit,
      ratePerShare: INPUT_RATE,
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    // Stateful epoch: funded flips true once fundEpoch is called, and
    // getEpoch reports the STORED rate on-chain (what we actually funded).
    let funded = false;
    contractImpl.fundEpoch = vi.fn().mockImplementation(() => {
      funded = true;
      return Promise.resolve({ hash: '0xfund', wait: vi.fn().mockResolvedValue({ status: 1 }) });
    });
    contractImpl.getEpoch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        token: TOKEN_ADDR,
        finalized: true,
        funded,
        encTotalSupply: SUPPLY_HANDLE,
        ratePerShare: STORED_RATE,
      }),
    );

    await expect(runYieldEpoch(input)).rejects.toThrow(/DB blip/);

    const expectedAmount = (100n * STORED_RATE) / RATE_SCALE;
    // H-2: float consumed before the throw.
    expect(consume).toHaveBeenCalledWith(expectedAmount);
    // H-1: catch reconcile wrote `success` (compared on-chain rate to the
    // funded `fundRate`=STORED_RATE), NOT `failure`.
    const reconcile = audit.updateStatus.mock.calls.find(
      (c: any[]) => c[2] === 'success' && c[3]?.errorClass !== undefined,
    );
    expect(reconcile).toBeTruthy();
    const wroteFailure = audit.updateStatus.mock.calls.some((c: any[]) => c[2] === 'failure');
    expect(wroteFailure).toBe(false);
  });

  // GAP-4 (Reality Checker): the resume-finalized path is the cheap path the
  // other tests use; this exercises the COMMON production path — a FRESH
  // tick that opens → snapshots → finalizes → decrypts → funds — so the
  // open/snapshot/finalize control flow that precedes the decrypt is covered
  // (the decrypt itself is still mocked; a real CoFHE resolve needs a live
  // smoke, by design).
  it('fresh tick: opens, snapshots, finalizes, then sizes + funds from the decrypted supply', async () => {
    const consume = vi.fn();
    const audit = {
      insertInProgress: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      findLatestUnresolved: vi.fn().mockResolvedValue(null), // no resume → fresh
    };
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      audit,
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    // Fresh-path on-chain shape: no prior epoch, epoch opens at id 7, not yet
    // finalized so the snapshot phase actually runs.
    const epochIface = new Interface([
      'event EpochOpened(address indexed token, uint256 indexed epochId)',
    ]);
    const opened = epochIface.encodeEventLog('EpochOpened', [TOKEN_ADDR, 7n]);
    contractImpl.currentEpoch = vi.fn().mockResolvedValue(0n);
    contractImpl.openEpoch = vi.fn().mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ logs: [{ topics: opened.topics, data: opened.data }] }),
    });
    contractImpl.getHoldersPaginated = vi
      .fn()
      .mockResolvedValue([
        '0x000000000000000000000000000000000000aaa1',
        '0x000000000000000000000000000000000000aaa2',
      ]);
    contractImpl.snapshotBatch = vi
      .fn()
      .mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
    contractImpl.finalizeSnapshot = vi
      .fn()
      .mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
    contractImpl.getEpoch = vi.fn().mockResolvedValue({
      token: TOKEN_ADDR,
      finalized: false, // not finalized → snapshot phase runs
      funded: false,
      encTotalSupply: SUPPLY_HANDLE,
      ratePerShare: 0n,
    });

    const result = await runYieldEpoch(input);

    expect(contractImpl.openEpoch).toHaveBeenCalledOnce();
    expect(contractImpl.snapshotBatch).toHaveBeenCalled();
    expect(contractImpl.finalizeSnapshot).toHaveBeenCalledOnce();
    expect(result.status).toBe('success'); // fresh → not resumed
    expect(result.epochId).toBe(7n);
    const expectedAmount = (100n * 96_901_369n) / RATE_SCALE;
    expect(result.computedYield).toBe(expectedAmount);
    expect(contractImpl.fundEpoch).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledWith(expectedAmount);
  });

  // FU-4 (Wave 5 W2): the yield issuer EOA is shared with the nav crons, so a
  // concurrent NAV tx can reject our fundEpoch with NONCE_EXPIRED. The runner
  // re-queries the nonce + retries the send rather than failing the tick.
  it('retries the fundEpoch send on a NONCE_EXPIRED collision, then succeeds', async () => {
    const consume = vi.fn();
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    let calls = 0;
    contractImpl.fundEpoch = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('nonce too low: next nonce 1393, tx nonce 1392') as Error & {
          code?: string;
        };
        err.code = 'NONCE_EXPIRED';
        return Promise.reject(err);
      }
      return Promise.resolve({ hash: '0xfund', wait: vi.fn().mockResolvedValue({ status: 1 }) });
    });
    const result = await runYieldEpoch(input);
    expect(result.status).toBe('resumed_success');
    expect(contractImpl.fundEpoch).toHaveBeenCalledTimes(2); // 1 rejected + 1 retry
    const expectedAmount = (100n * 96_901_369n) / RATE_SCALE;
    expect(consume).toHaveBeenCalledWith(expectedAmount);
  });

  it('does NOT retry the fundEpoch send on a non-nonce error (propagates immediately)', async () => {
    const consume = vi.fn();
    const input = makeInput({
      cofheClient: makeCofheClient({ supply: 100n }),
      floatLedger: { remaining: 10_000_000_000n, consume },
    });
    contractImpl.fundEpoch = vi
      .fn()
      .mockRejectedValue(new Error('execution reverted: EpochAlreadyFunded'));
    await expect(runYieldEpoch(input)).rejects.toThrow(/EpochAlreadyFunded/);
    // No retry for a non-nonce revert — would otherwise mask a real failure.
    expect(contractImpl.fundEpoch).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });
});

// ── FU-3: stranded-epoch resume guard ────────────────────────────────
//
// A `--dry-run` against prod Postgres synthesises `openEpoch` → epochId 0
// (the on-chain call no-ops under dryRun) yet still advances the audit row.
// Epochs are 1-indexed on-chain (`getEpoch(0).token == address(0)`), so the
// stranded row wedges the next LIVE tick. The runner must resolve it
// `failure` and fall through to the fresh open path instead of re-running
// `snapshotBatch(0)` (→ InvalidEpoch) or throwing OrphanedAuditError forever.

/** Wire `contractImpl` for a fresh open → snapshot → finalize → fund flow
 *  (currentEpoch 0, openEpoch emits the given id, epoch not finalized). The
 *  `getEpoch` override lets a caller make a specific stranded id read back as
 *  token==address(0) while the freshly-opened id reads back valid. */
function wireFreshOpen(openedId: bigint, getEpochImpl?: (id: bigint) => any) {
  const epochIface = new Interface([
    'event EpochOpened(address indexed token, uint256 indexed epochId)',
  ]);
  const opened = epochIface.encodeEventLog('EpochOpened', [TOKEN_ADDR, openedId]);
  contractImpl.currentEpoch = vi.fn().mockResolvedValue(0n);
  contractImpl.openEpoch = vi.fn().mockResolvedValue({
    wait: vi.fn().mockResolvedValue({ logs: [{ topics: opened.topics, data: opened.data }] }),
  });
  contractImpl.getHoldersPaginated = vi
    .fn()
    .mockResolvedValue(['0x000000000000000000000000000000000000aaa1']);
  contractImpl.snapshotBatch = vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
  contractImpl.finalizeSnapshot = vi
    .fn()
    .mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) });
  contractImpl.getEpoch = vi
    .fn()
    .mockImplementation((id: bigint) =>
      Promise.resolve(
        getEpochImpl?.(id) ?? {
          token: TOKEN_ADDR,
          finalized: false, // not finalized → snapshot phase runs
          funded: false,
          encTotalSupply: SUPPLY_HANDLE,
          ratePerShare: 0n,
        },
      ),
    );
}

describe('runYieldEpoch FU-3 stranded-epoch resume guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a stranded epoch_id=0 audit row to failure, then opens a fresh epoch', async () => {
    const audit = makeAudit({ ...auditRowFinalized(), epochId: 0n });
    const input = makeInput({ cofheClient: makeCofheClient({ supply: 100n }), audit });
    wireFreshOpen(7n);

    const result = await runYieldEpoch(input);

    // The poison row was resolved to `failure` with the FU-3 errorClass.
    const failureWrite = audit.updateStatus.mock.calls.find(
      (c: any[]) => c[0] === 0n && c[2] === 'failure',
    );
    expect(failureWrite).toBeTruthy();
    expect(failureWrite![3].errorClass).toBe('StrandedAuditEpoch');
    // Never ran snapshotBatch against epoch 0 — opened a fresh epoch instead.
    expect(contractImpl.snapshotBatch).not.toHaveBeenCalledWith(0n, expect.anything());
    expect(contractImpl.openEpoch).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect(result.epochId).toBe(7n);
  });

  it('resolves a stranded >0 audit row whose epoch never existed on-chain (token==address(0))', async () => {
    const audit = makeAudit({ ...auditRowFinalized(), epochId: 9n });
    const input = makeInput({ cofheClient: makeCofheClient({ supply: 100n }), audit });
    // Epoch 9 reads back token==address(0) (never opened); the freshly-opened
    // epoch (7) reads back valid so the open→fund flow completes.
    wireFreshOpen(7n, (id) =>
      id === 9n
        ? {
            token: ZeroAddress,
            finalized: false,
            funded: false,
            encTotalSupply: '0x' + '00'.repeat(32),
            ratePerShare: 0n,
          }
        : undefined,
    );

    const result = await runYieldEpoch(input);

    const failureWrite = audit.updateStatus.mock.calls.find(
      (c: any[]) => c[0] === 9n && c[2] === 'failure',
    );
    expect(failureWrite).toBeTruthy();
    expect(failureWrite![3].errorClass).toBe('StrandedAuditEpoch');
    expect(contractImpl.snapshotBatch).not.toHaveBeenCalledWith(9n, expect.anything());
    expect(contractImpl.openEpoch).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect(result.epochId).toBe(7n);
  });

  it('resolves an epoch_id=0 poison then RESUMES the real on-chain epoch (no OrphanedAuditError)', async () => {
    // Second wedge mode: a real epoch (7, finalized-but-unfunded) exists
    // on-chain but the latest UNRESOLVED audit row is the epoch-0 poison.
    // Pre-fix, `currentEpoch(7) !== auditRow.epochId(0)` threw
    // OrphanedAuditError forever. Post-fix: resolve the poison, then the
    // currentForToken branch resumes epoch 7 (back-fills via the UPSERT).
    const audit = makeAudit({ ...auditRowFinalized(), epochId: 0n });
    const input = makeInput({ cofheClient: makeCofheClient({ supply: 100n }), audit });
    contractImpl.currentEpoch = vi.fn().mockResolvedValue(7n);
    // Epoch 7 reads back finalized-but-unfunded → resume + fund (no open).
    // `holderCount` is logged by the back-fill resume branch.
    contractImpl.getEpoch = vi.fn().mockResolvedValue({
      token: TOKEN_ADDR,
      finalized: true,
      funded: false,
      encTotalSupply: SUPPLY_HANDLE,
      ratePerShare: 0n,
      holderCount: 2n,
    });

    const result = await runYieldEpoch(input);

    const failureWrite = audit.updateStatus.mock.calls.find(
      (c: any[]) => c[0] === 0n && c[2] === 'failure',
    );
    expect(failureWrite).toBeTruthy();
    expect(failureWrite![3].errorClass).toBe('StrandedAuditEpoch');
    // Back-filled the REAL epoch 7 (no OrphanedAuditError throw, no fresh open).
    expect(audit.insertInProgress).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: 7n }),
    );
    expect(contractImpl.openEpoch).toBeUndefined();
    expect(contractImpl.fundEpoch).toHaveBeenCalledOnce();
    expect(result.status).toBe('resumed_success');
    expect(result.epochId).toBe(7n);
  });

  it('does NOT flag a valid on-chain epoch as stranded (normal resume proceeds)', async () => {
    // Default makeInput: epoch 5, getEpoch returns token=TOKEN_ADDR finalized
    // → a clean resume. The guard must leave it alone.
    const audit = makeAudit(auditRowFinalized());
    const input = makeInput({ cofheClient: makeCofheClient({ supply: 100n }), audit });

    const result = await runYieldEpoch(input);

    expect(result.status).toBe('resumed_success');
    const failureWrite = audit.updateStatus.mock.calls.find((c: any[]) => c[2] === 'failure');
    expect(failureWrite).toBeUndefined();
    // No fresh open — it resumed the existing epoch 5.
    expect(contractImpl.openEpoch).toBeUndefined();
  });
});
