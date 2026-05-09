/**
 * Phase 9.A · Option Z — `GetActivityUseCase` reads `tax_events` only
 * (Option C single-source). The pre-Option-Z yield + escrow paths are
 * retired. These cases lock in the new mapping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { GetActivityUseCase } from '../get-activity.use-case.js';
import {
  CASH_RAIL_EVENT_TYPES,
  INVESTOR_ACTIVITY_EVENT_TYPES,
  TaxEvent,
} from '../../../../domain/tax-event/model/tax-event.js';
import type { ITaxEventRepository } from '../../../../domain/tax-event/repository/tax-event.repository.js';
import type { IUserRepository } from '../../../../domain/auth/repository/user.repository.js';
import { User } from '../../../../domain/auth/model/user.js';

class FakeTaxEventRepo implements ITaxEventRepository {
  private store = new Map<string, TaxEvent[]>();

  setHolderEvents(holder: string, events: TaxEvent[]): void {
    this.store.set(holder.toLowerCase(), events);
  }

  async saveMany(): Promise<number> {
    return 0;
  }

  async findByHolder(holderAddress: string, limit: number): Promise<TaxEvent[]> {
    const all = this.store.get(holderAddress.toLowerCase()) ?? [];
    return all.slice(0, limit);
  }

  async hasInvestorActivity(holderAddress: string): Promise<boolean> {
    const all = this.store.get(holderAddress.toLowerCase()) ?? [];
    return all.some((r) => INVESTOR_ACTIVITY_EVENT_TYPES.includes(r.eventType));
  }

  async hasCashRailActivity(holderAddress: string): Promise<boolean> {
    const all = this.store.get(holderAddress.toLowerCase()) ?? [];
    return all.some((r) => CASH_RAIL_EVENT_TYPES.includes(r.eventType));
  }

  async aggregateCounts() {
    return {
      Acquisition: 0,
      Disposition: 0,
      IncomeAccrual: 0,
      FeeEvent: 0,
      Wrap: 0,
      Unwrap: 0,
      Transfer: 0,
    };
  }
  async dailyCounts() {
    return [];
  }
  async acquisitionsByToken() {
    return [];
  }
  async dispositionsByKind() {
    return { totals: { instant: 0, queued: 0, escalatedToQueue: 0 }, byDay: [] };
  }
}

class FakeUserRepo implements IUserRepository {
  private byId = new Map<string, User>();

  setUser(user: User): void {
    this.byId.set(user.id, user);
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
  async findByWalletAddress(): Promise<User | null> {
    return null;
  }
  async findByWalletAddresses(): Promise<User[]> {
    return [];
  }
  async save(): Promise<void> {}
}

const HANDLE = '0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00';
const NOW = new Date('2026-05-01T12:00:00Z');

function evt(overrides: Partial<ConstructorParameters<typeof TaxEvent>[0]>): TaxEvent {
  return new TaxEvent({
    txHash: '0xabcd',
    logIndex: 1,
    eventType: 'Wrap',
    holderAddress: '0xHOLDER',
    tokenAddress: null,
    blockNumber: '100',
    blockTimestamp: NOW,
    navAtTime: null,
    referenceId: null,
    metadata: null,
    ...overrides,
  });
}

function makeUser(id: string, wallet: string): User {
  return new User({
    id,
    walletAddress: wallet,
    walletProvider: 'zerodev',
    role: 'investor',
    createdAt: NOW,
  });
}

describe('GetActivityUseCase (Phase 9.A · Option Z)', () => {
  let taxRepo: FakeTaxEventRepo;
  let userRepo: FakeUserRepo;
  let useCase: GetActivityUseCase;
  const userId = randomUUID();
  const wallet = '0xa11ce0000000000000000000000000000000a11c';

  beforeEach(() => {
    taxRepo = new FakeTaxEventRepo();
    userRepo = new FakeUserRepo();
    userRepo.setUser(makeUser(userId, wallet));
    useCase = new GetActivityUseCase(taxRepo, userRepo);
  });

  it('returns empty page when the user has no recorded wallet address', async () => {
    const noWalletUser = randomUUID();
    const result = await useCase.execute(noWalletUser);
    expect(result.items).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('maps eventType + metadata.kind into the activity item type union', async () => {
    taxRepo.setHolderEvents(wallet, [
      evt({
        txHash: '0x1',
        logIndex: 1,
        eventType: 'Acquisition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: null,
      }),
      evt({
        txHash: '0x2',
        logIndex: 1,
        eventType: 'Disposition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: { kind: 'instant' },
      }),
      evt({
        txHash: '0x3',
        logIndex: 1,
        eventType: 'Disposition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: { kind: 'queued' },
      }),
      evt({
        txHash: '0x4',
        logIndex: 1,
        eventType: 'IncomeAccrual',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: null,
      }),
      evt({
        txHash: '0x5',
        logIndex: 1,
        eventType: 'Wrap',
        holderAddress: wallet,
        tokenAddress: null,
        metadata: { kind: 'wrap', encrypted_amount_handle: HANDLE },
      }),
      evt({
        txHash: '0x6',
        logIndex: 1,
        eventType: 'Unwrap',
        holderAddress: wallet,
        tokenAddress: null,
        metadata: { kind: 'unwrap', encrypted_amount_handle: HANDLE },
      }),
    ]);

    const { items } = await useCase.execute(userId);

    expect(items.map((i) => i.type)).toEqual([
      'buy',
      'sell',
      'sell-queued',
      'yield',
      'wrap',
      'unwrap',
    ]);
  });

  it('exposes the encrypted amount handle on wrap rows via metadata', async () => {
    taxRepo.setHolderEvents(wallet, [
      evt({
        txHash: '0xwrap',
        eventType: 'Wrap',
        holderAddress: wallet,
        tokenAddress: null,
        metadata: { kind: 'wrap', encrypted_amount_handle: HANDLE },
      }),
    ]);

    const { items } = await useCase.execute(userId);
    expect(items).toHaveLength(1);
    const [row] = items;
    expect(row.type).toBe('wrap');
    expect(row.amount).toBeNull(); // encrypted — never plaintext on the wire
    expect(row.metadata).toMatchObject({
      kind: 'wrap',
      encrypted_amount_handle: HANDLE,
    });
    expect(row.tx_hash).toBe('0xwrap');
  });

  it('marks queued sells with status "queued" and instant ones "confirmed"', async () => {
    taxRepo.setHolderEvents(wallet, [
      evt({
        txHash: '0xQ',
        eventType: 'Disposition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: { kind: 'queued' },
      }),
      evt({
        txHash: '0xI',
        logIndex: 2,
        eventType: 'Disposition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: { kind: 'instant' },
      }),
    ]);

    const { items } = await useCase.execute(userId);
    const queued = items.find((i) => i.type === 'sell-queued');
    const instant = items.find((i) => i.type === 'sell');
    expect(queued?.status).toBe('queued');
    expect(instant?.status).toBe('confirmed');
  });

  it('treats Subscription.Redeemed escalated-to-queue as sell-queued (matches RedemptionQueue.QueueClaimed shape)', async () => {
    taxRepo.setHolderEvents(wallet, [
      evt({
        txHash: '0xE',
        eventType: 'Disposition',
        holderAddress: wallet,
        tokenAddress: '0xT',
        metadata: { kind: 'escalated_to_queue' },
      }),
    ]);
    const { items } = await useCase.execute(userId);
    expect(items[0].type).toBe('sell-queued');
    expect(items[0].status).toBe('queued');
  });

  it('paginates with has_more flag', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      evt({
        txHash: `0x${i}`,
        logIndex: i,
        eventType: 'Acquisition',
        holderAddress: wallet,
        tokenAddress: '0xT',
      }),
    );
    taxRepo.setHolderEvents(wallet, events);

    const page1 = await useCase.execute(userId, { limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const tail = await useCase.execute(userId, { limit: 2, offset: 4 });
    expect(tail.items).toHaveLength(1);
    expect(tail.has_more).toBe(false);
  });
});
