import { describe, it, expect } from 'vitest';
import { extractPgErrorCode, isPgUniqueViolation, PG_ERROR_CODES } from '../pg-errors.js';

describe('pg-errors', () => {
  describe('extractPgErrorCode', () => {
    it('returns undefined for null / undefined / primitive inputs', () => {
      expect(extractPgErrorCode(null)).toBeUndefined();
      expect(extractPgErrorCode(undefined)).toBeUndefined();
      expect(extractPgErrorCode('23505')).toBeUndefined();
      expect(extractPgErrorCode(42)).toBeUndefined();
      expect(extractPgErrorCode(true)).toBeUndefined();
    });

    it('returns the top-level `.code` (node-postgres / raw drizzle shape)', () => {
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      expect(extractPgErrorCode(err)).toBe('23505');
    });

    it('walks .cause.code (DrizzleQueryError future wrap shape)', () => {
      const inner = Object.assign(new Error('inner'), { code: '23505' });
      const outer = Object.assign(new Error('drizzle wrap'), { cause: inner });
      expect(extractPgErrorCode(outer)).toBe('23505');
    });

    it('walks .driverError.code (alternative wrap shape)', () => {
      const driver = { code: '23503' };
      const outer = { driverError: driver };
      expect(extractPgErrorCode(outer)).toBe('23503');
    });

    it('prefers top-level .code over .cause.code when both present', () => {
      const inner = { code: '23503' };
      const outer = { code: '23505', cause: inner };
      expect(extractPgErrorCode(outer)).toBe('23505');
    });

    it('returns undefined when no .code present at any level', () => {
      expect(extractPgErrorCode(new Error('no code'))).toBeUndefined();
      expect(extractPgErrorCode({ cause: { message: 'no code here either' } })).toBeUndefined();
    });

    it('returns undefined for non-string code values', () => {
      const err = { code: 23505 }; // number, not string
      expect(extractPgErrorCode(err)).toBeUndefined();
    });
  });

  describe('isPgUniqueViolation', () => {
    it('returns true for 23505 at top level', () => {
      expect(isPgUniqueViolation({ code: '23505' })).toBe(true);
    });

    it('returns true for 23505 in cause chain', () => {
      expect(isPgUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    });

    it('returns false for non-23505 codes (FK / check violations)', () => {
      expect(isPgUniqueViolation({ code: '23503' })).toBe(false);
      expect(isPgUniqueViolation({ code: '23514' })).toBe(false);
      expect(isPgUniqueViolation({ code: '08006' })).toBe(false);
    });

    it('returns false for null / undefined / no-code errors', () => {
      expect(isPgUniqueViolation(null)).toBe(false);
      expect(isPgUniqueViolation(undefined)).toBe(false);
      expect(isPgUniqueViolation(new Error('no code'))).toBe(false);
    });

    it('PG_ERROR_CODES.UNIQUE_VIOLATION is the canonical string', () => {
      expect(PG_ERROR_CODES.UNIQUE_VIOLATION).toBe('23505');
    });
  });
});
