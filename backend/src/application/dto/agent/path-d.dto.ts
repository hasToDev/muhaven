import { z } from 'zod';

/**
 * Wave 5 Path D Slice 1 (Commit 3.5) — DTOs for the autonomous-buy
 * encryption boundary.
 *
 * The MCP server proposes a Path D buy, asks the backend to encrypt the
 * cleartext share amount into an `InEuint128` ciphertext bound to the
 * user's kernel address, and to mint a fresh ephemeral EOA for the
 * `subscription.purchase` ACL grant target. The MCP then assembles the
 * UserOp around the returned ciphertext + ephemeralEOA and forwards to
 * the broker for policy-gated signing.
 *
 * The encryption boundary has to live server-side because the MCP
 * package must NOT import `@cofhe/sdk` (per operator pre-decision) —
 * the cofhe client is heavy + browser-bound and would defeat the
 * lethal-trifecta isolation we built between MCP server and broker.
 */

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;
const HASH_HEX = /^0x[0-9a-fA-F]{64}$/;
// uint128 max = 340282366920938463463374607431768211455 (≤39 decimal digits).
// `^(0|[1-9]\d*)$` keeps the shape sane; the use-case re-validates the
// numeric upper bound after BigInt parsing.
const UINT128_DEC = /^(0|[1-9]\d{0,38})$/;

export const EncryptSharesForPurchaseRequestDtoSchema = z
  .object({
    tokenAddress: z
      .string()
      .regex(ADDRESS_HEX, 'tokenAddress must be a 0x-prefixed 20-byte hex string'),
    sharesAmount: z
      .string()
      .regex(UINT128_DEC, 'sharesAmount must be a non-negative decimal integer string'),
  })
  .strict();

export type EncryptSharesForPurchaseRequestDto = z.infer<
  typeof EncryptSharesForPurchaseRequestDtoSchema
>;

/**
 * Wave 5 Path D Slice 2a (autonomous claim) — request DTO for the
 * lighter "mint an ephemeral EOA" boundary. `YieldSnapshot.claimYield`
 * computes the amount on-chain, so there's nothing to encrypt — the
 * Path-D claim UserOp needs only a throwaway eph (the FHE.allow
 * decrypt-grant target). See `MintEphemeralEoaUseCase`.
 */
export const MintEphemeralRequestDtoSchema = z
  .object({
    tokenAddress: z
      .string()
      .regex(ADDRESS_HEX, 'tokenAddress must be a 0x-prefixed 20-byte hex string'),
  })
  .strict();

export type MintEphemeralRequestDto = z.infer<typeof MintEphemeralRequestDtoSchema>;

export interface MintEphemeralResponseDto {
  /** Fresh-random 0x-address minted by the backend per call (throwaway —
   *  private half dropped). Passed to `claimYield(epochId, ephemeralEOA)`
   *  as the FHE ACL grant target for the claimed-amount handle. */
  readonly ephemeralEOA: `0x${string}`;
}

export interface EncryptSharesForPurchaseResponseDto {
  /** ABI-tuple-shaped components for `InEuint128`. */
  readonly encShares: {
    /** 0x-prefixed 32-byte ciphertext handle (the `uint256 ctHash` slot). */
    readonly ctHash: `0x${string}`;
    /** 0..255 — security-zone byte. */
    readonly securityZone: number;
    /** Encoded FHE-type discriminator (cofhe's uint8 utype enum). */
    readonly utype: number;
    /** Verifier signature (0x-prefixed hex) over
     *  `(ctHash, utype, securityZone, msg.sender, chainId)`, signed by
     *  the cofhe verifier service. The on-chain TaskManager validates
     *  this against the actual msg.sender of the executing contract. */
    readonly signature: `0x${string}`;
  };
  /**
   * Fresh-random 0x-address minted by the backend per call. The MCP
   * server passes this to `subscription.purchase` as the `ephemeralEOA`
   * arg — the FHE ACL grant target for the resulting balance handle.
   *
   * Throwaway semantics: the private half is generated, the address is
   * derived, the private half is dropped. The user's dashboard
   * subsequently regenerates its own ephemeralEOA in the browser and
   * calls `refreshDecryptGrant(newEoa)` against the per-token contract
   * (via the existing session-key kernel path) to re-grant decrypt
   * access to a controllable EOA — same flow as a post-passkey-buy
   * decrypt-after-reload today.
   */
  readonly ephemeralEOA: `0x${string}`;
}
