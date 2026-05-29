/**
 * Wave 5 Slice 2c — shared Path-D inner-call encoding primitives.
 *
 * These selectors / ABI fragments / the paymaster stub signature were
 * originally inlined in `tools/handlers.ts`. They were hoisted here so the
 * standalone `muhaven-reinvest` runner (`src/reinvest/*`, a separate tsup
 * entry) can reuse them WITHOUT importing the full tool-handler surface
 * (which would pull the MCP SDK + zod tool registry into the keyless
 * runner bundle). `handlers.ts` re-exports them, so external importers
 * (and the byte-pinning regression tests) keep their `../src/tools/handlers.js`
 * import path unchanged.
 *
 * Single source of truth: a drift in any of these re-opens an AA23 /
 * wrong-selector failure, so they live in exactly one place.
 */

import { parseAbi, toFunctionSelector, type Abi } from 'viem';

/**
 * `MuHavenSubscription.purchase` selector. The Path-D buy leg (and the
 * reinvest batch's buy leg) target this on the subscription.
 */
export const SUBSCRIPTION_PURCHASE_SELECTOR = toFunctionSelector(
  'function purchase(address,(uint256,uint8,uint8,bytes),uint128,address)',
).toLowerCase() as `0x${string}`;

/**
 * Narrow ABI fragment for inner-call encoding (the v0.1.3 InEuint128 tuple
 * shape). Hand-pinned rather than imported from `@muhaven/sdk` to keep the
 * MCP package weight down + decouple from SDK release cadence (selector +
 * arg shape are stable per ADR-021 / Wave 3.5 contract layout).
 */
export const SUBSCRIPTION_PURCHASE_ABI: Abi = parseAbi([
  'function purchase(address token, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encShares, uint128 maxSharesHint, address ephemeralEOA)',
]);

/**
 * `YieldSnapshot.claimYield(uint256 epochId, address ephemeralEOA)`
 * selector + ABI. Structurally different from purchase/redeem/submit: NO
 * `InEuint128 encShares` (the claimed amount is computed on-chain), NO
 * `maxSharesHint` cap arg (a claim moves no user-chosen amount → its
 * selectorCap carries `capArgIndex: null, maxAmount: null`), and arg0 is an
 * `epochId` (uint256), NOT a token address — the target is the per-token
 * YieldSnapshot proxy.
 */
export const YIELD_SNAPSHOT_CLAIM_SELECTOR = toFunctionSelector(
  'function claimYield(uint256,address)',
).toLowerCase() as `0x${string}`;

export const YIELD_SNAPSHOT_CLAIM_ABI: Abi = parseAbi([
  'function claimYield(uint256 epochId, address ephemeralEOA)',
]);

/**
 * `@zerodev/sdk/constants::DUMMY_ECDSA_SIG` — the 65-byte crafted ECDSA
 * pattern the PermissionValidator recognizes as a stub (skips ecrecover
 * during paymaster gas-estimation). r is at the high-end of secp256k1's
 * field, s is the "magic" 7aa...aa, v is 0x1c.
 */
const ZERODEV_DUMMY_ECDSA_SIG =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

/**
 * Stub signature for the `zd_sponsorUserOperation` pre-sign UserOp:
 * `concat(["0xff", signer.getDummySignature()])` — the `0xff`
 * PermissionValidator "use root permission" routing byte prepended to
 * `@zerodev`'s DUMMY_ECDSA_SIG. 66 bytes (`0x` + 132 hex chars). MUST NOT
 * drift from `@zerodev/permissions::getStubSignature` output; a drift
 * re-opens the AA23 `paymaster_rejected` gate. Pinned by
 * `__tests__/placeholder-signature.test.ts`.
 */
export const PLACEHOLDER_SIGNATURE: `0x${string}` =
  (`0xff${ZERODEV_DUMMY_ECDSA_SIG.slice(2)}`) as `0x${string}`;
