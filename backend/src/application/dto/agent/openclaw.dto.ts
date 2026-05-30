import { z } from 'zod';

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const INTENT_ID_RE = /^oci_[A-Z0-9]{26}$/;
const LINK_CODE_RE = /^[A-Z0-9]{8}$/;
const OTP_RE = /^\d{6}$/;
/** USDC 6-decimal amount as a non-negative decimal string. Capped at 18
 *  digits to fit comfortably below 2**63 (matches mhUSDC native uint64). */
const AMOUNT_USD6_RE = /^\d{1,18}$/;

const PayloadSchema = z
  .object({
    token: z.string().regex(HEX_ADDRESS),
    summary: z.string().min(1).max(280),
    issuerLabel: z.string().max(120).optional(),
    escrowId: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export const CreateOpenClawIntentDtoSchema = z
  .object({
    kind: z.enum(['buy', 'claim']),
    amountUsd6: z.string().regex(AMOUNT_USD6_RE),
    payload: PayloadSchema,
    telegramChatId: z.string().regex(/^-?\d{1,32}$/).optional(),
  })
  .strict();
export type CreateOpenClawIntentDto = z.infer<typeof CreateOpenClawIntentDtoSchema>;

export const ConfirmOpenClawIntentDtoSchema = z
  .object({
    intentId: z.string().regex(INTENT_ID_RE),
    otp: z.string().regex(OTP_RE).optional(),
    /**
     * Mini-App-only: the verified `tgWebAppData` initData query string.
     * The backend HMAC-verifies this against the bot token before
     * accepting the confirmation. Capped at 4KB — real initData is
     * <2KB; the larger cap is a DoS guard (M-4).
     */
    telegramInitData: z.string().min(1).max(4 * 1024).optional(),
    /**
     * H-2 placeholder: passkey assertion blob for the
     * `passkey_deeplink` tier. Wave 4 accepts any non-empty string
     * (presence-only check) so the wire shape is stable; Wave 5 swaps
     * the value space to a structured `{credentialId, authenticatorData,
     * clientDataJSON, signature}` payload that the backend verifies
     * against a server-issued challenge. DO NOT rely on the current
     * string-shape externally.
     */
    passkeyAssertion: z.string().min(1).max(8 * 1024).optional(),
  })
  .strict();
export type ConfirmOpenClawIntentDto = z.infer<typeof ConfirmOpenClawIntentDtoSchema>;

export const DenyOpenClawIntentDtoSchema = z
  .object({
    intentId: z.string().regex(INTENT_ID_RE),
    reason: z.string().max(200).optional(),
    telegramInitData: z.string().min(1).max(4 * 1024).optional(),
  })
  .strict();
export type DenyOpenClawIntentDto = z.infer<typeof DenyOpenClawIntentDtoSchema>;

export const TelegramLinkConsumeDtoSchema = z
  .object({
    linkCode: z.string().regex(LINK_CODE_RE),
    telegramChatId: z.string().regex(/^-?\d{1,32}$/),
    telegramUserId: z.string().regex(/^\d{1,32}$/),
    telegramUsername: z.string().max(64).nullable().optional(),
  })
  .strict();
export type TelegramLinkConsumeDto = z.infer<typeof TelegramLinkConsumeDtoSchema>;

/**
 * Wave 5 Option D · C5 — Telegram `/revoke_session` kill-switch. The bot
 * worker forwards only the `telegramChatId` (the chat that issued the
 * command); the backend resolves the bound MuHaven user via
 * `telegram_links` and revokes every active scoped session for that user.
 * No user-supplied sessionId — the chat binding is the sole authority,
 * so a service-secret holder cannot revoke a session it does not own a
 * chat binding for.
 */
export const TelegramRevokeSessionDtoSchema = z
  .object({
    telegramChatId: z.string().regex(/^-?\d{1,32}$/),
  })
  .strict();
export type TelegramRevokeSessionDto = z.infer<typeof TelegramRevokeSessionDtoSchema>;

// Plan A (2026-05-15) — dashboard-driven unlink. Body is OPTIONAL; the
// route handler reads `userId` from the JWT and unlinks every active
// row when chatId is omitted (sidebar's "Unlink" CTA).
export const TelegramLinkUnlinkDtoSchema = z
  .object({
    telegramChatId: z.string().regex(/^-?\d{1,32}$/).optional(),
  })
  .strict();
export type TelegramLinkUnlinkDto = z.infer<typeof TelegramLinkUnlinkDtoSchema>;
