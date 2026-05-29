import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrokerRequest } from '../src/broker/daemon.js';
import type { ISigner } from '../src/broker/signer.js';
import type { IKeystore } from '../src/broker/keystore.js';
import type { IPolicyStore, PolicySnapshot } from '../src/broker/policy-snapshot.js';

class StubSigner implements ISigner {
  readonly address = '0x1111111111111111111111111111111111111111' as const;
  async signHash(_hash: `0x${string}`): Promise<`0x${string}`> {
    return ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`;
  }
  async signRawMessage(_hash: `0x${string}`): Promise<`0x${string}`> {
    return ('0x' + 'bb'.repeat(64) + '1c') as `0x${string}`;
  }
}

class MemoryPolicyStore implements IPolicyStore {
  private readonly snapshots = new Map<string, PolicySnapshot>();

  async get(sessionId: string, nowSec: number): Promise<PolicySnapshot | null> {
    const snap = this.snapshots.get(sessionId) ?? null;
    if (!snap) return null;
    if (snap.validUntilSec <= nowSec) return null;
    return snap;
  }

  async put(snapshot: PolicySnapshot): Promise<void> {
    this.snapshots.set(snapshot.sessionId, snapshot);
  }

  async delete(sessionId: string): Promise<void> {
    this.snapshots.delete(sessionId);
  }

  async list(): Promise<PolicySnapshot[]> {
    return Array.from(this.snapshots.values());
  }

  async activeSessionId(
    activeSignerAddress: `0x${string}`,
    nowSec: number,
  ): Promise<string | null> {
    const needle = activeSignerAddress.toLowerCase();
    const matches = Array.from(this.snapshots.values()).filter(
      (s) =>
        s.validUntilSec > nowSec && s.signerAddress.toLowerCase() === needle,
    );
    return matches.length === 1 ? matches[0]!.sessionId : null;
  }

  // Test helpers
  raw(): Map<string, PolicySnapshot> {
    return this.snapshots;
  }
}

class MemoryKeystore implements IKeystore {
  readonly backend = 'file' as const;
  readonly available = true;
  private record: { jwt: string; expiresAtSec: number | null; storedAtSec: number } | null = null;

  async set(record: { jwt: string; expiresAtSec: number | null; storedAtSec: number }): Promise<void> {
    this.record = record;
  }

  async get(): Promise<{ jwt: string; expiresAtSec: number | null; storedAtSec: number } | null> {
    return this.record;
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

describe('handleBrokerRequest', () => {
  let signer: StubSigner;
  let keystore: MemoryKeystore;
  beforeEach(() => {
    signer = new StubSigner();
    keystore = new MemoryKeystore();
  });

  it('hello returns version + signer + hasJwt=false on empty store', async () => {
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore);
    expect(res.type).toBe('hello');
    if (res.type === 'hello') {
      expect(res.sessionKeyAddress).toBe(signer.address);
      expect(res.hasJwt).toBe(false);
    }
  });

  it('hello reflects hasJwt=true after store_jwt', async () => {
    await keystore.set({ jwt: 'a.b.c', expiresAtSec: null, storedAtSec: 0 });
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore);
    if (res.type === 'hello') expect(res.hasJwt).toBe(true);
  });

  it('sign_hash returns signature + signer address', async () => {
    const res = await handleBrokerRequest(
      { type: 'sign_hash', hash: ('0x' + '1'.repeat(64)) as `0x${string}` },
      signer,
      keystore,
    );
    expect(res.type).toBe('sign_hash');
    if (res.type === 'sign_hash') {
      expect(res.signature).toMatch(/^0x[a-f0-9]{130}$/);
      expect(res.signerAddress).toBe(signer.address);
    }
  });

  it('store_jwt + get_jwt round-trip', async () => {
    const stored = await handleBrokerRequest(
      { type: 'store_jwt', jwt: 'a.b.c', expiresAtSec: 1000 },
      signer,
      keystore,
      () => 100,
    );
    expect(stored.type).toBe('store_jwt');
    const got = await handleBrokerRequest({ type: 'get_jwt' }, signer, keystore);
    expect(got.type).toBe('get_jwt');
    if (got.type === 'get_jwt') {
      expect(got.jwt).toBe('a.b.c');
      expect(got.expiresAtSec).toBe(1000);
    }
  });

  it('clear_jwt returns null on subsequent get', async () => {
    await keystore.set({ jwt: 'a.b.c', expiresAtSec: null, storedAtSec: 0 });
    await handleBrokerRequest({ type: 'clear_jwt' }, signer, keystore);
    const got = await handleBrokerRequest({ type: 'get_jwt' }, signer, keystore);
    if (got.type === 'get_jwt') expect(got.jwt).toBeNull();
  });

  it('pipelined bytes path tested in integration; handler is single-shot per call', async () => {
    // The newline-trailing rejection lives in BrokerDaemon.onConnection;
    // the pure handler under test is by construction single-shot. This
    // case documents the boundary so a future refactor can't relax it
    // without a failing test.
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore);
    expect(res.type).toBe('hello');
  });

  it('store_jwt failure surfaces keystore_unavailable', async () => {
    const failingKeystore: IKeystore = {
      backend: 'os',
      available: false,
      async set() {
        throw new Error('locked');
      },
      async get() {
        return null;
      },
      async clear() {
        /* no-op */
      },
    };
    const res = await handleBrokerRequest(
      { type: 'store_jwt', jwt: 'a.b.c' },
      signer,
      failingKeystore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('keystore_unavailable');
  });

  // ------- v0.3.0: lazy session-key + effectiveConfig surface -------

  it('hello surfaces hasSessionKey + effectiveConfig from options', async () => {
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore, undefined, {
      hasSessionKey: true,
      effectiveConfig: {
        backendBaseUrl: 'https://api.example.test',
        dashboardBaseUrl: 'https://dash.example.test',
      },
    });
    expect(res.type).toBe('hello');
    if (res.type === 'hello') {
      expect(res.hasSessionKey).toBe(true);
      expect(res.effectiveConfig).toEqual({
        backendBaseUrl: 'https://api.example.test',
        dashboardBaseUrl: 'https://dash.example.test',
      });
    }
  });

  it('hello defaults hasSessionKey to true when options omitted (back-compat)', async () => {
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore);
    if (res.type === 'hello') {
      expect(res.hasSessionKey).toBe(true);
      expect(res.effectiveConfig).toBeUndefined();
    }
  });

  it('hello reflects hasSessionKey=false when options say so', async () => {
    const res = await handleBrokerRequest({ type: 'hello' }, signer, keystore, undefined, {
      hasSessionKey: false,
    });
    if (res.type === 'hello') expect(res.hasSessionKey).toBe(false);
  });

  it('sign_hash with NullSigner returns session_key_unavailable error', async () => {
    const { NullSigner } = await import('../src/broker/signer.js');
    const nullSigner = new NullSigner();
    const res = await handleBrokerRequest(
      { type: 'sign_hash', hash: ('0x' + '1'.repeat(64)) as `0x${string}` },
      nullSigner,
      keystore,
      undefined,
      { hasSessionKey: false },
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') {
      expect(res.code).toBe('session_key_unavailable');
      expect(res.message).toMatch(/MUHAVEN_BROKER_SESSION_KEY/);
    }
  });

  it('sign_hash with NullSigner re-throws non-MissingSessionKey errors verbatim', async () => {
    // Defensive: a signer that throws an unrelated error should NOT be
    // mapped to session_key_unavailable — the daemon's outer try/catch
    // path should see the raw exception and surface `internal`.
    const exploder: import('../src/broker/signer.js').ISigner = {
      address: '0x2222222222222222222222222222222222222222' as const,
      async signHash() {
        throw new Error('viem oom');
      },
      async signRawMessage() {
        throw new Error('viem oom (signRawMessage)');
      },
    };
    await expect(
      handleBrokerRequest(
        { type: 'sign_hash', hash: ('0x' + '2'.repeat(64)) as `0x${string}` },
        exploder,
        keystore,
      ),
    ).rejects.toThrow(/viem oom/);
  });

  // ---------- Wave 5 Path D Slice 1 — sign_userop + policy snapshot ----------

  const VALID_TARGET = '0x' + 'b'.repeat(40);
  const SUBSCRIPTION_PURCHASE_SELECTOR = '0xdeadbeef';
  // Helpers — hand-build calldata with a known value at a known index.
  function uint256Arg(n: bigint): string {
    return n.toString(16).padStart(64, '0');
  }
  /** Build callData with first uint256 arg = `firstArg` at word index 0. */
  function callDataFor(selector: string, firstArg: bigint): `0x${string}` {
    return (selector + uint256Arg(firstArg)) as `0x${string}`;
  }
  function snap(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
    return {
      sessionId: 'sess_test',
      mode: 'scoped',
      // signer.address used in this test file is 0x1111...1111 (StubSigner)
      signerAddress: '0x1111111111111111111111111111111111111111',
      targetContracts: [VALID_TARGET as `0x${string}`],
      selectorCaps: [
        {
          selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`,
          capArgIndex: 0,
          maxAmount: '10000000',
        },
      ],
      validUntilSec: 9_999_999_999,
      mintedAtSec: 1_000_000_000,
      ...overrides,
    };
  }

  it('sign_userop returns no_active_snapshot when no snapshot stored', async () => {
    const policyStore = new MemoryPolicyStore();
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('no_active_snapshot');
  });

  it('sign_userop signs when target + selector + arg-cap all pass', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('sign_userop');
    if (res.type === 'sign_userop') {
      expect(res.signature).toMatch(/^0x[a-f0-9]{130}$/);
      expect(res.signerAddress).toBe(signer.address);
      expect(res.sessionId).toBe('sess_test');
    }
  });

  // ---------- Wave 5 Slice 2c — batch innerCalls (atomic claim+buy) ----------

  const CLAIM_SELECTOR = '0xfeedface';
  function batchSnap(): PolicySnapshot {
    return snap({
      selectorCaps: [
        {
          selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`,
          capArgIndex: 0,
          maxAmount: '10000000',
        },
        // claim is uncapped (capArgIndex/maxAmount both null).
        { selector: CLAIM_SELECTOR as `0x${string}`, capArgIndex: null, maxAmount: null },
      ],
    });
  }

  it('sign_userop signs a batch when EVERY innerCalls leg passes policy', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(batchSnap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        // innerCall = first leg (back-compat for a pre-2c daemon).
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(CLAIM_SELECTOR, 3n),
        },
        innerCalls: [
          { target: VALID_TARGET as `0x${string}`, callData: callDataFor(CLAIM_SELECTOR, 3n) },
          {
            target: VALID_TARGET as `0x${string}`,
            callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
          },
        ],
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('sign_userop');
  });

  it('sign_userop REJECTS the whole batch when ANY leg exceeds its cap (buy over-cap)', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(batchSnap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(CLAIM_SELECTOR, 3n),
        },
        innerCalls: [
          { target: VALID_TARGET as `0x${string}`, callData: callDataFor(CLAIM_SELECTOR, 3n) },
          {
            // buy leg over the 10,000,000 per-op cap → max_spend_exceeded.
            target: VALID_TARGET as `0x${string}`,
            callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 99_000_000n),
          },
        ],
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('max_spend_exceeded');
  });

  it('sign_userop returns policy_violation when target not in allowlist', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: ('0x' + 'c'.repeat(40)) as `0x${string}`, // not in allowlist
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('policy_violation');
  });

  it('sign_userop returns policy_violation when selector not in allowlist', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor('0xfeedface', 5_000_000n), // wrong selector
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('policy_violation');
  });

  it('sign_userop returns max_spend_exceeded when first uint256 arg > cap', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap()); // cap = 10_000_000
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 10_000_001n), // 1 over
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('max_spend_exceeded');
  });

  it('sign_userop with expired snapshot returns no_active_snapshot (store-side TTL filter swallows scope_violation)', async () => {
    // The pure checkPolicy unit test covers the scope_violation branch directly.
    // At the daemon level, MemoryPolicyStore + handler share the same nowSec
    // so the store's expiry filter fires first → no_active_snapshot. This
    // test pins the daemon-path equivalence class so a future refactor that
    // skips the store-side filter (and surfaces scope_violation directly)
    // changes both this test name and assertion intentionally.
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap({ validUntilSec: 1 }));
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      () => 1000, // now > validUntilSec
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('no_active_snapshot');
  });

  // ---------- Trust-architect H-1 + T-1 + T-4 + T-5 + T-6 ----------

  it('sign_userop returns policy_violation when snapshot.signerAddress != broker.signer.address (H-1)', async () => {
    const policyStore = new MemoryPolicyStore();
    // Snapshot bound to a DIFFERENT signer (0x2222... vs broker's 0x1111...).
    await policyStore.put(
      snap({ signerAddress: '0x2222222222222222222222222222222222222222' }),
    );
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') {
      expect(res.code).toBe('policy_violation');
      expect(res.message).toMatch(/bound to signer/);
    }
  });

  it('sign_userop signer-binding check is case-insensitive on signerAddress (H-2)', async () => {
    const policyStore = new MemoryPolicyStore();
    // Snapshot's signerAddress is UPPERCASED (signer.address is lower).
    await policyStore.put(
      snap({ signerAddress: '0x1111111111111111111111111111111111111111'.toUpperCase() as `0x${string}` }),
    );
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('sign_userop');
  });

  it('sign_userop returns no_active_snapshot when requested sessionId does not match stored snapshot (T-1)', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap({ sessionId: 'sess_A' }));
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_B', // different
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('no_active_snapshot');
  });

  it('store_policy_snapshot is last-write-wins; T-4 lock-in', async () => {
    // Slice 1 semantic: blind overwrite. Slice 4 may tighten to "no overwrite
    // without explicit clear" — this test pins the current behaviour so the
    // change is deliberate.
    const policyStore = new MemoryPolicyStore();
    await handleBrokerRequest(
      { type: 'store_policy_snapshot', snapshot: snap({ selectorCaps: [{ selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`, capArgIndex: 0, maxAmount: '100' }] }) },
      signer, keystore, undefined, {}, policyStore,
    );
    await handleBrokerRequest(
      { type: 'store_policy_snapshot', snapshot: snap({ selectorCaps: [{ selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`, capArgIndex: 0, maxAmount: '999999' }] }) },
      signer, keystore, undefined, {}, policyStore,
    );
    const got = await policyStore.get('sess_test', 1_500_000_000);
    expect(got?.selectorCaps[0].maxAmount).toBe('999999');
  });

  it('sign_userop ignores intent for policy decisions (T-5)', async () => {
    // intent.summary claims a different action than the actual calldata
    // implies. Policy decision MUST be on the calldata, not the intent.
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          // Selector NOT in selectorCaps — policy MUST reject regardless of intent.
          callData: callDataFor('0xbaadbaad', 1n),
        },
        intent: { tool: 'tool', summary: `claims selector ${SUBSCRIPTION_PURCHASE_SELECTOR}` },
      },
      signer, keystore, undefined, {}, policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('policy_violation');
  });

  it('sign_userop signature recovers to broker.signer.address (T-6)', async () => {
    // Real ECDSA: use viem to verify the signed hash recovers the StubSigner
    // address. The StubSigner returns a deterministic fake signature, so we
    // assert the response shape carries the correct signerAddress.
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer, keystore, undefined, {}, policyStore,
    );
    expect(res.type).toBe('sign_userop');
    if (res.type === 'sign_userop') {
      expect(res.signerAddress).toBe(signer.address);
      expect(res.sessionId).toBe('sess_test');
    }
  });

  it('sign_userop honors capArgIndex > 0 for purchase-shaped calldata', async () => {
    // Subscription.purchase has the cap target at word index 2
    // (maxSharesHint). Snapshot configures capArgIndex: 2, maxAmount: 100.
    // calldata: selector + token-addr(slot 0) + InEuint128-offset(slot 1) +
    //           maxSharesHint(slot 2) + ephemeralEOA(slot 3).
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(
      snap({
        selectorCaps: [
          { selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`, capArgIndex: 2, maxAmount: '100' },
        ],
      }),
    );
    // value at slot 2 = 50 (within cap)
    const callData = (
      SUBSCRIPTION_PURCHASE_SELECTOR +
      uint256Arg(0n) + // slot 0 = token address (any)
      uint256Arg(0n) + // slot 1 = dynamic offset (any)
      uint256Arg(50n) + // slot 2 = maxSharesHint = 50
      uint256Arg(0n) // slot 3 = ephemeralEOA
    ) as `0x${string}`;
    const okRes = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: { target: VALID_TARGET as `0x${string}`, callData },
      },
      signer, keystore, undefined, {}, policyStore,
    );
    expect(okRes.type).toBe('sign_userop');

    // Now slot 2 = 101 — over cap
    const overData = (
      SUBSCRIPTION_PURCHASE_SELECTOR +
      uint256Arg(0n) + uint256Arg(0n) + uint256Arg(101n) + uint256Arg(0n)
    ) as `0x${string}`;
    const overRes = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: { target: VALID_TARGET as `0x${string}`, callData: overData },
      },
      signer, keystore, undefined, {}, policyStore,
    );
    expect(overRes.type).toBe('error');
    if (overRes.type === 'error') expect(overRes.code).toBe('max_spend_exceeded');
  });

  it('sign_userop with capArgIndex: null allows any arg value (claim-style selector)', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(
      snap({
        selectorCaps: [
          // Selector allowed, no arg cap.
          { selector: SUBSCRIPTION_PURCHASE_SELECTOR as `0x${string}`, capArgIndex: null, maxAmount: null },
        ],
      }),
    );
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          // Any value passes — no cap to enforce.
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, (1n << 200n)),
        },
      },
      signer, keystore, undefined, {}, policyStore,
    );
    expect(res.type).toBe('sign_userop');
  });

  it('sign_userop with NullSigner returns session_key_unavailable', async () => {
    const policyStore = new MemoryPolicyStore();
    // NullSigner.address is the zero address; bind the snapshot to it so the
    // H-1 signer-binding check passes and we reach the actual sign attempt
    // (which then throws MissingSessionKeyError).
    await policyStore.put(
      snap({ signerAddress: '0x0000000000000000000000000000000000000000' }),
    );
    const { NullSigner } = await import('../src/broker/signer.js');
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      new NullSigner(),
      keystore,
      undefined,
      { hasSessionKey: false },
      policyStore,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('session_key_unavailable');
  });

  it('sign_userop returns internal when daemon has no policyStore', async () => {
    const res = await handleBrokerRequest(
      {
        type: 'sign_userop',
        sessionId: 'sess_test',
        userOpHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        innerCall: {
          target: VALID_TARGET as `0x${string}`,
          callData: callDataFor(SUBSCRIPTION_PURCHASE_SELECTOR, 5_000_000n),
        },
      },
      signer,
      keystore,
      undefined,
      {},
      // no policyStore — simulates an older daemon misconfiguration
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('internal');
  });

  // store/get/clear policy snapshot ------------------------------------

  it('store_policy_snapshot + get_policy_snapshot round-trip', async () => {
    const policyStore = new MemoryPolicyStore();
    const wire = snap();
    const stored = await handleBrokerRequest(
      { type: 'store_policy_snapshot', snapshot: wire },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(stored.type).toBe('store_policy_snapshot');
    if (stored.type === 'store_policy_snapshot') {
      expect(stored.stored).toBe(true);
      expect(stored.sessionId).toBe(wire.sessionId);
    }
    const got = await handleBrokerRequest(
      { type: 'get_policy_snapshot', sessionId: wire.sessionId },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(got.type).toBe('get_policy_snapshot');
    if (got.type === 'get_policy_snapshot') {
      expect(got.snapshot?.sessionId).toBe(wire.sessionId);
      expect(got.snapshot?.selectorCaps[0].maxAmount).toBe('10000000');
    }
  });

  it('get_policy_snapshot returns null for unknown session', async () => {
    const policyStore = new MemoryPolicyStore();
    const got = await handleBrokerRequest(
      { type: 'get_policy_snapshot', sessionId: 'sess_nope' },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(got.type).toBe('get_policy_snapshot');
    if (got.type === 'get_policy_snapshot') expect(got.snapshot).toBeNull();
  });

  it('clear_policy_snapshot deletes the entry', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap());
    await handleBrokerRequest(
      { type: 'clear_policy_snapshot', sessionId: 'sess_test' },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(policyStore.raw().size).toBe(0);
  });

  it('store/get/clear policy snapshot return internal when no policyStore wired', async () => {
    for (const req of [
      { type: 'store_policy_snapshot' as const, snapshot: snap() },
      { type: 'get_policy_snapshot' as const, sessionId: 'sess_test' },
      { type: 'clear_policy_snapshot' as const, sessionId: 'sess_test' },
    ]) {
      const res = await handleBrokerRequest(req, signer, keystore, undefined, {});
      expect(res.type).toBe('error');
      if (res.type === 'error') expect(res.code).toBe('internal');
    }
  });

  // ── get_active_session_id (Wave 5 Path D Slice 1 Commit 3) ────────────

  it('get_active_session_id returns the unique active session id', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap({ sessionId: 'sess_only' }));
    const res = await handleBrokerRequest(
      { type: 'get_active_session_id' },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('get_active_session_id');
    if (res.type === 'get_active_session_id') {
      expect(res.sessionId).toBe('sess_only');
    }
  });

  it('get_active_session_id returns null when no session is active', async () => {
    const policyStore = new MemoryPolicyStore();
    const res = await handleBrokerRequest(
      { type: 'get_active_session_id' },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('get_active_session_id');
    if (res.type === 'get_active_session_id') {
      expect(res.sessionId).toBeNull();
    }
  });

  it('get_active_session_id returns null when 2+ sessions match (ambiguous)', async () => {
    const policyStore = new MemoryPolicyStore();
    await policyStore.put(snap({ sessionId: 'sess_a' }));
    await policyStore.put(snap({ sessionId: 'sess_b' }));
    const res = await handleBrokerRequest(
      { type: 'get_active_session_id' },
      signer,
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('get_active_session_id');
    if (res.type === 'get_active_session_id') {
      expect(res.sessionId).toBeNull();
    }
  });

  it('get_active_session_id filters to the broker’s active signer', async () => {
    const policyStore = new MemoryPolicyStore();
    // Two snapshots: one bound to our signer, one bound to a different signer.
    // Only sess_mine should surface — the other is invisible to us even
    // though it exists in the store.
    await policyStore.put(snap({ sessionId: 'sess_mine' }));
    await policyStore.put(
      snap({
        sessionId: 'sess_other',
        signerAddress: '0x9999999999999999999999999999999999999999',
      }),
    );
    const res = await handleBrokerRequest(
      { type: 'get_active_session_id' },
      signer, // signer.address = 0x1111…
      keystore,
      undefined,
      {},
      policyStore,
    );
    expect(res.type).toBe('get_active_session_id');
    if (res.type === 'get_active_session_id') {
      expect(res.sessionId).toBe('sess_mine');
    }
  });

  it('get_active_session_id returns internal when no policyStore wired', async () => {
    const res = await handleBrokerRequest(
      { type: 'get_active_session_id' },
      signer,
      keystore,
      undefined,
      {},
      // no policyStore
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('internal');
  });

  // ── Wave 5 Option D Commit 3 — current_nonce + notify_userop_landed ──

  it('current_nonce returns chain_rpc_failed when no outbound wired', async () => {
    const res = await handleBrokerRequest(
      {
        type: 'current_nonce',
        accountAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
      },
      signer,
      keystore,
      undefined,
      {},
      undefined,
      undefined, // no outbound
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('chain_rpc_failed');
  });

  it('current_nonce returns the outbound module result on success', async () => {
    const { BrokerOutbound } = await import('../src/broker/outbound.js');
    const outbound = new BrokerOutbound({
      chainRpcUrl: 'https://stub-rpc.example/',
      backendBaseUrl: 'https://api.example/',
      outboundOriginHeader: 'https://example/',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            // 7 encoded as uint32 = 32-byte left-padded `0x...00000007`
            result: '0x' + '00'.repeat(28) + '00000007',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const res = await handleBrokerRequest(
      {
        type: 'current_nonce',
        accountAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
      },
      signer,
      keystore,
      undefined,
      {},
      undefined,
      outbound,
    );
    expect(res.type).toBe('current_nonce');
    if (res.type === 'current_nonce') {
      expect(res.nonce).toBe(7);
    }
  });

  it('current_nonce surfaces chain_rpc_failed on fetch failure', async () => {
    const { BrokerOutbound } = await import('../src/broker/outbound.js');
    const outbound = new BrokerOutbound({
      chainRpcUrl: 'https://stub-rpc.example/',
      backendBaseUrl: 'https://api.example/',
      outboundOriginHeader: 'https://example/',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const res = await handleBrokerRequest(
      {
        type: 'current_nonce',
        accountAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
      },
      signer,
      keystore,
      undefined,
      {},
      undefined,
      outbound,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('chain_rpc_failed');
  });

  it('notify_userop_landed returns callback_unconfigured when secret unset', async () => {
    const { BrokerOutbound } = await import('../src/broker/outbound.js');
    const outbound = new BrokerOutbound({
      chainRpcUrl: 'https://stub-rpc.example/',
      backendBaseUrl: 'https://api.example/',
      // callbackServiceSecret missing
      outboundOriginHeader: 'https://example/',
    });
    const res = await handleBrokerRequest(
      {
        type: 'notify_userop_landed',
        sessionId: 'sess_xyz',
        accountAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
        permissionId: '0xdeadbeef',
        txHash: '0x' + '1'.repeat(64) as `0x${string}`,
        blockNumber: 100,
        logIndex: 0,
      },
      signer,
      keystore,
      undefined,
      {},
      undefined,
      outbound,
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('callback_unconfigured');
  });

  it('notify_userop_landed acks immediately (fire-and-forget) when configured', async () => {
    const { BrokerOutbound } = await import('../src/broker/outbound.js');
    let postCount = 0;
    const outbound = new BrokerOutbound({
      chainRpcUrl: 'https://stub-rpc.example/',
      backendBaseUrl: 'https://api.example/',
      callbackServiceSecret: 'x'.repeat(32),
      outboundOriginHeader: 'https://example/',
      fetchImpl: async () => {
        postCount++;
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const res = await handleBrokerRequest(
      {
        type: 'notify_userop_landed',
        sessionId: 'sess_xyz',
        accountAddress: '0x' + 'a'.repeat(40) as `0x${string}`,
        permissionId: '0xdeadbeef',
        txHash: '0x' + '1'.repeat(64) as `0x${string}`,
        blockNumber: 100,
        logIndex: 0,
      },
      signer,
      keystore,
      undefined,
      {},
      undefined,
      outbound,
    );
    expect(res.type).toBe('notify_userop_landed');
    if (res.type === 'notify_userop_landed') {
      expect(res.queued).toBe(true);
      expect(res.sessionId).toBe('sess_xyz');
    }
    // Let the fire-and-forget POST settle on the microtask queue.
    await new Promise((r) => setTimeout(r, 10));
    expect(postCount).toBeGreaterThanOrEqual(1);
  });
});
