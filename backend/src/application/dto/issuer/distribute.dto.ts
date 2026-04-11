import { z } from 'zod';

export const DistributeYieldDtoSchema = z.object({
  token_address: z.string().min(1).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  amount: z.string().min(1),
});

export type DistributeYieldDto = z.infer<typeof DistributeYieldDtoSchema>;
