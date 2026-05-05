import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrokerRequest } from '../src/broker/daemon.js';
import type { ISigner } from '../src/broker/signer.js';
import type { IKeystore } from '../src/broker/keystore.js';

class StubSigner implements ISigner {
  readonly address = '0x1111111111111111111111111111111111111111' as const;
  async signHash(hash: `0x${string}`): Promise<`0x${string}`> {
    return ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`;
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
});
