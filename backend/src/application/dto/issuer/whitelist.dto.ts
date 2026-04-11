import { z } from 'zod';

export const AddWhitelistDtoSchema = z.object({
  address: z.string().min(1).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  tier: z.number().int().min(0).max(3),
});

export type AddWhitelistDto = z.infer<typeof AddWhitelistDtoSchema>;
