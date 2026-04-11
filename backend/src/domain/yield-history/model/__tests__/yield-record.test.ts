import { describe, it, expect } from 'vitest';
import { YieldRecord, type YieldRecordParams } from '../yield-record.js';

function makeYieldRecordParams(overrides?: Partial<YieldRecordParams>): YieldRecordParams {
  return {
    id: 'yield-1',
    userId: 'user-1',
    distributionId: 1,
    escrowId: 'escrow-1',
    tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
    amount: '100.50',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('YieldRecord', () => {
  describe('constructor', () => {
    it('assigns all required fields', () => {
      const params = makeYieldRecordParams();
      const record = new YieldRecord(params);
      expect(record.id).toBe(params.id);
      expect(record.userId).toBe(params.userId);
      expect(record.distributionId).toBe(params.distributionId);
      expect(record.tokenAddress).toBe(params.tokenAddress);
      expect(record.status).toBe('pending');
    });

    it('leaves optional fields undefined when not provided', () => {
      const record = new YieldRecord(makeYieldRecordParams({
        escrowId: undefined,
        amount: undefined,
        claimedAt: undefined,
      }));
      expect(record.escrowId).toBeUndefined();
      expect(record.amount).toBeUndefined();
      expect(record.claimedAt).toBeUndefined();
    });
  });

  describe('markClaimable', () => {
    it('transitions from pending to claimable', () => {
      const record = new YieldRecord(makeYieldRecordParams({ status: 'pending' }));
      record.markClaimable();
      expect(record.status).toBe('claimable');
    });
  });

  describe('markClaimed', () => {
    it('transitions to claimed and sets claimedAt', () => {
      const record = new YieldRecord(makeYieldRecordParams({ status: 'claimable' }));
      record.markClaimed();
      expect(record.status).toBe('claimed');
      expect(record.claimedAt).toBeInstanceOf(Date);
    });
  });

  describe('markExpired', () => {
    it('transitions to expired', () => {
      const record = new YieldRecord(makeYieldRecordParams({ status: 'pending' }));
      record.markExpired();
      expect(record.status).toBe('expired');
    });
  });
});
