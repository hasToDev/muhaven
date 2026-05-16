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
  /**
   * Display name from the issuer's KYB submission (`users.issuer_display_name`).
   * Null when the issuer wallet hasn't walked the F2 onboarding wizard
   * (e.g. a Wave-3.5 demo issuer that pre-dates F2). Frontend falls back
   * to a formatted address when null.
   */
  issuer_display_name: string | null;
  apy: string | null;
  yield_schedule: string | null;
  kyc_tier: number;
  asset_class: string;
  min_investment: string | null;
  status: string;
  /**
   * Wave 5+ per-token YieldSnapshot proxy address (2026-05-23).
   * `null` for legacy tokens (deployed before per-token snapshots
   * shipped); frontend's `getYieldSnapshot(token)` falls back to the
   * env-baked singleton when this is null. Wizard-deployed tokens
   * always populate this at the `deploy_yield_snapshot` step.
   */
  yield_snapshot_address: string | null;
  created_at: string;
  updated_at: string;
  latest_nav: LatestNavDto | null;
}
