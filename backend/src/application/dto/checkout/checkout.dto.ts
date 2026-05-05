import { z } from 'zod';
import {
  CHECKOUT_SESSION_ID_RE,
  CHECKOUT_SESSION_STATUS_VALUES,
} from '../../../domain/checkout/model/checkout-session.js';
import { WEBHOOK_EVENT_TYPE_VALUES, WEBHOOK_ENDPOINT_ID_RE } from '../../../domain/checkout/model/webhook-endpoint.js';

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/** USDC 6-decimal amount as a non-negative decimal string. Capped at 18
 *  digits to fit comfortably below 2**63 (matches PUSDC native uint64). */
const AMOUNT_USD6_RE = /^\d{1,18}$/;

const MetadataSchema = z
  .object({
    issuerAddress: z.string().regex(HEX_ADDRESS),
    tokenAddress: z.string().regex(HEX_ADDRESS),
    tokenSymbol: z.string().min(1).max(16),
    issuerLabel: z.string().max(120).nullable().optional(),
    description: z.string().min(1).max(280),
    successUrl: z.string().url().max(512).nullable().optional(),
    cancelUrl: z.string().url().max(512).nullable().optional(),
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
