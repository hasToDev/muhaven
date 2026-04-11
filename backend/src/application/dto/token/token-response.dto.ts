import { z } from 'zod';

export const CreateTokenDtoSchema = z.object({
  address: z.string().min(1).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(10),
  apy: z.string().optional(),
  yield_schedule: z.string().optional(),
  kyc_tier: z.number().int().min(0).max(3),
  asset_class: z.enum(['treasury', 'money_market', 'private_credit', 'real_estate', 'other']),
  min_investment: z.string().optional(),
});

export type CreateTokenDto = z.infer<typeof CreateTokenDtoSchema>;

export interface LatestNavDto {
  nav: string;
  apy: string | null;
  total_aum: string | null;
  yield_rate: string | null;
  source: string;
  source_type: string;
  source_timestamp: string | null;
  fetched_at: string;
}

export interface TokenResponseDto {
  id: string;
  address: string;
  name: string;
  symbol: string;
  issuer_address: string;
  apy: string | null;
  yield_schedule: string | null;
  kyc_tier: number;
  asset_class: string;
  min_investment: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  latest_nav: LatestNavDto | null;
}
