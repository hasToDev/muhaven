import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  FilePolicyStore,
  PolicyStoreError,
  checkPolicy,
  decodeUint256ArgAt,
  selectorOf,
  type PolicySnapshot,
} from '../src/broker/policy-snapshot.js';

const ACTIVE_SIGNER = '0x1111111111111111111111111111111111111111' as const;

function snap(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    sessionId: 'sess_unit',
    mode: 'scoped',
    signerAddress: ACTIVE_SIGNER,
    targetContracts: ['0x2222222222222222222222222222222222222222'],
    selectorCaps: [
      { selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '10000000' },
    ],
    validUntilSec: 9_999_999_999,
    mintedAtSec: 1_000_000_000,
    ...overrides,
  };
}

function uint256Arg(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function callDataFor(selector: string, firstArg: bigint): `0x${string}` {
  return (selector + uint256Arg(firstArg)) as `0x${string}`;
}

describe('decodeUint256ArgAt', () => {
  it('decodes word 0', () => {
    expect(decodeUint256ArgAt(callDataFor('0xdeadbeef', 5_000_000n), 0)).toBe(5_000_000n);
    expect(decodeUint256ArgAt(callDataFor('0xdeadbeef', 0n), 0)).toBe(0n);
    expect(
      decodeUint256ArgAt(callDataFor('0xdeadbeef', (1n << 256n) - 1n), 0),
    ).toBe((1n << 256n) - 1n);
  });

  it('decodes word 2 (subscription.purchase maxSharesHint position)', () => {
    const cd = (
      '0xdeadbeef' +
      '0'.repeat(64) + // word 0
      '0'.repeat(64) + // word 1
      uint256Arg(42n) // word 2
    ) as `0x${string}`;
    expect(decodeUint256ArgAt(cd, 2)).toBe(42n);
  });

  it('throws on too-short callData for requested index', () => {
    // selector + word 0 only — asking for word 2 fails
    const cd = callDataFor('0xdeadbeef', 5n);
    expect(() => decodeUint256ArgAt(cd, 2)).toThrow(/too short/);
  });

  it('throws on negative or non-integer wordIndex', () => {
    const cd = callDataFor('0xdeadbeef', 5n);
    expect(() => decodeUint256ArgAt(cd, -1)).toThrow(/non-negative/);
    expect(() => decodeUint256ArgAt(cd, 1.5)).toThrow(/non-negative/);
  });
});

describe('selectorOf', () => {
  it('extracts and lowercases the 4-byte selector', () => {
    expect(selectorOf('0xDEADBEEF' + '0'.repeat(64) as `0x${string}`)).toBe('0xdeadbeef');
  });
});

describe('checkPolicy', () => {
  const NOW = 1_500_000_000;

  it('passes when signer + target + selector + arg all match within cap', () => {
    const res = checkPolicy({
      snapshot: snap(),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects expired snapshot with scope_violation', () => {
    const res = checkPolicy({
      snapshot: snap({ validUntilSec: 1 }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('scope_violation');
  });

  it('rejects wrong signer with policy_violation (H-1)', () => {
    const res = checkPolicy({
      snapshot: snap({ signerAddress: '0x3333333333333333333333333333333333333333' }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER, // doesn't match snapshot's signerAddress
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('policy_violation');
      expect(res.message).toMatch(/bound to signer/);
    }
  });

  it('signer-binding check is case-insensitive (H-2)', () => {
    const res = checkPolicy({
      snapshot: snap({ signerAddress: ACTIVE_SIGNER.toUpperCase() as `0x${string}` }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER, // lowercase
      nowSec: NOW,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects wrong target with policy_violation', () => {
    const res = checkPolicy({
      snapshot: snap(),
      innerCall: {
        target: '0x9999999999999999999999999999999999999999',
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('policy_violation');
  });

  it('rejects selector not in selectorCaps with policy_violation', () => {
    const res = checkPolicy({
      snapshot: snap(),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xfeedface', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('policy_violation');
  });

  it('rejects over-cap arg with max_spend_exceeded', () => {
    const res = checkPolicy({
      snapshot: snap({
        selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '100' }],
      }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 101n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('max_spend_exceeded');
  });

  it('arg exactly equal to cap is allowed (≤ semantics)', () => {
    const res = checkPolicy({
      snapshot: snap({
        selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '100' }],
      }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        callData: callDataFor('0xdeadbeef', 100n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(true);
  });

  it('is case-insensitive on target match', () => {
    const res = checkPolicy({
      snapshot: snap(),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222'.toUpperCase() as `0x${string}`,
        callData: callDataFor('0xdeadbeef', 5_000_000n),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(true);
  });

  it('capArgIndex: null skips the arg-cap check entirely', () => {
    const res = checkPolicy({
      snapshot: snap({
        selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: null, maxAmount: null }],
      }),
      innerCall: {
        target: '0x2222222222222222222222222222222222222222',
        // Arbitrarily large value — would over-cap if cap were enforced.
        callData: callDataFor('0xdeadbeef', (1n << 200n)),
      },
      activeSigner: ACTIVE_SIGNER,
      nowSec: NOW,
    });
    expect(res.ok).toBe(true);
  });

  // Wave 5 Slice 1 (MCP sell) — the cap check is selector-AGNOSTIC: the
  // broker reads `capArgIndex` from the matched cap, so redeem (word 2, same
  // as purchase) and queue-submit (word 1, no leading token arg) both work
  // through the SAME generic path. These fixtures pin that the cap arg index
  // is honoured per-selector.
  it('redeem cap (capArgIndex 2) accepts within cap and rejects over cap', () => {
    const REDEEM = '0xaabbccdd';
    const within = (
      REDEEM + '0'.repeat(64) + '0'.repeat(64) + uint256Arg(50n) // word2 = 50
    ) as `0x${string}`;
    const over = (
      REDEEM + '0'.repeat(64) + '0'.repeat(64) + uint256Arg(101n) // word2 = 101
    ) as `0x${string}`;
    const snapshot = snap({
      selectorCaps: [{ selector: REDEEM, capArgIndex: 2, maxAmount: '100' }],
    });
    expect(
      checkPolicy({ snapshot, innerCall: { target: snapshot.targetContracts[0]!, callData: within }, activeSigner: ACTIVE_SIGNER, nowSec: NOW }).ok,
    ).toBe(true);
    const rej = checkPolicy({ snapshot, innerCall: { target: snapshot.targetContracts[0]!, callData: over }, activeSigner: ACTIVE_SIGNER, nowSec: NOW });
    expect(rej.ok).toBe(false);
    if (!rej.ok) expect(rej.code).toBe('max_spend_exceeded');
  });

  it('queue-submit cap (capArgIndex 1, no token arg) reads maxSharesHint at word 1', () => {
    const SUBMIT = '0x11223344';
    // submit(encShares, maxSharesHint, ephemeralEOA): word0 = encShares
    // dynamic-offset, word1 = maxSharesHint, word2 = ephemeralEOA.
    const within = (
      SUBMIT + '0'.repeat(64) + uint256Arg(80n) + '0'.repeat(64) // word1 = 80
    ) as `0x${string}`;
    const over = (
      SUBMIT + '0'.repeat(64) + uint256Arg(200n) + '0'.repeat(64) // word1 = 200
    ) as `0x${string}`;
    const snapshot = snap({
      // The queue address is a distinct target; add it to the allowlist.
      targetContracts: ['0x3333333333333333333333333333333333333333'],
      selectorCaps: [{ selector: SUBMIT, capArgIndex: 1, maxAmount: '100' }],
    });
    const target = '0x3333333333333333333333333333333333333333' as const;
    expect(
      checkPolicy({ snapshot, innerCall: { target, callData: within }, activeSigner: ACTIVE_SIGNER, nowSec: NOW }).ok,
    ).toBe(true);
    const rej = checkPolicy({ snapshot, innerCall: { target, callData: over }, activeSigner: ACTIVE_SIGNER, nowSec: NOW });
    expect(rej.ok).toBe(false);
    if (!rej.ok) expect(rej.code).toBe('max_spend_exceeded');
  });
});

describe('FilePolicyStore', () => {
  let dir: string;
  let store: FilePolicyStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'muhaven-policy-test-'));
    store = new FilePolicyStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for missing snapshot', async () => {
    expect(await store.get('sess_nope', 0)).toBeNull();
  });

  it('put + get round-trip', async () => {
    const wire = snap();
    await store.put(wire);
    const got = await store.get(wire.sessionId, 1_500_000_000);
    expect(got).not.toBeNull();
    expect(got?.sessionId).toBe(wire.sessionId);
    expect(got?.selectorCaps[0].maxAmount).toBe(wire.selectorCaps[0].maxAmount);
    expect(got?.signerAddress).toBe(wire.signerAddress);
  });

  it('get returns null when snapshot is past validUntilSec', async () => {
    const wire = snap({ validUntilSec: 1000 });
    await store.put(wire);
    expect(await store.get(wire.sessionId, 2000)).toBeNull();
  });

  it('delete removes the snapshot file', async () => {
    const wire = snap();
    await store.put(wire);
    await store.delete(wire.sessionId);
    expect(await store.get(wire.sessionId, 1_500_000_000)).toBeNull();
    // File should be gone
    await expect(stat(join(dir, `${wire.sessionId}.json`))).rejects.toThrow();
  });

  it('delete is a no-op for missing snapshot', async () => {
    await expect(store.delete('sess_nope')).resolves.not.toThrow();
  });

  it('list returns all stored snapshots (including expired)', async () => {
    await store.put(snap({ sessionId: 'sess_a' }));
    await store.put(snap({ sessionId: 'sess_b', validUntilSec: 1 }));
    const all = await store.list();
    expect(all.length).toBe(2);
    expect(all.map((s) => s.sessionId).sort()).toEqual(['sess_a', 'sess_b']);
  });

  it('list returns empty array when dir does not exist', async () => {
    const emptyStore = new FilePolicyStore(join(dir, 'nonexistent'));
    expect(await emptyStore.list()).toEqual([]);
  });

  it('rejects path-traversal sessionId on get', async () => {
    await expect(store.get('../escape', 0)).rejects.toBeInstanceOf(PolicyStoreError);
  });

  it('rejects path-traversal sessionId on put', async () => {
    await expect(
      store.put(snap({ sessionId: '../escape' as string })),
    ).rejects.toBeInstanceOf(PolicyStoreError);
  });

  it('rejects path-traversal sessionId on delete', async () => {
    await expect(store.delete('../escape')).rejects.toBeInstanceOf(PolicyStoreError);
  });

  it('atomic write: tmp file does not persist after successful put', async () => {
    const wire = snap();
    await store.put(wire);
    // tmp pattern is <dest>.tmp-<6 hex bytes>; verify none exist
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    const tmpEntries = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpEntries).toEqual([]);
  });

  it('malformed JSON in keystore file surfaces malformed_record on get', async () => {
    const wire = snap();
    await writeFile(join(dir, `${wire.sessionId}.json`), 'not-json-at-all');
    await expect(store.get(wire.sessionId, 0)).rejects.toMatchObject({
      name: 'PolicyStoreError',
      code: 'malformed_record',
    });
  });

  it('valid JSON but wrong shape surfaces malformed_record on get', async () => {
    const wire = snap();
    await writeFile(
      join(dir, `${wire.sessionId}.json`),
      JSON.stringify({ sessionId: wire.sessionId, mode: 'wildcard' }), // wildcard not allowed
    );
    await expect(store.get(wire.sessionId, 0)).rejects.toMatchObject({
      name: 'PolicyStoreError',
      code: 'malformed_record',
    });
  });

  it('list silently skips malformed files', async () => {
    await store.put(snap({ sessionId: 'sess_good' }));
    await writeFile(join(dir, 'sess_bad.json'), 'not-json');
    const all = await store.list();
    expect(all.map((s) => s.sessionId)).toEqual(['sess_good']);
  });

  it('list ignores non-.json files', async () => {
    await store.put(snap({ sessionId: 'sess_good' }));
    await writeFile(join(dir, 'README.txt'), 'hello');
    await writeFile(join(dir, '.DS_Store'), '');
    const all = await store.list();
    expect(all.map((s) => s.sessionId)).toEqual(['sess_good']);
  });

  it.skipIf(platform() === 'win32')('snapshot file is mode 0600 on POSIX', async () => {
    const wire = snap();
    await store.put(wire);
    const s = await stat(join(dir, `${wire.sessionId}.json`));
    // mode bits — mask out file type
    expect(s.mode & 0o777).toBe(0o600);
  });

  // ── Wave 5 Path D Slice 1 Commit 3 — activeSessionId() narrow probe ─────

  describe('activeSessionId', () => {
    const NOW = 1_500_000_000;

    it('returns null when store is empty', async () => {
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBeNull();
    });

    it('returns null when dir does not exist', async () => {
      const emptyStore = new FilePolicyStore(join(dir, 'nonexistent'));
      expect(await emptyStore.activeSessionId(ACTIVE_SIGNER, NOW)).toBeNull();
    });

    it('returns the only non-expired snapshot bound to the active signer', async () => {
      await store.put(snap({ sessionId: 'sess_only' }));
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBe('sess_only');
    });

    it('returns null when 2 non-expired snapshots match the active signer (ambiguous)', async () => {
      await store.put(snap({ sessionId: 'sess_a' }));
      await store.put(snap({ sessionId: 'sess_b' }));
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBeNull();
    });

    it('skips expired snapshots — picks the only non-expired one', async () => {
      await store.put(snap({ sessionId: 'sess_old', validUntilSec: 1 }));
      await store.put(snap({ sessionId: 'sess_live' }));
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBe('sess_live');
    });

    it('skips snapshots bound to a different signer', async () => {
      const OTHER = '0x3333333333333333333333333333333333333333' as const;
      await store.put(snap({ sessionId: 'sess_mine' }));
      await store.put(snap({ sessionId: 'sess_other', signerAddress: OTHER }));
      // From the active signer's perspective, only sess_mine is active.
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBe('sess_mine');
      // From the other signer's perspective, only sess_other.
      expect(await store.activeSessionId(OTHER, NOW)).toBe('sess_other');
    });

    it('signer match is case-insensitive', async () => {
      await store.put(snap({ sessionId: 'sess_mixed' }));
      // ACTIVE_SIGNER stored lowercase via coerceFromDisk; query with upper.
      expect(
        await store.activeSessionId(
          ACTIVE_SIGNER.toUpperCase() as `0x${string}`,
          NOW,
        ),
      ).toBe('sess_mixed');
    });

    it('returns null when all matching snapshots are expired', async () => {
      await store.put(snap({ sessionId: 'sess_expired_a', validUntilSec: 1 }));
      await store.put(snap({ sessionId: 'sess_expired_b', validUntilSec: 2 }));
      expect(await store.activeSessionId(ACTIVE_SIGNER, NOW)).toBeNull();
    });
  });
});
