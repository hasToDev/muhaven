import { describe, it, expect, vi } from 'vitest';
import { JwtSource, NoJwtAvailableError } from '../src/auth/jwt-source.js';

interface BrokerStub {
  getJwt: ReturnType<typeof vi.fn>;
}

function stubBroker(jwt: string | null, expiresAtSec: number | null = null): BrokerStub {
  return {
    getJwt: vi.fn(async () => ({ type: 'get_jwt' as const, jwt, expiresAtSec })),
  };
}

describe('JwtSource', () => {
  it('throws NoJwtAvailableError when broker returns null', async () => {
    const broker = stubBroker(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = new JwtSource(broker as any, 30);
    await expect(src.get()).rejects.toBeInstanceOf(NoJwtAvailableError);
  });

  it('caches the JWT for the configured TTL', async () => {
    const broker = stubBroker('a.b.c');
    let now = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = new JwtSource(broker as any, 30, () => now);
    await src.get();
    now = 5_000;
    await src.get();
    expect(broker.getJwt).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL', async () => {
    const broker = stubBroker('a.b.c');
    let now = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = new JwtSource(broker as any, 30, () => now);
    await src.get();
    now = 60_000;
    await src.get();
    expect(broker.getJwt).toHaveBeenCalledTimes(2);
  });

  it('refetches when JWT is within 30s of expiry', async () => {
    let now = 0;
    const expiresAtSec = 100;
    const broker = stubBroker('a.b.c', expiresAtSec);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = new JwtSource(broker as any, 60, () => now);
    await src.get();
    expect(broker.getJwt).toHaveBeenCalledTimes(1);
    // Move clock to 80s — now < expiresAtSec but expiresAtSec - now < 30 → refetch.
    now = 80_000;
    await src.get();
    expect(broker.getJwt).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces refetch', async () => {
    const broker = stubBroker('a.b.c');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src = new JwtSource(broker as any, 60);
    await src.get();
    src.invalidate();
    await src.get();
    expect(broker.getJwt).toHaveBeenCalledTimes(2);
  });
});
