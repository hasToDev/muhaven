import { z } from 'zod';
import {
  CHECKOUT_SESSION_ID_RE,
  CHECKOUT_SESSION_STATUS_VALUES,
  type CheckoutSessionStatus,
} from '../../../domain/checkout/model/checkout-session.js';
import { WEBHOOK_EVENT_TYPE_VALUES, WEBHOOK_ENDPOINT_ID_RE } from '../../../domain/checkout/model/webhook-endpoint.js';

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/** USDC 6-decimal amount as a positive integer string. Capped at 18 digits
 *  to fit comfortably below 2**63 (matches mhUSDC native uint64).
 *
 *  Third-pass review (Arch M-1): tightened from `/^\d{1,18}$/` to require
 *  a leading 1-9. Pre-fix the dashboard accepted `0`/`00`/`007` while the
 *  agent path rejected them (`^[1-9]\d*$` in `usd6Schema`). The two
 *  surfaces minted divergent shapes for the same operation — a $0 session
 *  is meaningless. Both surfaces now agree at the wire boundary. */
const AMOUNT_USD6_RE = /^[1-9]\d{0,17}$/;

/**
 * Wave 4 §5 Path D/C — successUrl / cancelUrl validator.
 *
 * `z.string().url()` accepts ANY parseable URL — including `javascript:`,
 * `data:`, `vbscript:`, `file:`, `internal.local`, AWS-metadata IPs etc.
 * These URLs are persisted in cleartext metadata and surfaced to issuer
 * dashboard reads + (Wave 5 / future-redirect-on-success) potentially
 * to the buyer page. A stored `javascript:` payload becomes a reflected
 * XSS the moment the buyer page wires `window.location.assign(...)`;
 * an internal hostname becomes an SSRF probe.
 *
 * Restrict to `https://` only — with a single explicit allowance for
 * `http://localhost*` for dev/test convenience (mirror of the
 * RegisterWebhookEndpointUseCase SSRF posture).
 */
function checkoutRedirectUrl() {
  return z
    .string()
    .max(512)
    .superRefine((raw, ctx) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be a valid URL',
        });
        return;
      }
      if (u.protocol === 'https:') return;
      if (u.protocol === 'http:') {
        const h = u.hostname;
        if (
          h === 'localhost'
          || h === '127.0.0.1'
          || h === '::1'
          || h === '[::1]'
        ) {
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
    });
}

const MetadataSchema = z
  .object({
    issuerAddress: z.string().regex(HEX_ADDRESS),
    tokenAddress: z.string().regex(HEX_ADDRESS),
    tokenSymbol: z.string().min(1).max(16),
    issuerLabel: z.string().max(120).nullable().optional(),
    description: z.string().min(1).max(280),
    successUrl: checkoutRedirectUrl().nullable().optional(),
    cancelUrl: checkoutRedirectUrl().nullable().optional(),
  })
  .strict();

const PayloadSchema = z
  .object({
    amountUsd6: z.string().regex(AMOUNT_USD6_RE),
    memo: z.string().max(280).optional(),
    referenceId: z.string().max(64).optional(),
  })
  .strict();

export const CreateCheckoutSessionDtoSchema = z
  .object({
    metadata: MetadataSchema,
    payload: PayloadSchema,
    /** TTL override; default 30min, max 24h. */
    ttlSec: z.number().int().positive().max(86400).optional(),
  })
  .strict();
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;

export const TransitionCheckoutSessionDtoSchema = z
  .object({
    sessionId: z.string().regex(CHECKOUT_SESSION_ID_RE),
    /** New status — `settled` is REJECTED at the use case layer. */
    newStatus: z.enum(CHECKOUT_SESSION_STATUS_VALUES as unknown as [string, ...string[]]),
    buyerAddress: z.string().regex(HEX_ADDRESS).optional(),
    purchaseTxHash: z.string().regex(TX_HASH_RE).optional(),
  })
  .strict();
export type TransitionCheckoutSessionDto = z.infer<typeof TransitionCheckoutSessionDtoSchema>;

export const RegisterWebhookEndpointDtoSchema = z
  .object({
    url: z.string().url().max(512),
    enabledEvents: z
      .array(z.enum(WEBHOOK_EVENT_TYPE_VALUES as unknown as [string, ...string[]]))
      .max(32)
      .optional(),
  })
  .strict();
export type RegisterWebhookEndpointDto = z.infer<typeof RegisterWebhookEndpointDtoSchema>;

export const DisableWebhookEndpointDtoSchema = z
  .object({
    endpointId: z.string().regex(WEBHOOK_ENDPOINT_ID_RE),
  })
  .strict();
export type DisableWebhookEndpointDto = z.infer<typeof DisableWebhookEndpointDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Wave 4 / §5 Path D — issuer-side read endpoints
// ─────────────────────────────────────────────────────────────────────
//
// Cursor is base64url-encoded `{createdAtMs}.{sessionId}` — opaque to the
// client. Validated structurally at the schema layer; the use-case layer
// decodes via `parseSessionCursor` so a malformed cursor surfaces as a
// clean 400 rather than a 500.

const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export const ListCheckoutSessionsRequestSchema = z
  .object({
    status: z.enum(CHECKOUT_SESSION_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
    cursor: z.string().regex(CURSOR_RE).optional(),
    /** Page size — server caps at 50 (use-case-level cap; repo enforces 200). */
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type ListCheckoutSessionsRequest = z.infer<typeof ListCheckoutSessionsRequestSchema>;

export const GetCheckoutSessionRequestSchema = z
  .object({
    id: z.string().regex(CHECKOUT_SESSION_ID_RE),
  })
  .strict();
export type GetCheckoutSessionRequest = z.infer<typeof GetCheckoutSessionRequestSchema>;

export const STATS_RANGE_VALUES = ['7d', '30d', 'all'] as const;
export type CheckoutStatsRange = (typeof STATS_RANGE_VALUES)[number];

export const GetCheckoutStatsRequestSchema = z
  .object({
    range: z.enum(STATS_RANGE_VALUES).optional(),
  })
  .strict();
export type GetCheckoutStatsRequest = z.infer<typeof GetCheckoutStatsRequestSchema>;

/**
 * Dashboard session list-item DTO. `encPayload` is INTENTIONALLY OMITTED —
 * the issuer minted the session and already knew the cleartext at create
 * time; surfacing the ciphertext here would let a leaked dashboard read
 * exfiltrate every ciphertext blob, expanding the recoverable-on-key-leak
 * surface. See `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A privacy invariants.
 */
export interface CheckoutSessionListItemDto {
  sessionId: string;
  /** Narrowed to the domain enum (arch-review HIGH-1 fix) — was `string`
   *  pre-fix, which silently invited frontend ↔ backend drift if a
   *  future status value landed on the backend without a frontend bump. */
  status: CheckoutSessionStatus;
  metadata: {
    issuerAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    issuerLabel: string | null;
    description: string;
    successUrl: string | null;
    cancelUrl: string | null;
  };
  buyerAddress: string | null;
  purchaseTxHash: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListCheckoutSessionsResponseDto {
  sessions: CheckoutSessionListItemDto[];
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface GetCheckoutSessionResponseDto {
  session: CheckoutSessionListItemDto;
}

/**
 * Webhook list-item DTO. The signing-secret HINT is a Stripe-style masked
 * preview (`whsec_xxxxxx…abcd`) — the full secret was returned ONCE at
 * register time and is NEVER re-surfaced. See §1.A invariant 2.
 */
export interface WebhookEndpointListItemDto {
  endpointId: string;
  url: string;
  enabledEvents: string[];
  signingSecretHint: string;
  disabledAt: string | null;
  createdAt: string;
}

export interface ListWebhookEndpointsResponseDto {
  endpoints: WebhookEndpointListItemDto[];
}

/**
 * Stats DTO. Count-only — amount aggregation is structurally impossible
 * because amounts live encrypted at rest behind a fragment key the
 * backend never sees. See §1.A invariant 3.
 */
export interface CheckoutStatsResponseDto {
  range: CheckoutStatsRange;
  total: number;
  /** Narrowed to the domain enum (arch-review HIGH-1 fix). Every key
   *  in the response IS one of `CHECKOUT_SESSION_STATUS_VALUES`; the
   *  use-case `Object.fromEntries` over that const list guarantees a
   *  full, exhaustive map (no missing-status undefined branches on
   *  the frontend). */
  byStatus: Record<CheckoutSessionStatus, number>;
  /** settled / total — count of fully-reconciled sessions divided by
   *  total minted in the range. 0 when total = 0; rounded to 4dp. A
   *  Wave 5 follow-up may refine to a cohort-shaped funnel; today the
   *  simple rate matches the implementation in get-issuer-stats. */
  conversionRate: number;
  /** UTC-day buckets, oldest-first, gaps filled with zero. */
  daily: Array<{ bucketMs: number; count: number }>;
}
