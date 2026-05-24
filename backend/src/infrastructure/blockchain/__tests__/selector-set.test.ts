import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, toEventSelector, type Hex } from 'viem';
import { decodePermissionInstallFromSelectorSet } from '../selector-set.js';

const TOPIC0 = toEventSelector('SelectorSet(bytes4,bytes21,bool)');
const SELECTOR = '0xe9ae5c53' as `0x${string}`; // kernel execute(bytes32,bytes)

/** Build a SelectorSet log's `data`+`topics` (all three args non-indexed). */
function selectorSetLog(
  vId: `0x${string}`,
  allowed: boolean,
  selector: `0x${string}` = SELECTOR,
): { data: Hex; topics: [Hex] } {
  const data = encodeAbiParameters(
    [{ type: 'bytes4' }, { type: 'bytes21' }, { type: 'bool' }],
    [selector, vId, allowed],
  );
  return { data, topics: [TOPIC0] };
}

/** Compose a 21-byte validationId: `<typeByte><permissionId(4)><16 zero bytes>`. */
function vId(typeByte: string, permissionId: `0x${string}`): `0x${string}` {
  return `0x${typeByte}${permissionId.slice(2)}${'0'.repeat(32)}` as `0x${string}`;
}

describe('decodePermissionInstallFromSelectorSet', () => {
  it('decodes a permission install (type 0x02) → permissionId from vId[1..5)', () => {
    const out = decodePermissionInstallFromSelectorSet(selectorSetLog(vId('02', '0xa2e7dd60'), true));
    expect(out).not.toBeNull();
    expect(out!.permissionId).toBe('0xa2e7dd60');
    expect(out!.selector).toBe('0xe9ae5c53');
  });

  it('returns null when allowed=false (selector unbind, not an install)', () => {
    expect(decodePermissionInstallFromSelectorSet(selectorSetLog(vId('02', '0xa2e7dd60'), false))).toBeNull();
  });

  it('returns null for non-permission validation types (sudo 0x00 / secondary 0x01)', () => {
    expect(decodePermissionInstallFromSelectorSet(selectorSetLog(vId('00', '0xa2e7dd60'), true))).toBeNull();
    expect(decodePermissionInstallFromSelectorSet(selectorSetLog(vId('01', '0xa2e7dd60'), true))).toBeNull();
  });

  it('returns null for a SelectorSet bound to a NON-execute selector (signal must be exact)', () => {
    // SecEng defense-in-depth: a same-kernel, same-permissionId bind to a
    // different action selector must NOT flip enable_status.
    const out = decodePermissionInstallFromSelectorSet(
      selectorSetLog(vId('02', '0xa2e7dd60'), true, '0xdeadbeef'),
    );
    expect(out).toBeNull();
  });

  it('returns null for a foreign topic0 / undecodable log (no throw)', () => {
    expect(
      decodePermissionInstallFromSelectorSet({
        data: '0x',
        topics: [('0x' + 'a'.repeat(64)) as Hex],
      }),
    ).toBeNull();
  });

  it('lower-cases the decoded permissionId', () => {
    const out = decodePermissionInstallFromSelectorSet(selectorSetLog(vId('02', '0xA2E7DD60'), true));
    expect(out!.permissionId).toBe('0xa2e7dd60');
  });
});
