import { z } from 'zod';

/**
 * Wave 5 Slice 2c (auto-reinvest runner) — DTO for the runner's
 * post-execution audit record.
 *
 * After the keyless `muhaven-reinvest` runner atomically claims a matured
 * epoch and buys more of the same RWA in ONE `executeBatch` UserOp, it
 * POSTs this to `/api/v1/agent/reinvest/cycle` so the backend appends a
 * `reinvest_cycle_executed` audit row correlating the claim+buy legs (one
 * txHash) by `reinvestCycleId`, deduped per `(user, epoch)`.
 *
 * Cleartext-by-design: the claimed AMOUNT stays encrypted (amount-blind),
 * so this payload carries only structural facts (epoch, token, snapshot,
 * the on-chain userOpHash/txHash, the cleartext buy-budget share count +
 * usd6). No decrypted-FHE primitive ever crosses this boundary.
 */

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;
const HASH_HEX = /^0x[0-9a-fA-F]{64}$/;
// UUID v4-ish — the runner stamps a fresh cycle id per (token, epoch)
// attempt. Loose enough to admit any RFC-4122 variant.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UINT_DEC = /^(0|[1-9]\d{0,38})$/;

export const RecordReinvestCycleRequestDtoSchema = z
  .object({
    /** Correlation id the runner stamped for this (token, epoch) attempt. */
    reinvestCycleId: z.string().regex(UUID_RE, 'reinvestCycleId must be a UUID'),
    /** Claimed epoch id (decimal, ≥ 1). */
    epochId: z.string().regex(/^[1-9]\d{0,77}$/, 'epochId must be a positive decimal integer'),
    /** RWA token bought (the buy-leg + audit subject). */
    tokenAddress: z
      .string()
      .regex(ADDRESS_HEX, 'tokenAddress must be a 0x-prefixed 20-byte hex string'),
    /** YieldSnapshot proxy the claim targeted. */
    snapshotAddress: z
      .string()
      .regex(ADDRESS_HEX, 'snapshotAddress must be a 0x-prefixed 20-byte hex string'),
    /** The atomic claim+buy UserOp hash (always present — the runner only
     *  records after a confirmed submit). */
    userOpHash: z.string().regex(HASH_HEX, 'userOpHash must be a 0x-prefixed 32-byte hex string'),
    /** On-chain tx hash carrying the UserOp. Present once a receipt landed;
     *  omitted when the runner recorded on a submit-but-receipt-timeout. */
    txHash: z
      .string()
      .regex(HASH_HEX, 'txHash must be a 0x-prefixed 32-byte hex string')
      .optional(),
    /** Cleartext buy-budget share count (maxSharesHint). */
    buyShares: z.string().regex(UINT_DEC, 'buyShares must be a non-negative decimal integer'),
    /** Cleartext per-cycle reinvest budget in mhUSDC 6-dp base units. */
    budgetUsd6: z.string().regex(UINT_DEC, 'budgetUsd6 must be a non-negative decimal integer'),
  })
  .strict();

export type RecordReinvestCycleRequestDto = z.infer<typeof RecordReinvestCycleRequestDtoSchema>;

export interface RecordReinvestCycleResponseDto {
  /** True when a new audit row was appended; false when this (user, epoch)
   *  cycle was already recorded (idempotent — slow-settling UserOp re-seen
   *  by the gate). */
  readonly recorded: boolean;
  /** Echoed correlation id. */
  readonly reinvestCycleId: string;
}
