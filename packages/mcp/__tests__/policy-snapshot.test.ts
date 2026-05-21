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
});
