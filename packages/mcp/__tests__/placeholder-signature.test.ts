/**
 * Regression for the 2026-05-23 `paymaster_rejected` smoke debug.
 *
 * `PLACEHOLDER_SIGNATURE` is the signature stuffed into the
 * `zd_sponsorUserOperation` request's `userOp.signature` field so the
 * paymaster's validator simulator computes realistic verification gas.
 * It MUST match the EXACT byte-length of the real Kernel v3.1
 * PermissionValidator signature shape that `buildKernelSessionKeySignature`
 * produces:
 *
 *     byte 0       — 0xff (PermissionValidator "use root permission" sentinel)
 *     bytes 1..65  — 65-byte ECDSA
 *     = 66 bytes total = `0x` + 132 hex chars
 *
 * Pre-0.2.5 the placeholder was 86 bytes — the OLD enable-mode shape
 * (1 byte prefix + 20 bytes validator + 65 bytes ECDSA). The paymaster's
 * validator simulator decoded the wrong-length signature, the
 * validator reverted with `AA23 reverted`, and
 * `zd_sponsorUserOperation` returned rpc_error → MCP mapped to
 * `paymaster_rejected` and Path C fallback. This test pins the shape
 * so a future shape-drift fails loud at test time.
 */

import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SIGNATURE } from '../src/tools/handlers.js';

describe('PLACEHOLDER_SIGNATURE — Kernel v3.1 PermissionValidator shape', () => {
  it('is exactly 66 bytes (132 hex chars + 0x prefix)', () => {
    // 0x (2) + 66 bytes × 2 hex chars (132) = 134 total length.
    expect(PLACEHOLDER_SIGNATURE).toHaveLength(134);
    // Defense-in-depth — pin the byte length too in case the literal
    // gets accidentally regenerated via a different formula.
    const hexBody = PLACEHOLDER_SIGNATURE.slice(2);
    expect(hexBody).toHaveLength(132);
    expect(hexBody.length / 2).toBe(66);
  });

  it('starts with 0xff (PermissionValidator "use root permission" sentinel)', () => {
    // byte 0 of the real Kernel v3.1 sig is the routing byte. Matching
    // it in the placeholder means the validator's structural parse
    // takes the same branch during simulation as it would post-sign,
    // so the paymaster's gas estimate covers the actual code path.
    expect(PLACEHOLDER_SIGNATURE.slice(0, 4).toLowerCase()).toBe('0xff');
  });

  it('has high-entropy non-zero bytes after the prefix', () => {
    // A zero-padded signature gas-estimates as if the cheaper sudo-
    // validator path will run. Non-zero bytes force the paymaster to
    // simulate the full ECDSA-recovery cost path.
    const remaining = PLACEHOLDER_SIGNATURE.slice(4);
    expect(remaining).not.toMatch(/^0+$/);
    // First byte after 0xff prefix should be non-zero.
    expect(remaining.slice(0, 2)).not.toBe('00');
  });
});
