import { z } from 'zod';

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Issuer queue settlement: prepare a `RedemptionQueue.processEpoch` call
 * over `[start_idx, end_idx)`. Pagination is the caller's responsibility —
 * batch sizing follows the SDK's `processAllEpoch` helper. The endpoint
 * validates that the issuer owns the underlying token.
 */
export const QueueProcessDtoSchema = z.object({
  token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
  queue_address: z.string().regex(ETH_ADDRESS, 'Invalid queue address'),
  epoch_id: z.string().regex(/^[0-9]+$/, 'epoch_id must be a base-10 integer string'),
  start_idx: z.string().regex(/^[0-9]+$/, 'start_idx must be a base-10 integer string'),
  end_idx: z.string().regex(/^[0-9]+$/, 'end_idx must be a base-10 integer string'),
});

export type QueueProcessDto = z.infer<typeof QueueProcessDtoSchema>;
