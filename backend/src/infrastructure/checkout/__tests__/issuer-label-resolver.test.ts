import { describe, expect, it } from 'vitest';
import { User } from '../../../domain/auth/model/user.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import { KybIssuerLabelResolver } from '../issuer-label-resolver.js';

class StubUserRepo implements IUserRepository {
  constructor(private readonly users: Map<string, User> = new Map()) {}
  async findById(id: string) {
    for (const u of this.users.values()) if (u.id === id) return u;
    return null;
  }
  async findByWalletAddress(address: string) {
    return this.users.get(address.toLowerCase()) ?? null;
  }
  async findByWalletAddresses(addresses: string[]) {
    return addresses
      .map((a) => this.users.get(a.toLowerCase()))
      .filter((u): u is User => Boolean(u));
  }
  async save(user: User) {
    this.users.set(user.walletAddress.toLowerCase(), user);
  }
}

const APPROVED_ADDR = '0x7e6132480c9f5f900efb5a47bfaca0a1bb9580f1' as const;
const PENDING_ADDR = '0x1111111111111111111111111111111111111111' as const;
const NO_NAME_ADDR = '0x2222222222222222222222222222222222222222' as const;
const UNKNOWN_ADDR = '0x9999999999999999999999999999999999999999' as const;

const makeUser = (params: {
  address: string;
  issuerStatus: 'unregistered' | 'pending' | 'approved' | 'suspended';
  issuerDisplayName?: string;
}) =>
  new User({
    id: `user-${params.address.slice(2, 8)}`,
    walletAddress: params.address,
    walletProvider: 'zerodev',
    role: params.issuerStatus === 'unregistered' ? 'investor' : 'issuer',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    issuerStatus: params.issuerStatus,
    issuerDisplayName: params.issuerDisplayName,
  });

describe('KybIssuerLabelResolver', () => {
  it('returns the display name (verified:false) for an approved issuer', async () => {
    const repo = new StubUserRepo(
      new Map([
        [
          APPROVED_ADDR,
          makeUser({
            address: APPROVED_ADDR,
            issuerStatus: 'approved',
            issuerDisplayName: 'MuHaven Demo Treasury',
          }),
        ],
      ]),
    );
    const resolver = new KybIssuerLabelResolver(repo);
    const result = await resolver.resolve(APPROVED_ADDR);
    expect(result).toEqual({ label: 'MuHaven Demo Treasury', verified: false });
  });

  it('returns null when no user row exists for the address', async () => {
    const resolver = new KybIssuerLabelResolver(new StubUserRepo());
    const result = await resolver.resolve(UNKNOWN_ADDR);
    expect(result).toBeNull();
  });

  it('returns null when the user row exists but issuerStatus is not approved', async () => {
    const repo = new StubUserRepo(
      new Map([
        [
          PENDING_ADDR,
          makeUser({
            address: PENDING_ADDR,
            issuerStatus: 'pending',
            issuerDisplayName: 'Should Not Surface',
          }),
        ],
      ]),
    );
    const resolver = new KybIssuerLabelResolver(repo);
    expect(await resolver.resolve(PENDING_ADDR)).toBeNull();
  });

  it('returns null for an approved issuer with no issuerDisplayName (legacy row)', async () => {
    const repo = new StubUserRepo(
      new Map([
        [
          NO_NAME_ADDR,
          makeUser({ address: NO_NAME_ADDR, issuerStatus: 'approved' }),
        ],
      ]),
    );
    const resolver = new KybIssuerLabelResolver(repo);
    expect(await resolver.resolve(NO_NAME_ADDR)).toBeNull();
  });

  it('returns null for a suspended issuer even with a populated display name', async () => {
    const repo = new StubUserRepo(
      new Map([
        [
          PENDING_ADDR,
          makeUser({
            address: PENDING_ADDR,
            issuerStatus: 'suspended',
            issuerDisplayName: 'Used to be approved',
          }),
        ],
      ]),
    );
    const resolver = new KybIssuerLabelResolver(repo);
    expect(await resolver.resolve(PENDING_ADDR)).toBeNull();
  });
});
