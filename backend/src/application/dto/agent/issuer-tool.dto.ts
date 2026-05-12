import { z } from 'zod';
import { SURFACE_VALUES, type Surface } from '../../../domain/agent/model/surface.enum.js';
import {
  AUDIT_EVENT_TYPE_VALUES,
  type AuditEventType,
} from '../../../domain/agent/model/audit-event-type.enum.js';

/**
 * Wave 4 P7 — issuer-side tool surface DTOs.
 *
 * Five new tools per ADR-8: four propose_* (state-mutating) + one read
 * (`muhaven_audit_query`). All schemas use `.strict()` (the Zod equivalent
 * of JSON-Schema `additionalProperties: false`) per the cross-cutting
 * rule (4) in `TOOL_NAMESPACE.md`.
 *
 * Production-trajectory: the issuer kernel (NOT the platform deployer)
 * signs every state-mutating tool. The MCP-side mirror lives under the
 * `muhaven.issuer.*` namespace.
 */

// ── Shared primitives — matched to tool.dto.ts ────────────────────────

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 40-hex EVM address');

const usd6Schema = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountUsd6 must be a positive integer string (1 = 1e-6 USDC)');

const surfaceSchema = z.enum(SURFACE_VALUES as readonly [Surface, ...Surface[]]);

const auditEventTypeSchema = z.enum(
  AUDIT_EVENT_TYPE_VALUES as readonly [AuditEventType, ...AuditEventType[]],
);

// ─────────────────────────────────────────────────────────────────────
// Tool 9 — muhaven_propose_distribute_yield
// ─────────────────────────────────────────────────────────────────────
//
// Wraps the existing `@muhaven/sdk` `distributeYield` flow. Issuer must
// (a) own MINTER_ROLE on the registered RWA token, (b) hold ≥ totalYield
// in mhUSDC, (c) have set an operator approval for YieldDistributor.
// Pre-flight checks land at the use-case level; the on-chain pipeline
// (startDistribution → batchCreate → fundEscrows) runs frontend-side.

export const ProposeDistributeYieldDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Cleartext mhUSDC base units — encrypted SDK-side before submit. */
    totalYieldUsd6: usd6Schema,
    /** Human-readable label captured into the audit log + Telegram broadcast. */
    label: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ProposeDistributeYieldDto = z.infer<typeof ProposeDistributeYieldDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 10 — muhaven_propose_kyc_add
// ─────────────────────────────────────────────────────────────────────

export const ProposeKycAddDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    investorAddress: addressSchema,
    /** 1 = retail KYC; 2 = accredited (which also requires tier 1). */
    kycTier: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict();

export type ProposeKycAddDto = z.infer<typeof ProposeKycAddDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 11 — muhaven_propose_kyc_remove
// ─────────────────────────────────────────────────────────────────────

export const ProposeKycRemoveDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    investorAddress: addressSchema,
  })
  .strict();

export type ProposeKycRemoveDto = z.infer<typeof ProposeKycRemoveDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 12 — muhaven_propose_unpause_token
// ─────────────────────────────────────────────────────────────────────
//
// Closes the F2 wizard's deferred step 6: oracle.setNAV(token, initialNav)
// + tokenRegistry.setPaused(token, false). Both signed by the applicant
// kernel. See `scripts/unpause-token.ts` for the deployer-side analog.

export const ProposeUnpauseTokenDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Initial NAV in mhUSDC base units (6 decimals). 1_000_000 = $1.00. */
    initialNavUsd6: usd6Schema,
  })
  .strict();

export type ProposeUnpauseTokenDto = z.infer<typeof ProposeUnpauseTokenDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 13 — muhaven_audit_query  (read; issuer-self only in Wave 4)
// ─────────────────────────────────────────────────────────────────────
//
// Wave-4 scope: issuer reads their own audit log (filtered by surface +
// event types + time range). Cross-user permit-gated audit (the
// "compliance officer" path) defers to Wave 5 — wire shape captured in
// ADR-8 §"Wave 5 follow-ups" so the upgrade is purely additive.

export const AuditQueryToolDtoSchema = z
  .object({
    surface: surfaceSchema.optional(),
    eventTypes: z.array(auditEventTypeSchema).max(20).optional(),
    /** ISO datetime — inclusive lower bound on `createdAt`. */
    since: z.string().datetime().optional(),
    /** ISO datetime — inclusive upper bound on `createdAt`. */
    until: z.string().datetime().optional(),
    /** Opaque cursor returned by a previous page. */
    cursor: z.string().min(1).max(512).optional(),
    /** Page size (server caps at 200). */
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AuditQueryToolDto = z.infer<typeof AuditQueryToolDtoSchema>;

export interface AuditQueryToolResponseDto {
  tool: 'muhaven_audit_query';
  /** Self-scoped — Wave 4 always returns the calling user's own log. */
  scopedTo: 'self';
  items: Array<{
    id: string;
    surface: Surface;
    eventType: AuditEventType;
    actionId: number | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Tool 14 — muhaven_propose_create_checkout
// ─────────────────────────────────────────────────────────────────────
//
// Wave 4 §5 Path C — issuer asks the agent to mint a hosted-checkout
// session for a known token + amount + memo. Backend mints the session
// at commit time (NOT propose) so the fragment key never enters the
// confirm-token replay surface. The ConfirmModal renders the cleartext
// preview; commit returns the buyer URL + sessionId + fragmentKey.

const memoSchema = z.string().min(1).max(280).optional();

/**
 * Wave 4 §5 Path C — same restricted-scheme validator as the dashboard's
 * `MetadataSchema`. The agent surface is the second user of these URL
 * fields and MUST share the validation posture — otherwise an LLM-emitted
 * `javascript:` URL would pass propose but fail dashboard parity.
 *
 * Restricts to `https://` (or `http://localhost` for dev). Hard-blocks
 * `javascript:` / `data:` / `vbscript:` / `file:` etc.
 */
const urlSchema = z
  .string()
  .max(512)
  .superRefine((raw, ctx) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid URL' });
      return;
    }
    if (u.protocol === 'https:') return;
    if (u.protocol === 'http:') {
      const h = u.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http:// only allowed for localhost; production must use https://',
      });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `protocol ${u.protocol} is not allowed (https:// or http://localhost only)`,
    });
  })
  .optional();

export const ProposeCreateCheckoutDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Cleartext mhUSDC base units (1 mhUSDC = 1_000_000). Encrypted at
     *  commit time by the backend's AES-256-GCM helper; the agent never
     *  sees the encryption key. */
    amountUsd6: usd6Schema,
    memo: memoSchema,
    successUrl: urlSchema,
    cancelUrl: urlSchema,
  })
  .strict();

export type ProposeCreateCheckoutDto = z.infer<typeof ProposeCreateCheckoutDtoSchema>;
