import { z } from 'zod';

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Phase 7.5 — calldata-prep DTO for `MuHavenStable.setOperator`.
 *
 * The issuer (or any wallet that holds mhUSDC and wants to delegate
 * pull-rights) calls this endpoint to fetch ready-to-sign calldata for a
 * `setOperator(spender, until)` call on the configured `MuHavenStable`
 * wrapper. Replaces the per-tx hand-encode dance we previously did for
 * the legacy PUSDC operator approval — see `MHUSD_WRAPPER_PLAN.md`.
 *
 * `until` is a uint48 unix timestamp (seconds). The endpoint validates
 * shape only; on-chain authorisation is the source of truth.
 */
export const StableOperatorActionDtoSchema = z.object({
  spender: z.string().regex(ETH_ADDRESS, 'Invalid spender address'),
  until: z
    .string()
    .regex(/^[0-9]+$/, 'until must be a base-10 integer string (seconds)')
    .refine((v) => {
      const n = BigInt(v);
      return n >= 0n && n < 1n << 48n;
    }, 'until must fit in uint48'),
});

export type StableOperatorActionDto = z.infer<typeof StableOperatorActionDtoSchema>;
