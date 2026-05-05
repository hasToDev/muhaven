import { describe, it, expect } from 'vitest';
import {
  parseBrokerRequest,
  serializeResponse,
  isHashHex,
} from '../src/broker/protocol.js';

describe('broker protocol parser', () => {
  it('rejects non-JSON', () => {
    const res = parseBrokerRequest('not-json');
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('invalid_request');
  });

  it('rejects null body', () => {
    const res = parseBrokerRequest('null');
    expect(res.type).toBe('error');
  });

  it('parses hello', () => {
    const res = parseBrokerRequest(JSON.stringify({ type: 'hello' }));
    expect(res.type).toBe('hello');
  });

  it('parses sign_hash with valid hex', () => {
    const hash = '0x' + 'a'.repeat(64);
    const res = parseBrokerRequest(JSON.stringify({ type: 'sign_hash', hash }));
    expect(res.type).toBe('sign_hash');
    if (res.type === 'sign_hash') expect(res.hash).toBe(hash);
  });

  it('rejects sign_hash with bad hash', () => {
    const res = parseBrokerRequest(JSON.stringify({ type: 'sign_hash', hash: '0xabc' }));
    expect(res.type).toBe('error');
  });

  it('rejects sign_hash with malformed intent', () => {
    const hash = '0x' + 'b'.repeat(64);
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'sign_hash', hash, intent: { tool: 123 } }),
    );
    expect(res.type).toBe('error');
  });

  it('parses store_jwt with JWT-shaped body', () => {
    const jwt = 'aaa.bbb.ccc';
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_jwt', jwt }));
    expect(res.type).toBe('store_jwt');
    if (res.type === 'store_jwt') expect(res.jwt).toBe(jwt);
  });

  it('rejects store_jwt with non-JWT shape', () => {
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_jwt', jwt: 'not-a-jwt' }));
    expect(res.type).toBe('error');
  });

  it('rejects store_jwt with negative expiresAtSec', () => {
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'store_jwt', jwt: 'a.b.c', expiresAtSec: -1 }),
    );
    expect(res.type).toBe('error');
  });

  it('parses get_jwt + clear_jwt', () => {
    expect(parseBrokerRequest(JSON.stringify({ type: 'get_jwt' })).type).toBe('get_jwt');
    expect(parseBrokerRequest(JSON.stringify({ type: 'clear_jwt' })).type).toBe('clear_jwt');
  });

  it('rejects unknown verb', () => {
    const res = parseBrokerRequest(JSON.stringify({ type: 'evil' }));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('unsupported_type');
  });

  it('isHashHex narrows correctly', () => {
    expect(isHashHex('0x' + '1'.repeat(64))).toBe(true);
    expect(isHashHex('0x' + 'g'.repeat(64))).toBe(false);
    expect(isHashHex('0x' + '1'.repeat(63))).toBe(false);
    expect(isHashHex(123)).toBe(false);
  });

  it('serializeResponse appends newline', () => {
    const out = serializeResponse({ type: 'clear_jwt', cleared: true });
    expect(out).toMatch(/\n$/);
    expect(JSON.parse(out)).toEqual({ type: 'clear_jwt', cleared: true });
  });
});
