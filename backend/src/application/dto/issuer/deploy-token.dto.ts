import { z } from 'zod';

/**
 * Phase 9.A · Expansion (F2) — wizard step 2-4 payload. The wizard
 * captures token name + symbol + asset class, an initial NAV hint,
 * min-investment, and yield schedule. The deploy library uses these to
 * register the token in TokenRegistry. Compliance bundle is hard-locked
 * to defaults (see PHASE_9A_EXPANSION_PLAN.md §F2.6).
 */
export const DeployTokenDtoSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(3)
    .max(8)
    .toUpperCase()
    .regex(/^[A-Z0-9]+$/, 'Symbol must be 3-8 uppercase alphanumeric chars'),
  name: z.string().trim().min(2).max(64),
  asset_class: z.enum([
    'treasury',
    'money_market',
    'private_credit',
    'real_estate',
    'other',
  ]),
  // PUSDC base units / share. Stored as string so JSON doesn't lose
  // precision; the use-case parses via BigInt.
  initial_nav: z
    .string()
    .regex(/^\d+$/, 'Must be a non-negative integer (PUSDC base units / share)'),
  min_investment: z
    .string()
    .regex(/^\d+$/, 'Must be a non-negative integer (PUSDC base units)'),
  yield_schedule: z.enum(['monthly', 'quarterly', 'annual']),
});

export type DeployTokenDto = z.infer<typeof DeployTokenDtoSchema>;

export interface DeployTokenAcceptedDto {
  deploy_id: string;
  status: 'running';
}
