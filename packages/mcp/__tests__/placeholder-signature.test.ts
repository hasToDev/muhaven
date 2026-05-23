/**
 * Regression for the 2026-05-23 `paymaster_rejected` smoke debug.
 *
 * `PLACEHOLDER_SIGNATURE` is the signature stuffed into the
 * `zd_sponsorUserOperation` request's `userOp.signature` field so the
 * paymaster's PermissionValidator simulator skips real ecrecover (it
 * recognizes the CRAFTED dummy pattern) and gas-estimates the
 * verification cost path realistically.
 *
 * Source contract: `@zerodev/permissions::toPermissionValidator.js`
 *   getStubSignature: () => concat(["0xff", signer.getDummySignature()])
 * Where ECDSA signers return `@zerodev/sdk/constants::DUMMY_ECDSA_SIG`.
 *
 * Pre-0.2.6 regressions (each surfaced as `paymaster_rejected`):
 *  - 0.2.4: 86-byte placeholder (wrong LENGTH — enable-mode shape)
 *  - 0.2.5: 66-byte but random `0xfe`-filled trailing bytes — validator
 *           ecrecovers a garbage address → AA23 revert
 *  - 0.2.6 (current): exact @zerodev DUMMY_ECDSA_SIG bytes
 */

import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SIGNATURE } from '../src/tools/handlers.js';

// Exact value copied from `@zerodev/sdk/constants::DUMMY_ECDSA_SIG`
// (verified 2026-05-23 against installed @zerodev/sdk@5.5.10).
// The 65-byte ECDSA dummy; the PermissionValidator's stub-sig
// wrapper prepends a `0xff` routing byte → 66-byte total.
const ZERODEV_DUMMY_ECDSA_SIG =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

describe('PLACEHOLDER_SIGNATURE — @zerodev/permissions::getStubSignature() exact bytes', () => {
  it('is exactly 66 bytes (132 hex chars + 0x prefix)', () => {
    expect(PLACEHOLDER_SIGNATURE).toHaveLength(134);
    expect(PLACEHOLDER_SIGNATURE.slice(2)).toHaveLength(132);
    expect(PLACEHOLDER_SIGNATURE.slice(2).length / 2).toBe(66);
  });

  it('starts with 0xff (PermissionValidator "use root permission" sentinel)', () => {
    expect(PLACEHOLDER_SIGNATURE.slice(0, 4).toLowerCase()).toBe('0xff');
  });

  it('trailing 65 bytes match @zerodev/sdk::DUMMY_ECDSA_SIG byte-for-byte', () => {
    // Drop the `0xff` routing prefix from PLACEHOLDER (=> 65 bytes),
    // drop the `0x` prefix from the dummy constant (=> 65 bytes),
    // compare lowercased.
    const trailing65 = PLACEHOLDER_SIGNATURE.slice(4); // skip "0xff"
    const dummyBody = ZERODEV_DUMMY_ECDSA_SIG.slice(2); // skip "0x"
    expect(trailing65.toLowerCase()).toBe(dummyBody.toLowerCase());
  });

  it('ends with the v=0x1c recovery byte (per DUMMY_ECDSA_SIG)', () => {
    // ECDSA `v` is the last byte. ZeroDev's dummy uses `0x1c` (= 28).
    // This is what makes the simulator's recovery path take the same
    // gas branch as a real signature would.
    expect(PLACEHOLDER_SIGNATURE.slice(-2).toLowerCase()).toBe('1c');
  });

  it('s-component uses the magic 7aa...a pattern (NOT random entropy — the 0.2.5 bug)', () => {
    // The s-component (bytes 33..64 of the 65-byte ECDSA) is
    // `7aaaaa...aaa` — a crafted pattern the validator's simulation
    // path checks for. The 0.2.5 regression filled this region with
    // `0xfe` bytes which the validator tried to ecrecover against.
    // Position in hex chars: `0x` (2) + `ff` (2) + r (64) = offset 68;
    // s spans 64 chars.
    const sBytes = PLACEHOLDER_SIGNATURE.slice(68, 68 + 64);
    expect(sBytes.toLowerCase()).toMatch(/^7a+/);
    // And specifically: NOT the 0.2.5 broken pattern.
    expect(sBytes.toLowerCase()).not.toMatch(/^fe+/);
  });
});
