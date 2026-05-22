/**
 * Wave 5 Path D Slice 1 Commit 3 — unit tests for the broker-client
 * preflight helpers. The transport-level behaviour of the broker-client
 * (socket connect, request/response framing) is covered by
 * daemon-lifecycle.test.ts; this file pins the pure-function pieces
 * (semverGte) + the preflight result-shape contract.
 *
 * preflight() itself isn't easily unit-tested without spawning the
 * daemon — the existing test harness's pattern is to exercise IPC via
 * daemon-lifecycle, not by mocking node:net. We rely on that integration
 * coverage for the round-trip; this file pins ONLY the semver compare
 * (a tight pure function with off-by-one risk).
 */
import { describe, it, expect } from 'vitest';
import { semverGte, BrokerClientError } from '../src/clients/broker-client.js';

describe('semverGte', () => {
  it('returns true when a == b', () => {
    expect(semverGte('0.4.0', '0.4.0')).toBe(true);
    expect(semverGte('1.0.0', '1.0.0')).toBe(true);
    expect(semverGte('10.20.30', '10.20.30')).toBe(true);
  });

  it('returns true when a > b at major', () => {
    expect(semverGte('1.0.0', '0.9.99')).toBe(true);
    expect(semverGte('2.0.0', '1.99.99')).toBe(true);
  });

  it('returns true when a > b at minor', () => {
    expect(semverGte('0.5.0', '0.4.99')).toBe(true);
    expect(semverGte('0.4.0', '0.3.99')).toBe(true);
  });

  it('returns true when a > b at patch', () => {
    expect(semverGte('0.4.1', '0.4.0')).toBe(true);
    expect(semverGte('0.4.99', '0.4.0')).toBe(true);
  });

  it('returns false when a < b at major', () => {
    expect(semverGte('0.99.99', '1.0.0')).toBe(false);
    expect(semverGte('1.99.99', '2.0.0')).toBe(false);
  });

  it('returns false when a < b at minor', () => {
    expect(semverGte('0.3.99', '0.4.0')).toBe(false);
    expect(semverGte('0.3.0', '0.4.0')).toBe(false);
  });

  it('returns false when a < b at patch', () => {
    expect(semverGte('0.4.0', '0.4.1')).toBe(false);
    expect(semverGte('0.4.0', '0.4.99')).toBe(false);
  });

  it('compares numerically not lexically', () => {
    // 10 > 9 numerically; lexically '10' < '9' (would return wrong answer
    // if the impl used string compare).
    expect(semverGte('0.10.0', '0.9.99')).toBe(true);
    expect(semverGte('0.9.99', '0.10.0')).toBe(false);
    expect(semverGte('10.0.0', '9.99.99')).toBe(true);
  });

  it('throws BrokerClientError on malformed input (extra segment)', () => {
    expect(() => semverGte('0.4.0.1', '0.4.0')).toThrow(BrokerClientError);
  });

  it('throws BrokerClientError on malformed input (pre-release suffix)', () => {
    expect(() => semverGte('0.4.0-rc1', '0.4.0')).toThrow(BrokerClientError);
  });

  it('throws BrokerClientError on malformed input (missing segment)', () => {
    expect(() => semverGte('0.4', '0.4.0')).toThrow(BrokerClientError);
    expect(() => semverGte('0.4.0', '0.4')).toThrow(BrokerClientError);
  });

  it('throws BrokerClientError on non-numeric segments', () => {
    expect(() => semverGte('0.4.x', '0.4.0')).toThrow(BrokerClientError);
    expect(() => semverGte('a.b.c', '0.4.0')).toThrow(BrokerClientError);
  });

  it('error carries protocol_error code (so caller can map cleanly)', () => {
    try {
      semverGte('not-semver', '0.4.0');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerClientError);
      expect((err as BrokerClientError).code).toBe('protocol_error');
    }
  });

  // SemVer 2.0 §2: numeric identifiers MUST NOT have leading zeros (CR M-1).
  it('rejects leading zeros in major segment', () => {
    expect(() => semverGte('01.0.0', '0.4.0')).toThrow(BrokerClientError);
    expect(() => semverGte('0.4.0', '01.0.0')).toThrow(BrokerClientError);
  });

  it('rejects leading zeros in minor segment', () => {
    expect(() => semverGte('0.04.0', '0.4.0')).toThrow(BrokerClientError);
    expect(() => semverGte('0.4.0', '0.04.0')).toThrow(BrokerClientError);
  });

  it('rejects leading zeros in patch segment', () => {
    expect(() => semverGte('0.4.00', '0.4.0')).toThrow(BrokerClientError);
    expect(() => semverGte('0.4.01', '0.4.0')).toThrow(BrokerClientError);
  });

  it('still accepts single "0" segments (canonical zero)', () => {
    // 0 alone is valid SemVer; 00 is not.
    expect(semverGte('0.0.0', '0.0.0')).toBe(true);
    expect(semverGte('0.4.0', '0.4.0')).toBe(true);
  });
});
