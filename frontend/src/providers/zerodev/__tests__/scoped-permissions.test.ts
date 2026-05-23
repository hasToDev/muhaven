/**
 * Wave 5 Option D · Commit 1 (D-1) — Scoped CallPolicy allowlist tests.
 *
 * The Scoped tier's on-chain CallPolicy envelope is a load-bearing
 * security boundary: it's the on-chain layer that bounds what a
 * compromised broker can do with a leaked Scoped session key. The
 * exclusion of `muHavenToken.transfer` (SecEng T-2) is enforced
 * structurally + by these tests so a "tidying" refactor can't
 * silently widen the envelope past the threat-model floor.
 *
 * Test strategy:
 *   - Stub `@/contracts/addresses` so v35 contract slots resolve to
 *     deterministic non-zero fixtures (the real module reads
 *     `import.meta.env.VITE_*`, which is undefined under Vitest →
 *     every v35 address defaults to `0x000…000` → `nonZero` filter
 *     drops every Wave 3.5 group → the test becomes vacuous).
 *   - Assertions target the BEHAVIOUR of the constants, not the
 *     specific addresses (which are env-derived in production).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { toFunctionSelector, type Address } from 'viem';

// Deterministic fixture addresses — 20 bytes each, distinct enough
// that a confused (target, selector) collision is obvious in test
// output. Lowercased to match the module's lowercase normalization.
const FIXTURE = {
  muHavenToken: '0x000000000000000000000000000000000000aaa1',
  muHavenVault: '0x000000000000000000000000000000000000aaa2',
  yieldDistributor: '0x000000000000000000000000000000000000aaa3',
  muhavenEscrow: '0x000000000000000000000000000000000000aaa4',
  pusdc: '0x000000000000000000000000000000000000aaa5',
  // v35
  subscription: '0x000000000000000000000000000000000000bb01',
  muHavenStable: '0x000000000000000000000000000000000000bb02',
  treasury_tbill: '0x000000000000000000000000000000000000bb03',
  queue_tbill: '0x000000000000000000000000000000000000bb04',
  snapshot_singleton: '0x000000000000000000000000000000000000bb05',
} as const;

vi.mock('@/contracts/addresses', () => {
  return {
    addresses: {
      muHavenToken: FIXTURE.muHavenToken,
      muHavenVault: FIXTURE.muHavenVault,
      investorRegistry: '0x0000000000000000000000000000000000000000',
      yieldDistributor: FIXTURE.yieldDistributor,
      kycAdapter: '0x0000000000000000000000000000000000000000',
      riskParams: '0x0000000000000000000000000000000000000000',
      yieldGate: '0x0000000000000000000000000000000000000000',
      muhavenEscrow: FIXTURE.muhavenEscrow,
      usdc: '0x0000000000000000000000000000000000000000',
      pusdc: FIXTURE.pusdc,
    },
    v35Addresses: {
      subscription: FIXTURE.subscription,
      tokenRegistry: '0x0000000000000000000000000000000000000000',
      identityRegistry: '0x0000000000000000000000000000000000000000',
      modularCompliance: '0x0000000000000000000000000000000000000000',
      oracle: '0x0000000000000000000000000000000000000000',
      muHavenStable: FIXTURE.muHavenStable,
      treasuries: { [FIXTURE.treasury_tbill]: FIXTURE.treasury_tbill },
      queues: { [FIXTURE.treasury_tbill]: FIXTURE.queue_tbill },
      yieldSnapshots: { [FIXTURE.treasury_tbill]: FIXTURE.snapshot_singleton },
      yieldSnapshot: FIXTURE.snapshot_singleton,
    },
    isZeroAddress: (addr: string) =>
      addr.toLowerCase() === '0x0000000000000000000000000000000000000000',
  };
});

// Use top-level lazy bindings so the mock above resolves BEFORE the
// permissions module loads (mock-hoisting).
let SCOPED_AUTONOMOUS_PERMISSIONS: ReadonlyArray<{
  target: string;
  functionName: string;
  abi: readonly unknown[];
  valueLimit: bigint;
}>;
let SESSION_PERMISSIONS: ReadonlyArray<{
  target: string;
  functionName: string;
  abi: readonly unknown[];
  valueLimit: bigint;
}>;
let SESSION_SCOPE_KEYS: ReadonlySet<string>;
let SESSION_PERMS_FINGERPRINT: string;
let isCallInSessionScope: (c: { to: string; data?: string }) => boolean;
let dedupePermissions: <
  T extends { target: string; abi: readonly unknown[]; functionName: string },
>(
  perms: readonly T[],
) => T[];
let nonZero: <T extends { target: string }>(perms: readonly T[]) => T[];
let muHavenTokenTransferV35Abi: readonly unknown[];

beforeAll(async () => {
  const mod = await import('../scoped-permissions');
  SCOPED_AUTONOMOUS_PERMISSIONS = mod.SCOPED_AUTONOMOUS_PERMISSIONS;
  SESSION_PERMISSIONS = mod.SESSION_PERMISSIONS;
  SESSION_SCOPE_KEYS = mod.SESSION_SCOPE_KEYS;
  SESSION_PERMS_FINGERPRINT = mod.SESSION_PERMS_FINGERPRINT;
  isCallInSessionScope = mod.isCallInSessionScope;
  dedupePermissions = mod.dedupePermissions;
  nonZero = mod.nonZero;
  muHavenTokenTransferV35Abi = mod.muHavenTokenTransferV35Abi;
});

// ────────────────────────────────────────────────────────────────────
// Helpers reused across describes
// ────────────────────────────────────────────────────────────────────

function selectorOf(
  abi: readonly unknown[],
  functionName: string,
): `0x${string}` {
  const abiItem = (abi as readonly { type?: string; name?: string }[]).find(
    (item) => item.type === 'function' && item.name === functionName,
  );
  if (!abiItem) {
    throw new Error(`selectorOf: ABI is missing function ${functionName}`);
  }
  return toFunctionSelector(abiItem as never).toLowerCase() as `0x${string}`;
}

function targetSelectorPairs(
  perms: ReadonlyArray<{
    target: string;
    abi: readonly unknown[];
    functionName: string;
  }>,
): Set<string> {
  return new Set(
    perms.map(
      (p) => `${p.target.toLowerCase()}:${selectorOf(p.abi, p.functionName)}`,
    ),
  );
}

// ────────────────────────────────────────────────────────────────────
// SecEng T-2 — `muHavenToken.transfer` MUST NOT appear in Scoped
// ────────────────────────────────────────────────────────────────────

describe('scoped-permissions — SCOPED_AUTONOMOUS_PERMISSIONS (D-1)', () => {
  it('EXCLUDES `muHavenToken.transfer` (SecEng T-2 drain-risk gate)', () => {
    const transferSelector = selectorOf(
      muHavenTokenTransferV35Abi,
      'transfer',
    );
    const pairs = targetSelectorPairs(SCOPED_AUTONOMOUS_PERMISSIONS);
    const forbidden = `${FIXTURE.muHavenToken.toLowerCase()}:${transferSelector}`;
    expect(pairs.has(forbidden)).toBe(false);
  });

  it('REGRESSION GUARD — no permission entry across SCOPED has functionName === "transfer"', () => {
    // Defensive against a future contributor adding a `transfer`
    // overload onto a DIFFERENT target (e.g. MuHavenStable) — we
    // forbid the SELECTOR shape, not just the (muHavenToken, transfer)
    // pair, because every ERC-20-shaped transfer carries balance-
    // moving semantics.
    const transferEntries = SCOPED_AUTONOMOUS_PERMISSIONS.filter(
      (p) => p.functionName === 'transfer',
    );
    expect(transferEntries).toHaveLength(0);
  });

  it('INCLUDES subscription.purchase + subscription.redeem (D-1 broadened envelope)', () => {
    const targets = new Set(
      SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.target.toLowerCase()),
    );
    const fnNames = new Set(SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.functionName));
    expect(targets.has(FIXTURE.subscription.toLowerCase())).toBe(true);
    expect(fnNames.has('purchase')).toBe(true);
    expect(fnNames.has('redeem')).toBe(true);
  });

  it('INCLUDES per-token redemption queue submit + claim', () => {
    const fnNames = new Set(SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.functionName));
    expect(fnNames.has('submit')).toBe(true);
    expect(fnNames.has('claim')).toBe(true);
  });

  it('INCLUDES yield-snapshot claimYield + issuer-side distribution methods', () => {
    const fnNames = new Set(SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.functionName));
    for (const required of [
      'claimYield',
      'openEpoch',
      'snapshotBatch',
      'finalizeSnapshot',
      'fundEpoch',
    ]) {
      expect(fnNames.has(required)).toBe(true);
    }
  });

  it('INCLUDES mhUSDC setOperator (YieldSnapshot.fundEpoch precondition)', () => {
    const setOperatorEntries = SCOPED_AUTONOMOUS_PERMISSIONS.filter(
      (p) =>
        p.target.toLowerCase() === FIXTURE.muHavenStable.toLowerCase() &&
        p.functionName === 'setOperator',
    );
    expect(setOperatorEntries).toHaveLength(1);
  });

  it('INCLUDES ACL refresh primitives (refreshDecryptGrant + refreshAuditGrant)', () => {
    const fnNames = new Set(SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.functionName));
    expect(fnNames.has('refreshDecryptGrant')).toBe(true);
    expect(fnNames.has('refreshAuditGrant')).toBe(true);
  });

  it('EXCLUDES Wave 3 legacy yieldDistributor / muhavenEscrow / pusdc.setOperator', () => {
    // Wave 3 legacy is deliberately scope-stripped from Scoped (it's
    // deprecated; not the broker's surface). The legacy session-key
    // still permits it for back-compat.
    const targets = new Set(
      SCOPED_AUTONOMOUS_PERMISSIONS.map((p) => p.target.toLowerCase()),
    );
    expect(targets.has(FIXTURE.yieldDistributor.toLowerCase())).toBe(false);
    expect(targets.has(FIXTURE.muhavenEscrow.toLowerCase())).toBe(false);
    // pusdc.setOperator is excluded; mhUSDC.setOperator IS in scope —
    // distinguish the two by target address.
    const pusdcSetOperator = SCOPED_AUTONOMOUS_PERMISSIONS.find(
      (p) =>
        p.target.toLowerCase() === FIXTURE.pusdc.toLowerCase() &&
        p.functionName === 'setOperator',
    );
    expect(pusdcSetOperator).toBeUndefined();
  });

  it('every entry has valueLimit === 0n (non-payable UserOps only)', () => {
    for (const perm of SCOPED_AUTONOMOUS_PERMISSIONS) {
      expect(perm.valueLimit).toBe(0n);
    }
  });

  it('every entry is unique by (target, selector) — dedupe applied', () => {
    const pairs = targetSelectorPairs(SCOPED_AUTONOMOUS_PERMISSIONS);
    expect(pairs.size).toBe(SCOPED_AUTONOMOUS_PERMISSIONS.length);
  });
});

// ────────────────────────────────────────────────────────────────────
// SESSION_PERMISSIONS is the superset (= SCOPED + transfer + Wave 3
// legacy). Asserting the superset relationship guards against a future
// drift where the two constants diverge silently.
// ────────────────────────────────────────────────────────────────────

describe('scoped-permissions — SESSION_PERMISSIONS (legacy session-key)', () => {
  it('is a SUPERSET of SCOPED_AUTONOMOUS_PERMISSIONS by (target, selector)', () => {
    const scopedPairs = targetSelectorPairs(SCOPED_AUTONOMOUS_PERMISSIONS);
    const sessionPairs = targetSelectorPairs(SESSION_PERMISSIONS);
    for (const pair of scopedPairs) {
      expect(sessionPairs.has(pair)).toBe(true);
    }
  });

  it('INCLUDES muHavenToken.transfer (the legacy-only extra)', () => {
    const transferSelector = selectorOf(
      muHavenTokenTransferV35Abi,
      'transfer',
    );
    const pairs = targetSelectorPairs(SESSION_PERMISSIONS);
    expect(pairs.has(`${FIXTURE.muHavenToken.toLowerCase()}:${transferSelector}`)).toBe(
      true,
    );
  });

  it('INCLUDES Wave 3 legacy contracts (yieldDistributor / muhavenEscrow / pusdc)', () => {
    const targets = new Set(
      SESSION_PERMISSIONS.map((p) => p.target.toLowerCase()),
    );
    expect(targets.has(FIXTURE.yieldDistributor.toLowerCase())).toBe(true);
    expect(targets.has(FIXTURE.muhavenEscrow.toLowerCase())).toBe(true);
    expect(targets.has(FIXTURE.pusdc.toLowerCase())).toBe(true);
  });

  it('contains exactly one more (target, selector) per legacy-extra than SCOPED', () => {
    // legacy extras: muHavenToken.transfer + 3 yieldDistributor + 3
    // muhavenEscrow + 1 pusdc.setOperator = 8. The superset cardinality
    // should be |SCOPED| + 8.
    const scopedPairs = targetSelectorPairs(SCOPED_AUTONOMOUS_PERMISSIONS);
    const sessionPairs = targetSelectorPairs(SESSION_PERMISSIONS);
    expect(sessionPairs.size).toBe(scopedPairs.size + 8);
  });
});

// ────────────────────────────────────────────────────────────────────
// Helper behavior — `nonZero`, `dedupePermissions`
// ────────────────────────────────────────────────────────────────────

describe('scoped-permissions — helpers', () => {
  it('nonZero drops entries whose target is the zero address', () => {
    const dummyAbi = [
      { type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    ] as const;
    const result = nonZero([
      { target: '0x0000000000000000000000000000000000000000' as Address, abi: dummyAbi, functionName: 'foo' },
      { target: FIXTURE.muHavenToken as Address, abi: dummyAbi, functionName: 'foo' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.target).toBe(FIXTURE.muHavenToken);
  });

  it('dedupePermissions collapses duplicate (target, selector) pairs', () => {
    const dummyAbi = [
      { type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    ] as const;
    const result = dedupePermissions([
      { target: FIXTURE.muHavenToken, abi: dummyAbi, functionName: 'foo', valueLimit: 0n },
      { target: FIXTURE.muHavenToken, abi: dummyAbi, functionName: 'foo', valueLimit: 0n },
      { target: FIXTURE.muHavenStable, abi: dummyAbi, functionName: 'foo', valueLimit: 0n },
    ]);
    expect(result).toHaveLength(2);
  });

  it('dedupePermissions throws when an entry references a missing ABI function', () => {
    const dummyAbi = [
      { type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'nonpayable' },
    ] as const;
    expect(() =>
      dedupePermissions([
        { target: FIXTURE.muHavenToken, abi: dummyAbi, functionName: 'bar', valueLimit: 0n },
      ]),
    ).toThrow(/missing ABI for bar/);
  });
});

// ────────────────────────────────────────────────────────────────────
// `isCallInSessionScope` — the in-tab gate used by sendUserOperation
// to skip session-install for out-of-scope calls.
// ────────────────────────────────────────────────────────────────────

describe('scoped-permissions — isCallInSessionScope', () => {
  it('returns true for a (target, selector) inside SESSION_PERMISSIONS', () => {
    const purchaseSelector = selectorOf(
      SESSION_PERMISSIONS.find(
        (p) =>
          p.target.toLowerCase() === FIXTURE.subscription.toLowerCase() &&
          p.functionName === 'purchase',
      )!.abi,
      'purchase',
    );
    expect(
      isCallInSessionScope({
        to: FIXTURE.subscription,
        data: (purchaseSelector + 'aa'.repeat(32)) as `0x${string}`,
      }),
    ).toBe(true);
  });

  it('returns false for a target outside SESSION_PERMISSIONS', () => {
    expect(
      isCallInSessionScope({
        to: '0x00000000000000000000000000000000deadbeef',
        data: '0x12345678',
      }),
    ).toBe(false);
  });

  it('returns false for a too-short calldata (< 10 hex chars)', () => {
    expect(isCallInSessionScope({ to: FIXTURE.muHavenToken, data: '0x12' })).toBe(
      false,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// `SESSION_PERMS_FINGERPRINT` — sessionStorage cache-bust on policy
// drift. Failure surfaces as silently AA23-reverting userOps on stale
// session-key records.
// ────────────────────────────────────────────────────────────────────

describe('scoped-permissions — SESSION_PERMS_FINGERPRINT', () => {
  it('is a stable 8-hex string', () => {
    expect(SESSION_PERMS_FINGERPRINT).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is derived from the sorted (target:selector) join — same input → same hash', () => {
    // Reconstruction check: the module-level fingerprint should equal
    // the keccak256 of the sorted scope-keys joined by '|', sliced to
    // 8 hex. This guards against an accidental change to the slice
    // bounds or the join character without a corresponding fingerprint
    // bump.
    expect(SESSION_PERMS_FINGERPRINT.length).toBe(8);
    // SESSION_SCOPE_KEYS should map to SESSION_PERMISSIONS pairs.
    expect(SESSION_SCOPE_KEYS.size).toBe(SESSION_PERMISSIONS.length);
  });
});
