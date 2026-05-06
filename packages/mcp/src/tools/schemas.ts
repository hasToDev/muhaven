/**
 * Zod schemas for every MCP tool's input. Each schema is `.strict()` —
 * `additionalProperties: false` in JSON-schema parlance — per the
 * cross-cutting rule (4) in `TOOL_NAMESPACE.md`. Trail-of-Bits +
 * OWASP-Agentic-Top-10 reference: this is the cheapest defense
 * against tool-call injection that mutates an unvalidated field.
 *
 * Where a string is enum-bounded (tier, surface, action), we declare
 * `z.enum(...)` rather than `z.string()` to lock the surface against
 * LLM-emitted novel values (rule 8 in TOOL_NAMESPACE.md).
 */

import { z } from 'zod';

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const addressSchema = z
  .string()
  .regex(HEX_ADDRESS_RE, 'must be a 0x-prefixed 20-byte hex address');

const tierSchema = z.enum(['advisory', 'confirm-per-action', 'policy-bound', 'paused']);

const surfaceSchema = z.enum(['havenbot', 'mcp', 'openclaw', 'checkout']);

const actionIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const auditEventTypeSchema = z.enum([
  'tier_changed',
  'paused',
  'resumed',
  'cron_tick',
  'confirm_token_issued',
  'confirm_token_consumed',
  'permit_granted',
  'permit_revoked',
  'validator_installed',
  'validator_uninstalled',
  'kyc_revocation_received',
  'risk_questionnaire_complete',
]);

// ---------- read group ----------

export const ReadPortfolioInputSchema = z.object({}).strict();

export const ReadYieldsInputSchema = z
  .object({
    token: addressSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const ReadDistributionInputSchema = z
  .object({
    token: addressSchema,
    epoch: z.number().int().min(0),
  })
  .strict();

export const ReadTokensInputSchema = z.object({}).strict();

export const ReadAuditInputSchema = z
  .object({
    surface: surfaceSchema.optional(),
    eventTypes: z.array(auditEventTypeSchema).max(20).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// ---------- position group ----------

export const PositionBuyInputSchema = z
  .object({
    token: addressSchema,
    /** Investor candidate spend, denominated in USDC base units (uint64). */
    amountUsdc6: z.string().regex(/^\d+$/, 'must be a base-10 integer string'),
  })
  .strict();

export const PositionSellInputSchema = z
  .object({
    token: addressSchema,
    /** Encrypted-balance share count to redeem, denominated in fhERC-20 base units. */
    amountShares: z.string().regex(/^\d+$/, 'must be a base-10 integer string'),
  })
  .strict();

export const PositionClaimInputSchema = z
  .object({
    token: addressSchema,
    /** When set, claim only the named escrow id; else claim-all. */
    escrowId: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export const PositionRebalanceInputSchema = z
  .object({
    legs: z
      .array(
        z
          .object({
            token: addressSchema,
            side: z.enum(['buy', 'sell']),
            amount: z.string().regex(/^\d+$/),
          })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict();

// ---------- policy group ----------

export const PolicySetTierInputSchema = z
  .object({
    targetTier: tierSchema,
    /** Returned by an earlier `request` call. Omit for step-down or first-call. */
    confirmationToken: z.string().min(8).max(128).optional(),
  })
  .strict();

export const PolicyPauseInputSchema = z
  .object({
    /** Omit to cascade a pause across all four surfaces (panic button). */
    surface: surfaceSchema.optional(),
  })
  .strict();

export const PolicyAuditExportInputSchema = z
  .object({
    surface: surfaceSchema.optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    /** Hard cap on rows to export, defends against runaway loops. */
    maxRows: z.number().int().min(1).max(5_000).default(1_000),
  })
  .strict();

export const PolicySessionKeyStatusInputSchema = z.object({}).strict();

// ---------- issuer group (Wave 4 P7) ----------

export const IssuerDistributeYieldInputSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Cleartext PUSDC base units — encrypted SDK-side before submit. */
    totalYieldUsd6: z.string().regex(/^[1-9]\d*$/, 'must be a positive integer string'),
    label: z.string().min(1).max(200).optional(),
  })
  .strict();

export const IssuerKycAddInputSchema = z
  .object({
    tokenAddress: addressSchema,
    investorAddress: addressSchema,
    kycTier: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict();

export const IssuerKycRemoveInputSchema = z
  .object({
    tokenAddress: addressSchema,
    investorAddress: addressSchema,
  })
  .strict();

export const IssuerUnpauseTokenInputSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Initial NAV in PUSDC base units (6 decimals). 1_000_000 = $1.00. */
    initialNavUsd6: z.string().regex(/^[1-9]\d*$/, 'must be a positive integer string'),
  })
  .strict();

export const IssuerAuditQueryInputSchema = z
  .object({
    surface: surfaceSchema.optional(),
    eventTypes: z.array(auditEventTypeSchema).max(20).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// ---------- type exports ----------

export type ReadPortfolioInput = z.infer<typeof ReadPortfolioInputSchema>;
export type ReadYieldsInput = z.infer<typeof ReadYieldsInputSchema>;
export type ReadDistributionInput = z.infer<typeof ReadDistributionInputSchema>;
export type ReadTokensInput = z.infer<typeof ReadTokensInputSchema>;
export type ReadAuditInput = z.infer<typeof ReadAuditInputSchema>;

export type PositionBuyInput = z.infer<typeof PositionBuyInputSchema>;
export type PositionSellInput = z.infer<typeof PositionSellInputSchema>;
export type PositionClaimInput = z.infer<typeof PositionClaimInputSchema>;
export type PositionRebalanceInput = z.infer<typeof PositionRebalanceInputSchema>;

export type PolicySetTierInput = z.infer<typeof PolicySetTierInputSchema>;
export type PolicyPauseInput = z.infer<typeof PolicyPauseInputSchema>;
export type PolicyAuditExportInput = z.infer<typeof PolicyAuditExportInputSchema>;
export type PolicySessionKeyStatusInput = z.infer<typeof PolicySessionKeyStatusInputSchema>;

// Wave 4 P7 — issuer group
export type IssuerDistributeYieldInput = z.infer<typeof IssuerDistributeYieldInputSchema>;
export type IssuerKycAddInput = z.infer<typeof IssuerKycAddInputSchema>;
export type IssuerKycRemoveInput = z.infer<typeof IssuerKycRemoveInputSchema>;
export type IssuerUnpauseTokenInput = z.infer<typeof IssuerUnpauseTokenInputSchema>;
export type IssuerAuditQueryInput = z.infer<typeof IssuerAuditQueryInputSchema>;

export { actionIdSchema, addressSchema, surfaceSchema, tierSchema };
