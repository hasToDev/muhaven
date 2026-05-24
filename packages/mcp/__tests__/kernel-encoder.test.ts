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
  KERNEL_V3_CURRENT_NONCE_ABI,
  KERNEL_V3_SELECTOR_SET_ABI,
  KERNEL_V3_SINGLE_CALL_MODE_DEFAULT,
  buildKernelSessionKeySignature,
  composeKernelV3NonceKey,
  encodeKernelExecuteSingleCall,
  wrapEnableModeSignature,
} from '../src/clients/kernel-encoder.js';
// devDep import — the package root barrels the ep0_7 variant. The
// byte-equality regression below imports the canonical implementation
// and asserts our `wrapEnableModeSignature` emits IDENTICAL bytes for
// every fixture. If ZeroDev rotates the encoder shape in a future SDK
// release, this test fails and the operator updates the wrapper.
import { getEncodedPluginsData } from '@zerodev/sdk';

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

  // ── Wave 5 Option D Commit 3 — MODE.ENABLE byte-0 toggle ────────────

  it('mode=enable flips byte 0 from 0x00 to 0x01 (other bytes identical)', () => {
    const defaultKey = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      mode: 'default',
    });
    const enableKey = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      mode: 'enable',
    });
    // 24 bytes → mode=enable adds 0x01 in the MSB of a 24-byte composite.
    // That MSB shift = 2^((24-1)*8) = 2^184. Bytes 1..23 are identical.
    expect(enableKey - defaultKey).toBe(1n << 184n);
  });

  it('mode defaulted to default when omitted (backwards-compatibility)', () => {
    const explicit = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      mode: 'default',
    });
    const omitted = composeKernelV3NonceKey({ permissionId: PERMISSION_ID });
    expect(explicit).toBe(omitted);
  });

  it('mode=enable + non-zero customKey: both effects compose', () => {
    const key = composeKernelV3NonceKey({
      permissionId: PERMISSION_ID,
      mode: 'enable',
      customKey: 0x42n,
    });
    const expected = pad(
      concatHex([
        '0x01' as Hex, // VALIDATOR_MODE_ENABLE
        '0x02' as Hex,
        pad(PERMISSION_ID, { size: 20, dir: 'right' }),
        pad('0x42' as Hex, { size: 2 }),
      ]),
      { size: 24 },
    );
    expect(key).toBe(BigInt(expected));
  });
});

// ── Wave 5 Option D Commit 3 — wrapEnableModeSignature byte-equality ──

/**
 * Byte-equality regression suite. We re-implement the canonical
 * `getEncodedPluginsData` from `@zerodev/sdk` and assert
 * `wrapEnableModeSignature` produces IDENTICAL bytes. If ZeroDev rotates
 * the encoder shape in a future SDK release, this test fails — the
 * anti-drift pattern per `[[feedback-ai-engineer-catches-zerodev-shape-drift]]`.
 *
 * Each fixture exercises a different combination of hookAddress /
 * hookData / inner-action hook / enableData size / enableSig size, so a
 * regression that touches any of the 5 abi-encoded fields surfaces.
 */
describe('wrapEnableModeSignature (byte-equality vs @zerodev/sdk::getEncodedPluginsData)', () => {
  const KERNEL_ADDR = '0x678d2e3F778C4528911b137ED4db282834f3735E' as const;
  const HOOK_ADDR = '0xbAd1234567890ABCDef1234567890aBCDef12345' as const;
  const ZERO = '0x0000000000000000000000000000000000000000' as const;
  // kernel.execute(bytes32,bytes) selector — what the inner action calls.
  const EXECUTE_SELECTOR = '0xe9ae5c53' as `0x${string}`;
  // Stable 66-byte wrapped session-key signature (0xff + 65 bytes).
  const WRAPPED_SIG = ('0xff' + 'ab'.repeat(65)) as `0x${string}`;
  // Small enableData (subscription-only) and a large one (real prod ~30KB).
  const SMALL_ENABLE_DATA = ('0x' + 'cd'.repeat(64)) as `0x${string}`;
  const LARGE_ENABLE_DATA = ('0x' + '5a'.repeat(15_000)) as `0x${string}`;
  // WebAuthn-shaped enableSig (256 bytes minimum per Kernel V3.1 floor).
  const ENABLE_SIG_256 = ('0x' + '12'.repeat(256)) as `0x${string}`;
  // Larger WebAuthn envelope.
  const ENABLE_SIG_512 = ('0x' + '34'.repeat(512)) as `0x${string}`;

  const fixtures = [
    {
      name: 'no hook, small enableData, 256-byte enableSig',
      input: {
        enableData: SMALL_ENABLE_DATA,
        enableSig: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
      },
      canonical: {
        enableSignature: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        enableData: SMALL_ENABLE_DATA,
        hook: undefined,
      },
    },
    {
      name: 'no hook, large enableData (~30KB hex), 512-byte enableSig',
      input: {
        enableData: LARGE_ENABLE_DATA,
        enableSig: ENABLE_SIG_512,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
      },
      canonical: {
        enableSignature: ENABLE_SIG_512,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        enableData: LARGE_ENABLE_DATA,
        hook: undefined,
      },
    },
    {
      name: 'hook present (outer 20-byte address), no hookData',
      input: {
        enableData: SMALL_ENABLE_DATA,
        enableSig: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        hookAddress: HOOK_ADDR as `0x${string}`,
      },
      canonical: {
        enableSignature: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        enableData: SMALL_ENABLE_DATA,
        // The canonical SDK accepts `hook` with getIdentifier + getEnableData
        // methods. We stub them — the encoder calls both.
        hook: {
          getIdentifier: () => HOOK_ADDR as `0x${string}`,
          getEnableData: async () => '0x' as `0x${string}`,
        },
      },
    },
    {
      name: 'inner-action hook (binds executor to a sub-hook)',
      input: {
        enableData: SMALL_ENABLE_DATA,
        enableSig: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: {
          selector: EXECUTE_SELECTOR,
          address: KERNEL_ADDR,
          hookAddress: HOOK_ADDR as `0x${string}`,
        },
      },
      canonical: {
        enableSignature: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: {
          selector: EXECUTE_SELECTOR,
          address: KERNEL_ADDR,
          hook: { address: HOOK_ADDR as `0x${string}` },
        },
        enableData: SMALL_ENABLE_DATA,
        hook: undefined,
      },
    },
    {
      name: 'hookData non-trivial (forwarded by the encoder)',
      input: {
        enableData: SMALL_ENABLE_DATA,
        enableSig: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        hookAddress: HOOK_ADDR as `0x${string}`,
        hookData: '0xbeefcafe' as `0x${string}`,
      },
      canonical: {
        enableSignature: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
        enableData: SMALL_ENABLE_DATA,
        hook: {
          getIdentifier: () => HOOK_ADDR as `0x${string}`,
          getEnableData: async () => '0xbeefcafe' as `0x${string}`,
        },
      },
    },
    {
      // The PRODUCTION action.address — the ZeroDev built-in-execute
      // sentinel (zero address) the frontend signs. Pins the exact value
      // the EnableNotApproved fix landed, at the cheap byte-equality layer
      // (the other fixtures use KERNEL_ADDR; this one guards a future drift
      // back to a non-zero address). BSA/AI-Eng C3 second-review LOW.
      name: 'no hook, ZERO action.address (production built-in-execute sentinel)',
      input: {
        enableData: SMALL_ENABLE_DATA,
        enableSig: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: ZERO },
      },
      canonical: {
        enableSignature: ENABLE_SIG_256,
        userOpSignature: WRAPPED_SIG,
        action: { selector: EXECUTE_SELECTOR, address: ZERO },
        enableData: SMALL_ENABLE_DATA,
        hook: undefined,
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    it(`fixture: ${fixture.name}`, async () => {
      const ours = wrapEnableModeSignature(fixture.input);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const theirs = await (getEncodedPluginsData as any)(fixture.canonical);
      expect(ours.toLowerCase()).toBe((theirs as string).toLowerCase());
    });
  }

  it('emits 20-byte zero address as leading bytes when no hook provided', () => {
    const out = wrapEnableModeSignature({
      enableData: SMALL_ENABLE_DATA,
      enableSig: ENABLE_SIG_256,
      userOpSignature: WRAPPED_SIG,
      action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
    });
    // First 20 bytes = 40 hex chars after `0x` = zero address.
    expect(out.slice(2, 42).toLowerCase()).toBe(ZERO.slice(2).toLowerCase());
  });

  it('emits the supplied hook address as leading bytes when present', () => {
    const out = wrapEnableModeSignature({
      enableData: SMALL_ENABLE_DATA,
      enableSig: ENABLE_SIG_256,
      userOpSignature: WRAPPED_SIG,
      action: { selector: EXECUTE_SELECTOR, address: KERNEL_ADDR },
      hookAddress: HOOK_ADDR as `0x${string}`,
    });
    expect(out.slice(2, 42).toLowerCase()).toBe(HOOK_ADDR.slice(2).toLowerCase());
  });
});

// ── Wave 5 Option D Commit 3 — ABI re-exports ───────────────────────

describe('KERNEL_V3_CURRENT_NONCE_ABI + KERNEL_V3_SELECTOR_SET_ABI', () => {
  it('currentNonce ABI parses as a uint32 view function', () => {
    expect(KERNEL_V3_CURRENT_NONCE_ABI).toHaveLength(1);
    const item = KERNEL_V3_CURRENT_NONCE_ABI[0]!;
    expect(item.type).toBe('function');
    expect((item as { name: string }).name).toBe('currentNonce');
    expect((item as { stateMutability: string }).stateMutability).toBe('view');
  });

  it('SelectorSet ABI parses as an event with three non-indexed args', () => {
    // Wave 5 Option D Commit 3 smoke fix — the deployed kernel emits
    // SelectorSet (NOT PermissionInstalled) on an enable-mode install.
    expect(KERNEL_V3_SELECTOR_SET_ABI).toHaveLength(1);
    const item = KERNEL_V3_SELECTOR_SET_ABI[0]!;
    expect(item.type).toBe('event');
    expect((item as { name: string }).name).toBe('SelectorSet');
    const inputs = (
      item as { inputs: readonly { name: string; type: string; indexed?: boolean }[] }
    ).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[0].type).toBe('bytes4');
    expect(inputs[1].type).toBe('bytes21');
    expect(inputs[2].type).toBe('bool');
    expect(inputs.every((i) => !i.indexed)).toBe(true);
  });
});
