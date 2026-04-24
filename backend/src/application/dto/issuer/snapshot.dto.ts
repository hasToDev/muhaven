import { z } from 'zod';

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Snapshot lifecycle actions for an epoch. `total_yield` is required for
 * `fund` and is the **plaintext** amount in PUSDC base units — the issuer's
 * frontend must encrypt it client-side before sending. The endpoint can't
 * encrypt PUSDC because the cofhe permit is bound to the issuer's signer.
 *
 * For `open` / `finalize` / `sweep`, only the address + epoch are needed.
 * For `snapshot_batch`, callers should hit the SDK directly (large investor
 * arrays are not a good fit for a JSON HTTP body).
 */
export const SnapshotActionDtoSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    snapshot_address: z.string().regex(ETH_ADDRESS, 'Invalid snapshot address'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
  }),
  z.object({
    action: z.literal('finalize'),
    snapshot_address: z.string().regex(ETH_ADDRESS, 'Invalid snapshot address'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
    epoch_id: z.string().regex(/^[0-9]+$/, 'epoch_id must be a base-10 integer string'),
  }),
  z.object({
    action: z.literal('sweep'),
    snapshot_address: z.string().regex(ETH_ADDRESS, 'Invalid snapshot address'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
    epoch_id: z.string().regex(/^[0-9]+$/, 'epoch_id must be a base-10 integer string'),
  }),
]);

export type SnapshotActionDto = z.infer<typeof SnapshotActionDtoSchema>;
