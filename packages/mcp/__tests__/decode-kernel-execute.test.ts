/**
 * Regression coverage for `decodeKernelExecuteSingleCall` — the
 * sibling-of-encoder added in 0.2.9 to power the `pathDDecodedCall`
 * echo field. Roundtrip-pins against `encodeKernelExecuteSingleCall`
 * so any future change to either side that drifts the byte layout
 * fails loud at test time.
 */

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  KERNEL_V3_SINGLE_CALL_MODE_DEFAULT,
  decodeKernelExecuteSingleCall,
  encodeKernelExecuteSingleCall,
} from '../src/clients/kernel-encoder.js';

const TARGET = '0x39D49B2614d24ba189B613bEAa903d829A73eA9e' as const;
const VALUE = 0n;
const INNER = ('0x' + 'd29b624b' + 'aa'.repeat(124)) as `0x${string}`;

describe('decodeKernelExecuteSingleCall — encode→decode roundtrip', () => {
  it('roundtrips target + value + innerCallData byte-for-byte', () => {
    const encoded = encodeKernelExecuteSingleCall({
      target: TARGET,
      value: VALUE,
      callData: INNER,
    });
    const decoded = decodeKernelExecuteSingleCall(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.target.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(decoded?.value).toBe(VALUE);
    expect(decoded?.innerCallData.toLowerCase()).toBe(INNER.toLowerCase());
    expect(decoded?.mode).toBe(KERNEL_V3_SINGLE_CALL_MODE_DEFAULT);
  });

  it('roundtrips with non-zero value', () => {
    const encoded = encodeKernelExecuteSingleCall({
      target: TARGET,
      value: 12345n,
      callData: '0x' as `0x${string}`,
    });
    const decoded = decodeKernelExecuteSingleCall(encoded);
    expect(decoded?.value).toBe(12345n);
  });

  it('returns null when the input is not a valid execute(...) call', () => {
    // Random hex that doesn't decode as execute(bytes32, bytes)
    expect(decodeKernelExecuteSingleCall(('0x' + 'aa'.repeat(100)) as `0x${string}`)).toBeNull();
  });

  it('returns null when mode word is non-zero (batch / delegate / try)', () => {
    // Construct an execute(...) call by hand with mode = 0x0100...0
    // (batch-call). The decoder MUST refuse to decode the packed
    // single-call layout from a non-default mode payload.
    //
    const batchMode = ('0x01' + '00'.repeat(31)) as `0x${string}`;
    const encoded = encodeFunctionData({
      abi: parseAbi(['function execute(bytes32 mode, bytes calldata executionCalldata)']),
      functionName: 'execute',
      args: [batchMode, INNER],
    });
    expect(decodeKernelExecuteSingleCall(encoded)).toBeNull();
  });
});
