import { z } from 'zod';

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * NAV management actions exposed by `/api/v1/issuer/nav`. Mirrors the SDK
 * `OracleClient` surface: `set` for `IssuerControlledOracle.setNAV`,
 * `request` for `ChainlinkFunctionsOracle.requestNAV`, plus the
 * accept/reject controls for the deviation-gate pending slot.
 *
 * The endpoint always returns prepared calldata — the issuer's frontend
 * (or an automation EOA) signs and submits. This mirrors the Wave 3
 * `prepare-distribution.use-case.ts` shape so consumers can reuse the
 * existing call-batch pipeline.
 */
export const NavActionDtoSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
    new_nav: z.string().regex(/^[0-9]+$/, 'new_nav must be a base-10 integer string (1e8 fixed-point)'),
  }),
  z.object({
    action: z.literal('request'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
  }),
  z.object({
    action: z.literal('accept'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
  }),
  z.object({
    action: z.literal('reject'),
    token_address: z.string().regex(ETH_ADDRESS, 'Invalid token address'),
  }),
]);

export type NavActionDto = z.infer<typeof NavActionDtoSchema>;
