import { describe, it, expect, vi } from 'vitest';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long';

import { PgAuditWriter, redactAuditErrorMessage } from '../pg-audit-writer.js';
import type { Db } from '../db.js';

function makeDbMock(): {
  db: Db;
  insertValuesMock: ReturnType<typeof vi.fn>;
  insertOnConflictMock: ReturnType<typeof vi.fn>;
  updateSetMock: ReturnType<typeof vi.fn>;
  updateWhereMock: ReturnType<typeof vi.fn>;
  selectRows: unknown[];
} {
  // Drizzle's fluent builder is a series of `then`-able chained methods.
  // We mock the leaf methods we exercise + chain them via objects that
  // return `this`-equivalents.
  //
  // insertInProgress now upserts: `.insert(...).values(...).onConflictDoUpdate(...)`,
  // so `.values()` returns the onConflict builder (NOT a resolved promise).
  const insertOnConflictMock = vi.fn().mockResolvedValue(undefined);
  const insertValuesMock = vi
    .fn()
    .mockReturnValue({ onConflictDoUpdate: insertOnConflictMock });
  const updateSetMock = vi.fn();
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  let selectRows: unknown[] = [];

  const updateBuilder = {
    set: updateSetMock.mockImplementation(() => ({ where: updateWhereMock })),
  };
  const insertBuilder = { values: insertValuesMock };

  const selectBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => Promise.resolve(selectRows)),
  };

  const db = {
    insert: vi.fn().mockReturnValue(insertBuilder),
    update: vi.fn().mockReturnValue(updateBuilder),
    select: vi.fn().mockReturnValue(selectBuilder),
  } as unknown as Db;

  return {
    db,
    insertValuesMock,
    insertOnConflictMock,
    updateSetMock,
    updateWhereMock,
    get selectRows() {
      return selectRows;
    },
    set selectRows(rows: unknown[]) {
      selectRows = rows;
    },
  } as ReturnType<typeof makeDbMock>;
}

describe('PgAuditWriter.insertInProgress', () => {
  it('lower-cases the address + serialises bigints to strings + sets status=in_progress', async () => {
    const { db, insertValuesMock } = makeDbMock();
    const writer = new PgAuditWriter(db);
    await writer.insertInProgress({
      tokenAddress: '0xAbCdEf0000000000000000000000000000000001',
      epochId: 42n,
      ratePerShare: 96_900n,
      encTotalYieldUsd6: 969_000_000n,
      navAtTimeUsd: '1.13',
      apyAtTimePercent: '3.13',
    });
    expect(insertValuesMock).toHaveBeenCalledOnce();
    const row = insertValuesMock.mock.calls[0][0];
    expect(row).toMatchObject({
      tokenAddress: '0xabcdef0000000000000000000000000000000001',
      epochId: '42',
      ratePerShare: '96900',
      encTotalYieldUsd6: '969000000',
      navAtTimeUsd: '1.13',
      apyAtTimePercent: '3.13',
      status: 'in_progress',
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('UPSERTs on (token, epoch) conflict — resets to in_progress + clears terminal fields (failed-fund resume)', async () => {
    // Regression for the duplicate-key-on-resume bug (surfaced by the first
    // prod FU-1 force tick): a prior failed fundEpoch leaves a `failure`
    // row, and the runner's back-fill resume re-`insertInProgress`es the
    // same epoch. Without the upsert this throws on `yld_dist_token_epoch_uniq`.
    const { db, insertOnConflictMock } = makeDbMock();
    const writer = new PgAuditWriter(db);
    await writer.insertInProgress({
      tokenAddress: '0xAbCdEf0000000000000000000000000000000007',
      epochId: 7n,
      ratePerShare: 9_215_635n,
      encTotalYieldUsd6: 1105n,
      navAtTimeUsd: '1.00',
      apyAtTimePercent: '3.13',
    });
    expect(insertOnConflictMock).toHaveBeenCalledOnce();
    const arg = insertOnConflictMock.mock.calls[0][0];
    // Conflict target is the (token_address, epoch_id) unique index.
    expect(Array.isArray(arg.target)).toBe(true);
    expect(arg.target).toHaveLength(2);
    // Reset to a clean in_progress retry; stale terminal/tx fields cleared.
    expect(arg.set.status).toBe('in_progress');
    expect(arg.set.ratePerShare).toBe('9215635');
    expect(arg.set.encTotalYieldUsd6).toBe('1105');
    expect(arg.set.errorClass).toBeNull();
    expect(arg.set.errorMessage).toBeNull();
    expect(arg.set.finishedAt).toBeNull();
    expect(arg.set.lastResumedAt).toBeNull();
    expect(arg.set.fundEpochTxHash).toBeNull();
    expect(arg.set.startedAt).toBeInstanceOf(Date);
  });
});

describe('PgAuditWriter.updateStatus', () => {
  it('lower-cases address + serialises epochId + only sets provided optional fields', async () => {
    const { db, updateSetMock } = makeDbMock();
    const writer = new PgAuditWriter(db);
    const finishedAt = new Date('2026-05-21T00:01:23Z');
    await writer.updateStatus(
      42n,
      '0xAbCdEf0000000000000000000000000000000001',
      'success',
      { fundEpochTxHash: '0xfeed', finishedAt },
    );
    expect(updateSetMock).toHaveBeenCalledWith({
      status: 'success',
      fundEpochTxHash: '0xfeed',
      finishedAt,
    });
  });

  it('skips undefined optional fields (does not stomp existing column values)', async () => {
    const { db, updateSetMock } = makeDbMock();
    const writer = new PgAuditWriter(db);
    await writer.updateStatus(
      42n,
      '0xabcdef0000000000000000000000000000000001',
      'snapshot_done',
    );
    expect(updateSetMock).toHaveBeenCalledWith({ status: 'snapshot_done' });
  });
});

describe('PgAuditWriter.findLatestUnresolved', () => {
  it('returns null when no row matches', async () => {
    const helper = makeDbMock();
    helper.selectRows = [];
    const writer = new PgAuditWriter(helper.db);
    const result = await writer.findLatestUnresolved(
      '0xabcdef0000000000000000000000000000000001',
    );
    expect(result).toBeNull();
  });

  it('maps numeric columns to bigints', async () => {
    const helper = makeDbMock();
    helper.selectRows = [
      {
        tokenAddress: '0xabcdef0000000000000000000000000000000001',
        epochId: '42',
        ratePerShare: '96900',
        encTotalYieldUsd6: '969000000',
        status: 'in_progress',
        fundEpochTxHash: null,
      },
    ];
    const writer = new PgAuditWriter(helper.db);
    const result = await writer.findLatestUnresolved(
      '0xAbCdEf0000000000000000000000000000000001',
    );
    expect(result).toEqual({
      tokenAddress: '0xabcdef0000000000000000000000000000000001',
      epochId: 42n,
      ratePerShare: 96_900n,
      encTotalYieldUsd6: 969_000_000n,
      status: 'in_progress',
      fundEpochTxHash: null,
    });
  });

  it('surfaces fundEpochTxHash when set (funded_no_audit resume input)', async () => {
    const helper = makeDbMock();
    helper.selectRows = [
      {
        tokenAddress: '0xabc',
        epochId: '1',
        ratePerShare: '100',
        encTotalYieldUsd6: '1000',
        status: 'funded_no_audit',
        fundEpochTxHash: '0xfeedbeef',
      },
    ];
    const writer = new PgAuditWriter(helper.db);
    const result = await writer.findLatestUnresolved('0xabc');
    expect(result?.fundEpochTxHash).toBe('0xfeedbeef');
    expect(result?.status).toBe('funded_no_audit');
  });
});

describe('redactAuditErrorMessage (Security H-1)', () => {
  it('redacts 64-hex tx hashes / FHE handles', () => {
    const msg = 'reverted at 0x' + 'a'.repeat(64) + ' inside fundEpoch';
    expect(redactAuditErrorMessage(msg)).toBe('reverted at 0x…tx inside fundEpoch');
  });

  it('redacts 40-hex addresses', () => {
    const msg = 'NotOperator(0x' + 'b'.repeat(40) + ')';
    expect(redactAuditErrorMessage(msg)).toBe('NotOperator(0x…addr)');
  });

  it('redacts base64-shaped opaque blobs', () => {
    const msg = 'opaque QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2= tail';
    expect(redactAuditErrorMessage(msg)).toMatch(/\[…opaque\]/);
  });

  it('truncates to MAX_ERROR_MESSAGE_LEN', () => {
    const msg = 'x'.repeat(2000);
    expect(redactAuditErrorMessage(msg).length).toBeLessThanOrEqual(1024);
  });

  it('writes redacted errorMessage through updateStatus', async () => {
    const { db, updateSetMock } = makeDbMock();
    const writer = new PgAuditWriter(db);
    await writer.updateStatus(1n, '0xabc', 'failure', {
      errorMessage: 'NotOperator(0x' + 'c'.repeat(40) + ')',
    });
    const setArg = updateSetMock.mock.calls[0][0] as { errorMessage: string };
    expect(setArg.errorMessage).toBe('NotOperator(0x…addr)');
  });
});
