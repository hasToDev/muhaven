/**
 * Wave 5 Path D Slice 1 Commit 3.5 — unit tests for the Kernel v3.1
 * single-call execute encoder + PermissionValidator session-key
 * signature builder + nonce-key composer. Pure functions; no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  concatHex,
  decodeFunctionData,
  pad,
  toFunctionSelector,
  type Hex,
} from 'viem';
import {
  KERNEL_EXECUTE_ABI,
  KERNEL_V3_SINGLE_CALL_MODE_DEFAULT,
  buildKernelSessionKeySignature,
  composeKernelV3NonceKey,
  encodeKernelExecuteSingleCall,
} from '../src/clients/kernel-encoder.js';

const TARGET = '0x1d6C140204F21835F1AF2A0615826A333827d946' as const; // USYC stage
const PERMISSION_ID = '0xdeadbeef' as `0x${string}`;
const ECDSA_SIG =
  ('0x' + 'ab'.repeat(65)) as `0x${string}`;
const INNER_CALLDATA = ('0xa9059cbb' + '00'.repeat(64)) as `0x${string}`;
// ^ transfer(address,uint256) selector + two zero-padded zero args; the
//   contents are irrelevant — we just need an inner blob to wrap.

describe('encodeKernelExecuteSingleCall', () => {
  it('emits the kernel.execute selector + mode + packed inner', () => {
    const encoded = encodeKernelExecuteSingleCall({
      target: TARGET,
      value: 0n,
      callData: INNER_CALLDATA,
    });

    // First 4 bytes must be the execute selector (keccak256('execute(bytes32,bytes)') first 4 bytes).
    const executeSelector = toFunctionSelector(
      'function execute(bytes32 mode, bytes calldata executionCalldata)',
    );
    expect(encoded.slice(0, 10)).toBe(executeSelector);

    // Roundtrip via decodeFunctionData (proves mode + inner came through).
    const decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: encoded });
    expect(decoded.functionName).toBe('execute');
    expect(decoded.args[0]).toBe(KERNEL_V3_SINGLE_CALL_MODE_DEFAULT);
    // The inner is packed (NOT abi.encoded), so we can't decodeAbiParameters
    // it directly back to (address, uint256, bytes). Instead assert the
    // packed shape: 20 bytes target + 32 bytes value + inner.
    const innerHex = decoded.args[1] as `0x${string}`;
    const targetLow = TARGET.slice(2).toLowerCase();
    expect(innerHex.slice(2, 2 + 40).toLowerCase()).toBe(targetLow);
    const valueHex = innerHex.slice(2 + 40, 2 + 40 + 64);
    expect(valueHex).toBe('00'.repeat(32));
    const innerCallDataHex = innerHex.slice(2 + 40 + 64);
    expect(`0x${innerCallDataHex}`.toLowerCase()).toBe(INNER_CALLDATA.toLowerCase());
  });

  it('uses the all-zero mode for single+default execType', () => {
    const encoded = encodeKernelExecuteSingleCall({
      target: TARGET,
      value: 0n,
      callData: INNER_CALLDATA,
    });
    const decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: encoded });
    // All 32 zero bytes = 64 zero hex chars after `0x`.
    expect((decoded.args[0] as string).slice(2)).toBe('00'.repeat(32));
  });

  it('passes through a non-zero value field in the packed inner', () => {
    const encoded = encodeKernelExecuteSingleCall({
      target: TARGET,
      value: 0xdeadbeefn,
      callData: '0x',
    });
    const decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: encoded });
    const innerHex = decoded.args[1] as `0x${string}`;
    // value is bytes 21..52 (32 bytes after the 20-byte target).
    const valueHex = innerHex.slice(2 + 40, 2 + 40 + 64);
    // 0xdeadbeef as uint256 in big-endian = 28 leading zero bytes then `deadbeef`.
    expect(valueHex.endsWith('deadbeef')).toBe(true);
    expect(valueHex.slice(0, valueHex.length - 8)).toBe('0'.repeat(valueHex.length - 8));
  });
});

describe('buildKernelSessionKeySignature (PermissionValidator shape)', () => {
  it('emits 0xff prefix + 65-byte ECDSA signature (66 bytes total)', () => {
    const sig = buildKernelSessionKeySignature({ ecdsaSignature: ECDSA_SIG });
    // 1 (prefix) + 65 (ECDSA) = 66 bytes = 132 hex chars.
    expect(sig.length).toBe(2 + 132);
    expect(sig.slice(0, 4)).toBe('0xff');
    expect(sig.slice(4).toLowerCase()).toBe(ECDSA_SIG.slice(2).toLowerCase());
  });

  it('does NOT include a validator address (Commit 3.5 review correction — H-1)', () => {
    // The pre-3.5 shape was 0x01 + 20-byte validator + 65-byte ECDSA = 86
    // bytes. AI Engineer review identified that against ZeroDev's
    // PermissionValidator (toPermissionValidator.ts:104-119), the right
    // shape is 0xff + 65 bytes = 66 bytes with NO validator address —
    // the validator is identified via the nonce key composite instead.
    const sig = buildKernelSessionKeySignature({ ecdsaSignature: ECDSA_SIG });
    expect(sig.length).toBe(2 + 132); // 66 bytes, NOT 86
  });

  it('rejects malformed ECDSA signature (wrong length)', () => {
    expect(() =>
      buildKernelSessionKeySignature({
        ecdsaSignature: ('0x' + 'ab'.repeat(64)) as `0x${string}`, // 64 bytes, not 65
      }),
    ).toThrow(/ecdsaSignature/);
  });
});

describe('composeKernelV3NonceKey (Kernel v3.1 PermissionValidator nonce composite)', () => {
  it('packs mode + type + permissionId + customKey into a 24-byte bigint', () => {
    const key = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      customKey: 0n,
    });
    // Reconstruct manually and compare.
    const expected = pad(
      concatHex([
        '0x00' as Hex, // VALIDATOR_MODE_DEFAULT
        '0x02' as Hex, // VALIDATOR_TYPE_PERMISSION
        pad(PERMISSION_ID, { size: 20, dir: 'right' }), // permissionId padded right
        pad('0x00' as Hex, { size: 2 }), // customKey
      ]),
      { size: 24 },
    );
    expect(key).toBe(BigInt(expected));
  });

  it('honours a non-zero customKey', () => {
    const key = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      customKey: 0x42n,
    });
    const expected = pad(
      concatHex([
        '0x00' as Hex,
        '0x02' as Hex,
        pad(PERMISSION_ID, { size: 20, dir: 'right' }),
        pad('0x42' as Hex, { size: 2 }),
      ]),
      { size: 24 },
    );
    expect(key).toBe(BigInt(expected));
  });

  it('produces a DIFFERENT key than the SUDO-validator slot (key=0)', () => {
    // A SUDO-validator call uses key=0; PermissionValidator's composite
    // MUST differ for the bundler to route through the right nonce slot.
    const key = composeKernelV3NonceKey({ permissionId: PERMISSION_ID });
    expect(key).not.toBe(0n);
    // Non-zero by construction (validator_type byte = 0x02 ≠ 0).
    expect(key).toBeGreaterThan(0n);
  });

  it('rejects malformed permissionId', () => {
    expect(() =>
      composeKernelV3NonceKey({
        permissionId: '0xdead' as `0x${string}`, // 2 bytes, not 4
      }),
    ).toThrow(/permissionId/);
  });

  it('rejects out-of-range customKey', () => {
    expect(() =>
      composeKernelV3NonceKey({
        permissionId: PERMISSION_ID,
        customKey: 1n << 17n, // > 0xffff
      }),
    ).toThrow(/customKey/);
  });
});
