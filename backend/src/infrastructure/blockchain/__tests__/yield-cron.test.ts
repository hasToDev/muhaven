import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

// vi.mock hoisting note: declared BEFORE any imports of the modules
// they replace so the cron resolves the stubbed runner. Vitest hoists
// vi.mock calls to the top of the file regardless of textual position,
// so even when the imports below appear first, the runner gets the
// stub.
vi.mock('../yield-epoch-runner.js', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    runYieldEpoch: vi.fn(),
  };
});

// Block real Postgres connect attempts inside acquireTokenLock /
// acquireTickLock. The cron passes a `pool` from `YieldCronDeps` but
// the lock helpers ALSO take a `Pool` arg — we mock the helpers
// directly so the test pool can be a stub without `connect()`.
vi.mock('../../repository/postgres/pg-advisory-lock-handle.js', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  const tickHandle = { release: vi.fn().mockResolvedValue(undefined) };
  const tokenHandles = new Map<string, { release: ReturnType<typeof vi.fn> }>();
  return {
    ...actual,
    acquireTickLock: vi.fn().mockResolvedValue(tickHandle),
    acquireTokenLock: vi.fn().mockImplementation((_pool: unknown, addr: string) => {
      const h = { release: vi.fn().mockResolvedValue(undefined) };
      tokenHandles.set(addr, h);
      return Promise.resolve(h);
    }),
    __testHandles: { tickHandle, tokenHandles },
  };
});

// Stub createNodeCofheClient so start() doesn't try to connect to a
// real Arb Sepolia RPC during tests. Tests bypass `start()` and
// inject `signer` + `cofheClient` directly via `(cron as any)` to
// avoid the chain-RPC dependency entirely.
vi.mock('../node-cofhe-client.js', () => ({
  createNodeCofheClient: vi.fn().mockResolvedValue({}),
}));

import { YieldDistributionCron } from '../yield-cron.js';
import { runYieldEpoch } from '../yield-epoch-runner.js';
import type { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';

const RUN_YIELD_EPOCH = vi.mocked(runYieldEpoch);

function makeToken(overrides: Partial<RwaToken> = {}): RwaToken {
  return {
    id: 'tk_usyc',
    address: '0xAbCdEf0000000000000000000000000000000001',
    name: 'USYC',
    symbol: 'USYC',
    issuerAddress: '0x1111111111111111111111111111111111111111',
    kycTier: 1,
    assetClass: 'treasury',
    status: 'active',
    yieldSnapshotAddress: '0x2222222222222222222222222222222222222222',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RwaToken;
}

function makeCron(deps?: {
  tickGuardRowCount?: number;
  bootAlertRowCount?: number;
  tokens?: RwaToken[];
  oracleSnapshot?: {
    snapshotAt: Date;
    apy7Day: string | null;
    navDollar: string | null;
  } | null;
  /** Sweep-start mhUSDC float balance (bigint) or `null` to simulate
   *  a read failure (cron skips entire sweep). Defaults to 1e12 — far
   *  above any per-token encTotalYield in the test envelope. */
  floatBalance?: bigint | null;
  /** Per-token max_supply_cap_override (bigint string), or null. */
  maxSupplyCapOverride?: string | null;
  dryRun?: boolean;
}) {
  const tickGuardRowCount = deps?.tickGuardRowCount ?? 1; // default: guard cleared
  const bootAlertRowCount = deps?.bootAlertRowCount ?? 0; // default: debounced
  const tokens = deps?.tokens ?? [makeToken()];
  const snapshotInput = deps?.oracleSnapshot;
  const snapshot =
    snapshotInput === undefined
      ? {
          snapshotAt: new Date(),
          apy7Day: '3.13',
          navDollar: '1.13',
        }
      : snapshotInput;

  // Drizzle stubs:
  //  - db.execute(sql`...`) → resolves to `{ rowCount }`. Cron uses it
  //    for the tick guard + heartbeat debounce updates.
  //  - db.insert(...).values([...]).onConflictDoNothing() → no-op.
  //  - db.select({...}).from(...).where(...).limit(...) → no override.
  let executeCallIdx = 0;
  const executeMock = vi.fn().mockImplementation(() => {
    // First execute call inside tick is the tick guard; the heartbeat
    // debounce fires from inside `maybeFireDailyHeartbeat` at the end
    // of a successful sweep. Tests pass exactly the counts they need
    // via the tickGuardRowCount / bootAlertRowCount switch (the
    // latter is the legacy field name; kept for back-compat with
    // existing tests — it now controls the heartbeat row's UPDATE
    // result).
    executeCallIdx++;
    return Promise.resolve({
      rowCount:
        executeCallIdx === 1 ? tickGuardRowCount : bootAlertRowCount,
    });
  });
  const insertOnConflictMock = vi.fn().mockResolvedValue(undefined);
  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: insertOnConflictMock,
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi
        .fn()
        .mockResolvedValue([{ override: deps?.maxSupplyCapOverride ?? null }]),
    }),
    execute: executeMock,
  };

  const rwaTokenRepo = {
    findByStatus: vi.fn().mockResolvedValue(tokens),
  } as any;
  const oracleRepo = {
    findLatestSnapshot: vi.fn().mockResolvedValue(snapshot),
  } as any;
  const notifyYieldCronFailure = {
    execute: vi.fn().mockResolvedValue(undefined),
  } as any;
  const pool = {} as any; // unused — pg-advisory-lock-handle is mocked

  const cron = new YieldDistributionCron(
    { pool, db: db as any, rwaTokenRepo, oracleRepo, notifyYieldCronFailure },
    {
      rpcUrl: 'http://stub',
      chainId: 421614,
      privateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
      defaultYieldSnapshotAddress: '0x2222222222222222222222222222222222222222',
      investorRegistryAddress: '0x3333333333333333333333333333333333333333',
      stableAddress: '0x4444444444444444444444444444444444444444',
      maxSupplyCap: 10_000_000n,
      staleNavHaltDays: 7,
      cronExpr: '0 0 * * *',
      dryRun: deps?.dryRun ?? false,
    },
  );
  // Bypass `start()` — inject signer + cofheClient stubs so the
  // null-guard at the top of `handleToken` passes + stub
  // `readMhUsdcFloat` so the sweep-start balance is deterministic.
  (cron as any).signer = { address: '0x1111111111111111111111111111111111111111' };
  (cron as any).cofheClient = {};
  // Use `!== undefined` so an explicit `floatBalance: null` (read-
  // failure simulation) doesn't get coalesced to the 1e12 default.
  const floatBalance =
    deps?.floatBalance !== undefined ? deps.floatBalance : 1_000_000_000_000n;
  (cron as any).readMhUsdcFloat = vi.fn().mockResolvedValue(floatBalance);

  return { cron, db, rwaTokenRepo, oracleRepo, notifyYieldCronFailure, executeMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('YieldDistributionCron.tick', () => {
  it('returns immediately when the cron_state 23h guard says already-fired', async () => {
    const { cron, rwaTokenRepo, notifyYieldCronFailure } = makeCron({ tickGuardRowCount: 0 });
    const result = await cron.tick();
    // toMatchObject (not toEqual) — the result also carries
    // `skipReasons: Record<...>` per the 2026-05-22 heartbeat work;
    // those buckets are tested separately below.
    expect(result).toMatchObject({ attempted: 0, succeeded: 0, skipped: 0, failed: 0 });
    expect(rwaTokenRepo.findByStatus).not.toHaveBeenCalled();
    expect(notifyYieldCronFailure.execute).not.toHaveBeenCalled();
  });

  it('iterates active tokens when the guard clears', async () => {
    const { cron, rwaTokenRepo } = makeCron();
    await cron.tick();
    expect(rwaTokenRepo.findByStatus).toHaveBeenCalledWith('active');
  });
});

describe('YieldDistributionCron.handleToken pre-flight skips', () => {
  it('skips silently when oracle has no snapshot (legacy synthetic tokens)', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({ oracleSnapshot: null });
    const result = await cron.tick();
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, skipped: 1, failed: 0 });
    // 2026-05-22 heartbeat: per-reason bucket carries the skip cause.
    expect(result.skipReasons.no_oracle_snapshot).toBe(1);
    expect(RUN_YIELD_EPOCH).not.toHaveBeenCalled();
    // No alert fired — silent skip for the "not in oracle catalog" case.
    expect(notifyYieldCronFailure.execute).not.toHaveBeenCalled();
  });

  it('skips silently when apy7Day is null (non-yield-bearing)', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({
      oracleSnapshot: { snapshotAt: new Date(), apy7Day: null, navDollar: '1.00' },
    });
    const result = await cron.tick();
    expect(result.skipped).toBe(1);
    expect(notifyYieldCronFailure.execute).not.toHaveBeenCalled();
  });

  it('fires WARN alert with tokenAddress when NAV is stale > halt threshold', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({
      oracleSnapshot: {
        snapshotAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        apy7Day: '3.13',
        navDollar: '1.13',
      },
    });
    await cron.tick();
    expect(notifyYieldCronFailure.execute).toHaveBeenCalledOnce();
    const call = notifyYieldCronFailure.execute.mock.calls[0][0];
    expect(call.tokenSymbol).toBe('USYC');
    expect(call.tokenAddress).toBe('0xabcdef0000000000000000000000000000000001');
    expect(call.severity).toBe('warn');
    expect(call.err.name).toBe('StaleNavError');
  });

  it('skips with a structured warn when apy×nav floors ratePerShare to 0', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({
      oracleSnapshot: {
        snapshotAt: new Date(),
        apy7Day: '0.00000000001', // sub-RATE_SCALE; floors to 0
        navDollar: '1.13',
      },
    });
    const result = await cron.tick();
    expect(result.skipped).toBe(1);
    // Log-only, no operator alert noise for zero-rate boundary.
    expect(notifyYieldCronFailure.execute).not.toHaveBeenCalled();
  });

  it('does NOT honour a max_supply_cap_override above the global cap (clamps to global)', async () => {
    // Round-1 Security M-1 (2026-05-21): override clamp. The schema
    // allows numeric(39,0) but the cron rejects values > YIELD_CRON_
    // MAX_SUPPLY_CAP (default 10M in this test). Override of 2^64 is
    // out of range → fall back to global (10M) → encTotalYield within
    // uint64 range → runner is called normally.
    RUN_YIELD_EPOCH.mockResolvedValueOnce({
      epochId: 1n,
      status: 'success',
      resumed: false,
    });
    const { cron } = makeCron({
      maxSupplyCapOverride: (2n ** 64n).toString(),
    });
    const result = await cron.tick();
    // Fallback to global → runner is called with effectiveCap=10M →
    // encTotalYield is well within uint64.max → no fail.
    expect(result.failed).toBe(0);
    expect(RUN_YIELD_EPOCH).toHaveBeenCalledOnce();
    const input = RUN_YIELD_EPOCH.mock.calls[0][0];
    // Verify the runner saw the global cap, NOT the absurd override.
    expect(input.effectiveMaxSupplyCap).toBe(10_000_000n);
  });

  it('does NOT honour a max_supply_cap_override of "0" (clamps to global)', async () => {
    // Round-1 Code-Reviewer H-4 (2026-05-21): the `'0'` string passes
    // truthy-check on naive `!v` parsing. Without the clamp, encTotal
    // Yield would be 0 + runner would fundEpoch with 0 yield (silent
    // claim under-pay). With the clamp, override < 1n falls back to
    // global.
    RUN_YIELD_EPOCH.mockResolvedValueOnce({
      epochId: 1n,
      status: 'success',
      resumed: false,
    });
    const { cron } = makeCron({ maxSupplyCapOverride: '0' });
    await cron.tick();
    expect(RUN_YIELD_EPOCH).toHaveBeenCalledOnce();
    expect(RUN_YIELD_EPOCH.mock.calls[0][0].effectiveMaxSupplyCap).toBe(10_000_000n);
  });

  it('fires ERROR alert when yield snapshot proxy is the zero address', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({
      tokens: [
        makeToken({
          yieldSnapshotAddress: undefined,
        } as Partial<RwaToken>),
      ],
    });
    // Override default snapshot fallback to zero
    (cron as any).config.defaultYieldSnapshotAddress = '0x0000000000000000000000000000000000000000';
    const result = await cron.tick();
    expect(result.failed).toBe(1);
    const call = notifyYieldCronFailure.execute.mock.calls[0][0];
    expect(call.err.name).toBe('MissingYieldSnapshotAddressError');
    expect(call.tokenAddress).toBe('0xabcdef0000000000000000000000000000000001');
  });
});

describe('YieldDistributionCron alert tokenAddress invariant (I-4)', () => {
  it('every notifyYieldCronFailure call from pre-flight passes tokenAddress', async () => {
    // Stress test: trigger multiple alert paths in one tick by running
    // 3 tokens with each kind of failure.
    const { cron, notifyYieldCronFailure, oracleRepo } = makeCron({
      tokens: [
        makeToken({ address: '0xaaaa000000000000000000000000000000000001', symbol: 'A1' }),
        makeToken({ address: '0xbbbb000000000000000000000000000000000002', symbol: 'B2' }),
        makeToken({ address: '0xCcCc000000000000000000000000000000000003', symbol: 'C3' }),
      ],
    });
    let snapshotCallIdx = 0;
    oracleRepo.findLatestSnapshot = vi.fn().mockImplementation(() => {
      snapshotCallIdx++;
      if (snapshotCallIdx === 1) {
        // A1 → stale NAV (10d) → alert
        return Promise.resolve({
          snapshotAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          apy7Day: '3.13',
          navDollar: '1.13',
        });
      }
      if (snapshotCallIdx === 2) {
        // B2 → no snapshot → silent skip (no alert)
        return Promise.resolve(null);
      }
      // C3 → fresh + valid (would go to mhUSDC float pre-flight)
      return Promise.resolve({
        snapshotAt: new Date(),
        apy7Day: '3.13',
        navDollar: '1.13',
      });
    });
    await cron.tick();
    // At least the stale-NAV alert fired; assert tokenAddress is lower-cased
    // on every call (Round-2 Security M-4 invariant).
    for (const call of notifyYieldCronFailure.execute.mock.calls) {
      const payload = call[0];
      // Sentinel-symbol alerts (heartbeat / float-read sweep failure)
      // carry the SIGNER address (not a token address) — they're
      // tracked via the tokenAddress allowlist path but for a non-
      // token entity. Skip the strict 0x-lowercase regex; their own
      // tests cover the payload-shape invariant.
      if (payload.tokenSymbol === 'YIELD_CRON_HEARTBEAT') continue;
      if (payload.tokenSymbol === 'YIELD_CRON_FLOAT_READ') continue;
      expect(payload).toHaveProperty('tokenAddress');
      expect(payload.tokenAddress).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });
});

describe('YieldDistributionCron multi-token float ledger (Sec M-4)', () => {
  it('decrements floatRemaining after each successful runYieldEpoch', async () => {
    // Three tokens, each consuming 100 mhUSDC of float. Starting
    // balance 250 → token 1 + 2 succeed, token 3 hits float-short.
    const tokens = [
      makeToken({ address: '0xaaaa000000000000000000000000000000000001', symbol: 'A1' }),
      makeToken({ address: '0xbbbb000000000000000000000000000000000002', symbol: 'B2' }),
      makeToken({ address: '0xcccc000000000000000000000000000000000003', symbol: 'C3' }),
    ];
    // Build a config where one token's encTotalYield = 100. Using
    // apy=3.13% and nav=$1.13 the cap math is:
    //   ratePerShare = 96_901_369
    //   encTotalYield = 10_000_000 × 96_901_369 / 1_000_000 = 969_013_690
    // So to land at "3 tokens × 100 each fits in 250" we lower the
    // global cap accordingly. Use maxSupplyCap such that encTotalYield
    // = 1n per token. apyScaled × navUsd6 / 365 / RATE_SCALE × cap:
    //   95 ≈ ratePerShare for the default inputs; cap=10 gives encTY=0
    // Easier path: stub readMhUsdcFloat to a small value AND override
    // the per-token override to MIN viable cap of 1.
    const { cron, notifyYieldCronFailure } = makeCron({
      tokens,
      floatBalance: 250n,  // exactly 2 tokens worth (each 100n encTotalYield)
    });
    // Force encTotalYield = 100 per token by stubbing the override
    // path to return values that make the cap math land at 100.
    // Math: encTotalYield = cap × ratePerShare / RATE_SCALE
    //   ratePerShare = 31_300 × 1_130_000 / 365 ≈ 96_901_369
    //   So cap = 100 × RATE_SCALE / 96_901_369 = ~1.03
    // Rounding to integer 1n yields encTotalYield = 96n (≈100), close
    // enough for the float-ledger boundary to bite at token 3.
    (cron as any).deps.db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ override: '1' }]),
    });
    RUN_YIELD_EPOCH.mockResolvedValue({
      epochId: 1n,
      status: 'success',
      resumed: false,
    });
    const result = await cron.tick();
    // 2 tokens funded, 1 skipped on float-short
    expect(result.succeeded).toBe(2);
    expect(result.skipped).toBe(1);
    expect(RUN_YIELD_EPOCH).toHaveBeenCalledTimes(2);
    // The 3rd token's skip emits an InsufficientMhusdcFloatError alert.
    const floatAlerts = notifyYieldCronFailure.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as { err: Error }).err.name === 'InsufficientMhusdcFloatError',
    );
    expect(floatAlerts.length).toBe(1);
    expect(floatAlerts[0][0].tokenAddress).toBe('0xcccc000000000000000000000000000000000003');
    expect(floatAlerts[0][0].severity).toBe('warn');
  });

  it('skips the entire sweep when sweep-start float read returns null', async () => {
    const { cron, notifyYieldCronFailure } = makeCron({
      tokens: [makeToken(), makeToken({ address: '0xeeee000000000000000000000000000000000002', symbol: 'E2' })],
      floatBalance: null, // simulate decrypt failure
    });
    const result = await cron.tick();
    // No tokens attempted (sweep aborted before per-token loop)
    expect(result.attempted).toBe(0);
    expect(RUN_YIELD_EPOCH).not.toHaveBeenCalled();
  });

  it('does NOT read float in dry-run mode (no decrypt cost when no fundEpoch)', async () => {
    const { cron } = makeCron({ dryRun: true });
    const readFloatSpy = (cron as any).readMhUsdcFloat;
    RUN_YIELD_EPOCH.mockResolvedValueOnce({
      epochId: 0n,
      status: 'skipped',
      skipReason: 'dry_run',
      resumed: false,
    });
    await cron.tick();
    expect(readFloatSpy).not.toHaveBeenCalled();
  });
});

describe('YieldDistributionCron resumed_success float-ledger (Reality B-1)', () => {
  it('does NOT decrement floatRemaining when runner returns resumed_success', async () => {
    // Two tokens, sweep-start float 200. Token 1 returns
    // resumed_success (prior-tick fund, balance already drained on
    // chain → sweep-start already excludes it). Decrementing again
    // would double-count + cause token 2 to spuriously skip.
    //
    // After the B-1 fix: token 1's resumed_success does NOT consume.
    // Token 2's pre-flight sees the full 200 still available → if
    // its encTotalYield <= 200, it succeeds.
    const { cron, notifyYieldCronFailure } = makeCron({
      tokens: [
        makeToken({ address: '0xaaaa000000000000000000000000000000000001', symbol: 'A1' }),
        makeToken({ address: '0xbbbb000000000000000000000000000000000002', symbol: 'B2' }),
      ],
      floatBalance: 200n,
      maxSupplyCapOverride: '1', // small encTotalYield ≈ 96 per token
    });
    RUN_YIELD_EPOCH
      .mockResolvedValueOnce({ epochId: 1n, status: 'resumed_success', resumed: true })
      .mockResolvedValueOnce({ epochId: 2n, status: 'success', resumed: false });
    const result = await cron.tick();
    // Both tokens succeed; no spurious InsufficientMhusdcFloatError
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    const floatAlerts = notifyYieldCronFailure.execute.mock.calls.filter(
      (c: unknown[]) => (c[0] as { err: Error }).err.name === 'InsufficientMhusdcFloatError',
    );
    expect(floatAlerts.length).toBe(0);
  });
});

describe('YieldDistributionCron unexpected runner status (Reality H-1)', () => {
  it('treats partial as failed loud (not silent success)', async () => {
    const { cron } = makeCron();
    // Runner type union includes 'partial' but no return site emits
    // it today. Defensive: if a future runner edit emits it, treat
    // as failure (counter + log loud) rather than silently bucketing
    // as success.
    RUN_YIELD_EPOCH.mockResolvedValueOnce({
      epochId: 1n,
      status: 'partial' as any,
      resumed: false,
    });
    const result = await cron.tick();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });
});

describe('YieldDistributionCron runner-throw catch path (I-4)', () => {
  it('fires ERROR alert with tokenAddress when runYieldEpoch throws', async () => {
    const { cron, notifyYieldCronFailure } = makeCron();
    RUN_YIELD_EPOCH.mockRejectedValueOnce(
      new Error('synthetic runner failure — simulating mid-pipeline crash'),
    );
    const result = await cron.tick();
    expect(result.failed).toBe(1);
    expect(notifyYieldCronFailure.execute).toHaveBeenCalledOnce();
    const call = notifyYieldCronFailure.execute.mock.calls[0][0];
    expect(call.tokenAddress).toBe('0xabcdef0000000000000000000000000000000001');
    expect(call.tokenSymbol).toBe('USYC');
    expect(call.severity).toBe('error');
  });
});

describe('YieldDistributionCron handleToken null-guard (Arch H-2)', () => {
  it('returns failed when cofheClient/signer are not initialised', async () => {
    const { cron } = makeCron();
    // Drop the injected clients to simulate handleToken being called
    // before start() initialised them. The null-guard at handleToken
    // entry must surface the misuse loud rather than throw deep.
    (cron as any).signer = null;
    (cron as any).cofheClient = null;
    const result = await cron.tick();
    expect(result.failed).toBe(1);
    expect(RUN_YIELD_EPOCH).not.toHaveBeenCalled();
  });
});

// ── composeHeartbeatBody (2026-05-22 daily heartbeat) ────────────────
//
// Pure-function tests — no cron / mocks needed. The function renders
// the Telegram-visible heartbeat body from a tick result, including
// dry-run state suffix + only-non-zero skip bucket enumeration.

import {
  composeHeartbeatBody,
  type YieldCronTickResult,
} from '../yield-cron.js';

function tickResult(
  overrides: Partial<YieldCronTickResult> = {},
): YieldCronTickResult {
  const skipReasons = {
    no_holders: 0,
    missing_nav: 0,
    stale_nav: 0,
    no_oracle_snapshot: 0,
    lock_busy: 0,
    parse_error: 0,
    zero_yield: 0,
    pending_fund: 0,
    float_short: 0,
    dry_run: 0,
    other: 0,
  };
  return {
    attempted: 11,
    succeeded: 0,
    skipped: 11,
    failed: 0,
    skipReasons,
    ...overrides,
  };
}

describe('composeHeartbeatBody', () => {
  it('renders the today-shaped summary for the prod no_holders + missing_nav split', () => {
    const result = tickResult({
      skipReasons: {
        ...tickResult().skipReasons,
        no_holders: 7,
        missing_nav: 4,
      },
    });
    const body = composeHeartbeatBody(result, true);
    expect(body).toMatch(/^yield-distribution OK \d{4}-\d{2}-\d{2} \(DRY-RUN\): /);
    expect(body).toContain('11 swept');
    expect(body).toContain('7 no_holders');
    expect(body).toContain('4 missing_nav');
    expect(body).toContain('0 distributed');
    // failed=0 → 'failed' bucket NOT emitted (cleaner body).
    expect(body).not.toContain('failed');
  });

  it('drops the (DRY-RUN) suffix when dryRun=false', () => {
    const body = composeHeartbeatBody(tickResult({ succeeded: 1, skipped: 10 }), false);
    expect(body).toMatch(/^yield-distribution OK \d{4}-\d{2}-\d{2}: /);
    expect(body).not.toContain('DRY-RUN');
  });

  it('emits "no active tokens" for attempted=0 ticks', () => {
    const result = tickResult({ attempted: 0, succeeded: 0, skipped: 0 });
    const body = composeHeartbeatBody(result, false);
    expect(body).toContain('no active tokens');
    expect(body).not.toContain('swept');
  });

  it('includes "failed" only when result.failed > 0', () => {
    const withFailures = composeHeartbeatBody(
      tickResult({ succeeded: 8, skipped: 0, failed: 3 }),
      false,
    );
    expect(withFailures).toContain('3 failed');
    const cleanSweep = composeHeartbeatBody(
      tickResult({ succeeded: 11, skipped: 0, failed: 0 }),
      false,
    );
    expect(cleanSweep).not.toContain('failed');
  });

  it('omits zero-count skip-reason buckets (visual noise reduction)', () => {
    const body = composeHeartbeatBody(
      tickResult({
        attempted: 11,
        skipped: 11,
        skipReasons: { ...tickResult().skipReasons, no_holders: 11 },
      }),
      true,
    );
    // Only no_holders shows up; other 8 reasons stay invisible.
    expect(body).toContain('11 no_holders');
    expect(body).not.toContain('0 missing_nav');
    expect(body).not.toContain('0 stale_nav');
  });

  it('emits all non-zero buckets in deterministic order', () => {
    const body = composeHeartbeatBody(
      tickResult({
        attempted: 5,
        skipped: 5,
        skipReasons: {
          ...tickResult().skipReasons,
          parse_error: 1,
          no_holders: 2,
          stale_nav: 1,
          missing_nav: 1,
        },
      }),
      false,
    );
    // Order matches ALL_SKIP_REASONS declaration:
    //   no_holders, missing_nav, stale_nav, no_oracle_snapshot,
    //   lock_busy, parse_error, float_short, dry_run, other
    const noHoldersIdx = body.indexOf('2 no_holders');
    const missingNavIdx = body.indexOf('1 missing_nav');
    const staleNavIdx = body.indexOf('1 stale_nav');
    const parseErrorIdx = body.indexOf('1 parse_error');
    expect(noHoldersIdx).toBeLessThan(missingNavIdx);
    expect(missingNavIdx).toBeLessThan(staleNavIdx);
    expect(staleNavIdx).toBeLessThan(parseErrorIdx);
  });

  it('fits under the 1024-char sanitiser body cap even at saturated bucket counts', () => {
    // Worst case: every bucket non-zero at 4-digit count. The body
    // length should stay well under 1024 (the
    // `OperatorAlertPayloadSchema.shortMessage.max(1024)` cap).
    const body = composeHeartbeatBody(
      tickResult({
        attempted: 9999,
        succeeded: 9999,
        skipped: 9999,
        failed: 9999,
        skipReasons: {
          no_holders: 1234,
          missing_nav: 1234,
          stale_nav: 1234,
          no_oracle_snapshot: 1234,
          lock_busy: 1234,
          parse_error: 1234,
          zero_yield: 1234,
          pending_fund: 1234,
          float_short: 1234,
          dry_run: 1234,
          other: 1234,
        },
      }),
      true,
    );
    expect(body.length).toBeLessThan(1024);
  });
});

// ── Heartbeat integration (Round-1 CR M-3, 2026-05-22) ───────────────
//
// Pure-function tests above pin composeHeartbeatBody. These tests
// verify the wiring: tick() → debounce eligibility check → notify
// call with YIELD_CRON_HEARTBEAT sentinel + severity:'info' +
// tokenAddress. Pre-2026-05-22 this surface was untested end-to-end,
// which would have let a regression silently break the operator's
// only liveness signal post-dry-run-flip.

describe('YieldDistributionCron daily heartbeat integration', () => {
  it('fires notify with YIELD_CRON_HEARTBEAT + info severity + signer address when debounce clears', async () => {
    // bootAlertRowCount: 1 → the eligibility-check SELECT returns
    // `eligible: true`; the heartbeat path proceeds. The actual
    // SELECT shape is `{eligible: boolean}` from the post-H-1-fix
    // helper, but the test stub returns `{ rowCount: N }`. The cron
    // reads `rows?.[0]?.eligible === true` so we need to inject a
    // proper row. See helper override below.
    const { cron, notifyYieldCronFailure, db } = makeCron({});
    // Override execute to return the right shape for both the tick
    // guard (RETURNING 1) AND the heartbeat eligibility SELECT.
    let callIdx = 0;
    db.execute = vi.fn().mockImplementation(() => {
      callIdx++;
      // First call = tick guard UPDATE; row count 1.
      if (callIdx === 1) return Promise.resolve({ rowCount: 1, rows: [] });
      // Second call = heartbeat eligibility SELECT; returns one row.
      if (callIdx === 2)
        return Promise.resolve({ rowCount: 1, rows: [{ eligible: true }] });
      // Third call = heartbeat advance UPDATE; row count 1.
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await cron.tick();
    const heartbeats = notifyYieldCronFailure.execute.mock.calls.filter(
      (c: Array<{ tokenSymbol: string }>) => c[0].tokenSymbol === 'YIELD_CRON_HEARTBEAT',
    );
    expect(heartbeats).toHaveLength(1);
    const payload = heartbeats[0]![0];
    expect(payload.severity).toBe('info');
    expect(payload.tokenAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(payload.err.name).toBe('YieldCronHeartbeat');
    expect(payload.err.message).toContain('yield-distribution OK');
  });

  it('skips notify when debounce check returns not-eligible', async () => {
    const { cron, notifyYieldCronFailure, db } = makeCron({});
    let callIdx = 0;
    db.execute = vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({ rowCount: 1, rows: [] });
      // Eligibility SELECT returns row with eligible=false → no notify.
      if (callIdx === 2)
        return Promise.resolve({ rowCount: 1, rows: [{ eligible: false }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    await cron.tick();
    const heartbeats = notifyYieldCronFailure.execute.mock.calls.filter(
      (c: Array<{ tokenSymbol: string }>) => c[0].tokenSymbol === 'YIELD_CRON_HEARTBEAT',
    );
    expect(heartbeats).toHaveLength(0);
  });

  it('does NOT advance debounce row when notify throws (H-1 ordering fix)', async () => {
    const { cron, notifyYieldCronFailure, db } = makeCron({});
    let callIdx = 0;
    let advanceCalled = false;
    db.execute = vi.fn().mockImplementation((stmt: unknown) => {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({ rowCount: 1, rows: [] });
      if (callIdx === 2)
        return Promise.resolve({ rowCount: 1, rows: [{ eligible: true }] });
      // Any later execute = the advance UPDATE. Track it.
      advanceCalled = true;
      void stmt;
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    // Force notify to throw — simulates Telegram transport outage.
    notifyYieldCronFailure.execute = vi
      .fn()
      .mockImplementation(async (p: { tokenSymbol: string }) => {
        if (p.tokenSymbol === 'YIELD_CRON_HEARTBEAT') {
          throw new Error('simulated transport outage');
        }
      });
    await cron.tick();
    // Per H-1 (Backend-Architect 2026-05-22): on notify throw, the
    // advance UPDATE MUST NOT run — so the next tick retries.
    expect(advanceCalled).toBe(false);
  });
});

// ── bucketRunnerSkipReason mapping (Round-1 CR M-4 + CR H-1, 2026-05-22) ──
//
// The runner emits skipReason strings from a 4-value union; the cron
// buckets them into operator-facing labels. Pre-2026-05-22 only
// 'dry_run' and 'no_holders' were mapped; the H-1 fix adds
// 'insufficient_mhusdc_float' → 'float_short' and 'orphaned_audit'
// → 'pending_fund'.

describe('YieldDistributionCron runner skip-reason bucketing', () => {
  const runnerSkipCases: Array<{
    runnerReason: string;
    expectedBucket: keyof YieldCronTickResult['skipReasons'];
  }> = [
    { runnerReason: 'no_holders', expectedBucket: 'no_holders' },
    { runnerReason: 'dry_run', expectedBucket: 'dry_run' },
    { runnerReason: 'insufficient_mhusdc_float', expectedBucket: 'float_short' },
    { runnerReason: 'orphaned_audit', expectedBucket: 'pending_fund' },
    { runnerReason: 'something_new', expectedBucket: 'other' },
  ];
  for (const { runnerReason, expectedBucket } of runnerSkipCases) {
    it(`maps runner skipReason '${runnerReason}' to bucket '${expectedBucket}'`, async () => {
      const { cron } = makeCron();
      RUN_YIELD_EPOCH.mockResolvedValueOnce({
        epochId: 0n,
        status: 'skipped',
        skipReason: runnerReason,
      } as any);
      const result = await cron.tick();
      expect(result.skipped).toBe(1);
      expect(result.skipReasons[expectedBucket]).toBe(1);
    });
  }
});
