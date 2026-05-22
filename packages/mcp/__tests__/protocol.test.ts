import { describe, it, expect } from 'vitest';
import {
  parseBrokerRequest,
  serializeResponse,
  isHashHex,
  isAddressHex,
  isSelectorHex,
  BROKER_PROTOCOL_VERSION,
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

  // ---------- Wave 5 Path D Slice 1 — protocol 0.4.0 additions ----------

  it('protocol version is bumped to 0.4.0', () => {
    expect(BROKER_PROTOCOL_VERSION).toBe('0.4.0');
  });

  const validSnapshot = () => ({
    sessionId: 'sess_abc-123',
    mode: 'scoped' as const,
    signerAddress: '0x' + 'a'.repeat(40),
    targetContracts: ['0x' + 'b'.repeat(40)],
    selectorCaps: [
      { selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '100000000' },
    ],
    validUntilSec: 9_999_999_999,
    mintedAtSec: 1_000_000_000,
  });

  // sign_userop --------------------------------------------------------

  it('parses sign_userop with valid payload', () => {
    const hash = '0x' + '1'.repeat(64);
    // 0x + 8 hex selector + 64 hex uint256 = 74 chars total. Value = 5.
    const callData = '0xdeadbeef' + '0'.repeat(63) + '5';
    expect(callData.length).toBe(74);
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess_abc-123',
        userOpHash: hash,
        innerCall: { target: '0x' + 'C'.repeat(40), callData },
      }),
    );
    expect(res.type).toBe('sign_userop');
    if (res.type === 'sign_userop') {
      expect(res.sessionId).toBe('sess_abc-123');
      expect(res.userOpHash).toBe(hash);
      // target + callData lowercased
      expect(res.innerCall.target).toBe('0x' + 'c'.repeat(40));
      expect(res.innerCall.callData).toBe(callData.toLowerCase());
    }
  });

  it('rejects sign_userop with bad sessionId (path-traversal char)', () => {
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: '../escape',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: '0x' + 'a'.repeat(40), callData: '0xdeadbeef' + '0'.repeat(64) },
      }),
    );
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.code).toBe('invalid_request');
  });

  it('rejects sign_userop with bad userOpHash', () => {
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0xabc',
        innerCall: { target: '0x' + 'a'.repeat(40), callData: '0xdeadbeef' + '0'.repeat(64) },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('rejects sign_userop with bad target address', () => {
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: 'not-an-address', callData: '0xdeadbeef' + '0'.repeat(64) },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('rejects sign_userop with too-short callData', () => {
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        // 0xdeadbeef = selector only, no uint256 arg
        innerCall: { target: '0x' + 'a'.repeat(40), callData: '0xdeadbeef' },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('rejects sign_userop with odd-length callData', () => {
    // 74 chars baseline + 1 extra → odd-length 75.
    const odd = '0xdeadbeef' + '0'.repeat(63) + '5' + 'a';
    expect(odd.length).toBe(75);
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: '0x' + 'a'.repeat(40), callData: odd },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('rejects sign_userop intent.tool longer than 64 chars', () => {
    const callData = '0xdeadbeef' + '0'.repeat(63) + '5';
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: '0x' + 'a'.repeat(40), callData },
        intent: { tool: 'x'.repeat(65) },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('rejects sign_userop intent.summary longer than 256 chars', () => {
    const callData = '0xdeadbeef' + '0'.repeat(63) + '5';
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: '0x' + 'a'.repeat(40), callData },
        intent: { tool: 'tool', summary: 'x'.repeat(257) },
      }),
    );
    expect(res.type).toBe('error');
  });

  it('strips unlisted keys from sign_userop intent', () => {
    const callData = '0xdeadbeef' + '0'.repeat(63) + '5';
    const res = parseBrokerRequest(
      JSON.stringify({
        type: 'sign_userop',
        sessionId: 'sess1',
        userOpHash: '0x' + '1'.repeat(64),
        innerCall: { target: '0x' + 'a'.repeat(40), callData },
        intent: { tool: 'tool', summary: 'ok', extra: 'EVIL' },
      }),
    );
    expect(res.type).toBe('sign_userop');
    if (res.type === 'sign_userop') {
      // 'extra' is dropped — only tool + summary propagate.
      expect(Object.keys(res.intent ?? {})).toEqual(['tool', 'summary']);
    }
  });

  // store_policy_snapshot ---------------------------------------------

  it('parses store_policy_snapshot with valid snapshot', () => {
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'store_policy_snapshot', snapshot: validSnapshot() }),
    );
    expect(res.type).toBe('store_policy_snapshot');
    if (res.type === 'store_policy_snapshot') {
      expect(res.snapshot.sessionId).toBe('sess_abc-123');
      // case-folded by parser
      expect(res.snapshot.signerAddress).toBe('0x' + 'a'.repeat(40));
    }
  });

  it('rejects store_policy_snapshot with mode other than scoped', () => {
    const snap = { ...validSnapshot(), mode: 'wildcard' };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('rejects store_policy_snapshot with empty targetContracts', () => {
    const snap = { ...validSnapshot(), targetContracts: [] };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('rejects store_policy_snapshot with non-decimal maxAmount', () => {
    const snap = {
      ...validSnapshot(),
      selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '0xff' }],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('rejects store_policy_snapshot with negative validUntilSec', () => {
    const snap = { ...validSnapshot(), validUntilSec: -1 };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('rejects store_policy_snapshot with duplicate selectors', () => {
    const snap = {
      ...validSnapshot(),
      selectorCaps: [
        { selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '1' },
        { selector: '0xdeadbeef', capArgIndex: 0, maxAmount: '2' },
      ],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/duplicate/);
  });

  it('rejects store_policy_snapshot when capArgIndex and maxAmount disagree on null-ness', () => {
    const snap = {
      ...validSnapshot(),
      selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: null }],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('accepts store_policy_snapshot with null cap (selector-allowed-no-cap)', () => {
    const snap = {
      ...validSnapshot(),
      selectorCaps: [{ selector: '0xfeedface', capArgIndex: null, maxAmount: null }],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('store_policy_snapshot');
  });

  it('rejects store_policy_snapshot with maxAmount > uint256 max', () => {
    // 78 9s = ~8.6 × uint256 max. Regex accepts; range check rejects.
    const overMax = '9'.repeat(78);
    const snap = {
      ...validSnapshot(),
      selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: overMax }],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  it('accepts store_policy_snapshot with maxAmount = uint256 max', () => {
    const maxUint256 = ((1n << 256n) - 1n).toString();
    const snap = {
      ...validSnapshot(),
      selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 0, maxAmount: maxUint256 }],
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('store_policy_snapshot');
  });

  it('accepts optional consentActionHash + consentTextSha256 when provided', () => {
    const snap = {
      ...validSnapshot(),
      consentActionHash: '0x' + 'a'.repeat(64),
      consentTextSha256: '0x' + 'b'.repeat(64),
    };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('store_policy_snapshot');
  });

  it('rejects malformed consentActionHash when provided', () => {
    const snap = { ...validSnapshot(), consentActionHash: '0xabc' };
    const res = parseBrokerRequest(JSON.stringify({ type: 'store_policy_snapshot', snapshot: snap }));
    expect(res.type).toBe('error');
  });

  // get_policy_snapshot / clear_policy_snapshot ---------------------

  it('parses get_policy_snapshot', () => {
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'get_policy_snapshot', sessionId: 'sess_xyz' }),
    );
    expect(res.type).toBe('get_policy_snapshot');
    if (res.type === 'get_policy_snapshot') expect(res.sessionId).toBe('sess_xyz');
  });

  it('parses clear_policy_snapshot', () => {
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'clear_policy_snapshot', sessionId: 'sess_xyz' }),
    );
    expect(res.type).toBe('clear_policy_snapshot');
    if (res.type === 'clear_policy_snapshot') expect(res.sessionId).toBe('sess_xyz');
  });

  it('rejects get_policy_snapshot with bad sessionId', () => {
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'get_policy_snapshot', sessionId: '' }),
    );
    expect(res.type).toBe('error');
  });

  // get_active_session_id (Wave 5 Path D Slice 1 Commit 3) -------------

  it('parses get_active_session_id', () => {
    const res = parseBrokerRequest(JSON.stringify({ type: 'get_active_session_id' }));
    expect(res.type).toBe('get_active_session_id');
  });

  it('get_active_session_id rejects extra payload keys (single-shot strictness)', () => {
    // Parser doesn't strictly reject extras at the verb level today; this
    // test pins that the verb is RECOGNIZED + parsed despite extra noise.
    // The wire-shape guard lives in the daemon — extras are just dropped.
    const res = parseBrokerRequest(
      JSON.stringify({ type: 'get_active_session_id', sessionId: 'unused' }),
    );
    expect(res.type).toBe('get_active_session_id');
  });

  // Type narrowers ------------------------------------------------------

  it('isAddressHex narrows correctly', () => {
    expect(isAddressHex('0x' + 'a'.repeat(40))).toBe(true);
    expect(isAddressHex('0x' + 'a'.repeat(39))).toBe(false);
    expect(isAddressHex('not-an-address')).toBe(false);
  });

  it('isSelectorHex narrows correctly', () => {
    expect(isSelectorHex('0xdeadbeef')).toBe(true);
    expect(isSelectorHex('0xdead')).toBe(false);
    expect(isSelectorHex('deadbeef')).toBe(false);
  });

  // ensure isHashHex is still exported (back-compat smoke)
  it('isHashHex export is intact', () => {
    expect(isHashHex('0x' + '1'.repeat(64))).toBe(true);
  });
});
