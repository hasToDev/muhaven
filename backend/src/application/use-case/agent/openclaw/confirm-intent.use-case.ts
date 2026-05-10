import { ApplicationHttpError } from '../../../../core/errors.js';
import {
  OpenClawIntent,
  OpenClawIntentStatus,
  OpenClawIntentTier,
} from '../../../../domain/agent/model/openclaw-intent.js';
import type { IOpenClawIntentRepository } from '../../../../domain/agent/repository/openclaw-intent.repository.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import { OpenClawIntentKind } from '../../../../domain/agent/model/openclaw-intent.js';
import type { OpenClawIntentEventsChannel } from '../../../../infrastructure/agent/openclaw-intent-events.channel.js';

export interface ConfirmOpenClawIntentInput {
  intentId: string;
  userId: string;
  /** Tier-keyed: required for `mini_app_otp`, ignored otherwise. */
  otp?: string;
  /** Optional informational reason for audit trail. */
  source?: 'telegram_inline' | 'mini_app' | 'dashboard_passkey';
  now?: Date;
}

export interface DenyOpenClawIntentInput {
  intentId: string;
  userId: string;
  reason?: string;
  now?: Date;
}

export interface LookupOpenClawIntentInput {
  intentId: string;
  /**
   * Optional — when provided, asserts the row's userId matches. The
   * dashboard `/agent/confirm` page passes the authenticated user's id
   * here so a stolen intent id from another tenant cannot be inspected.
   */
  expectedUserId?: string;
  /**
   * Optional — when provided, asserts the row's telegramChatId matches.
   * The Mini App passes its verified initData chatId so a malicious
   * Mini App in a different chat cannot inspect another user's intent.
   */
  expectedChatId?: string;
  /** Inject a clock for tests — production uses `new Date()`. */
  now?: Date;
}

export interface PublicIntentSummary {
  intentId: string;
  kind: 'buy' | 'claim';
  tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink';
  status: 'pending' | 'confirmed' | 'consumed' | 'denied' | 'expired';
  amountUsd6: string;
  payload: {
    token: string;
    summary: string;
    issuerLabel?: string;
    escrowId?: string;
  };
  intentHash: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Confirm an intent — moves status from `pending` to `confirmed`. The
 * confirmation surface (Telegram inline, Mini App OTP, dashboard
 * passkey) is keyed off the intent's tier; this use case enforces the
 * OTP for mini_app_otp tier and trusts upstream auth for the others.
 *
 * NEVER auto-submits the underlying UserOp. Submission is a separate
 * step (consume) that requires the broker / kernel to sign — this
 * keeps the lethal-trifecta defence intact (signing in the broker, not
 * here).
 */
export class ConfirmOpenClawIntentUseCase {
  constructor(
    private readonly intentRepo: IOpenClawIntentRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
    /** Wave 4 P4 — optional SSE fan-out for the dashboard auto-fire UX.
     *  When wired (via container), publishes an `intent_confirmed` event
     *  after the audit row lands so any open `/agent` tab for the same
     *  user receives the event and the runner auto-fires the on-chain
     *  leg without the user re-clicking Authorize. Pass `null` to
     *  disable (default; legacy unit tests). */
    private readonly intentEventsChannel: OpenClawIntentEventsChannel | null = null,
  ) {}

  async execute(input: ConfirmOpenClawIntentInput): Promise<OpenClawIntent> {
    const now = input.now ?? new Date();
    await this.intentRepo.sweepExpired(now);

    const existing = await this.intentRepo.findById(input.intentId);
    if (!existing || existing.userId !== input.userId) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (existing.status === OpenClawIntentStatus.Consumed) {
      throw new ApplicationHttpError(410, 'intent already consumed');
    }
    if (existing.status === OpenClawIntentStatus.Confirmed) {
      throw new ApplicationHttpError(409, 'intent already confirmed');
    }
    if (existing.status === OpenClawIntentStatus.Denied) {
      throw new ApplicationHttpError(410, 'intent denied');
    }
    if (existing.status === OpenClawIntentStatus.Expired || existing.isExpired(now)) {
      throw new ApplicationHttpError(410, 'intent expired');
    }

    if (existing.tier === OpenClawIntentTier.MiniAppOtp) {
      if (!input.otp) {
        throw ApplicationHttpError.badRequest('otp required for this tier');
      }
      // Length-equality check first to keep the comparison constant-time-ish
      // — a length mismatch is a fast-fail; on length match we delegate
      // to the repo's atomic UPDATE which compares the OTP under SQL
      // equality. SQL equality is not strictly constant-time, but the
      // OTP is short-lived (5min) and rate-limited at the route layer.
      if (input.otp.length !== 6 || !/^\d{6}$/.test(input.otp)) {
        throw ApplicationHttpError.badRequest('otp must be 6 digits');
      }
    }

    const confirmed = await this.intentRepo.confirm({
      intentId: input.intentId,
      userId: input.userId,
      otp: input.otp ?? null,
      now,
    });
    if (!confirmed) {
      // Race: someone else flipped the row between our pre-check and
      // the atomic UPDATE. Surface as 409.
      throw new ApplicationHttpError(409, 'confirmation race lost');
    }

    await this.appendAudit.execute({
      userId: input.userId,
      surface: Surface.OpenClaw,
      eventType: AuditEventType.PermitGranted,
      actionId: confirmed.kind === OpenClawIntentKind.Buy ? ActionId.Buy : ActionId.Claim,
      metadata: {
        intentId: confirmed.intentId,
        tier: confirmed.tier,
        intentHash: confirmed.intentHash,
        amountUsd6: confirmed.amountUsd6.toString(),
        source: input.source ?? null,
      },
      now,
    });

    // Wave 4 P4 — fan out to any open dashboard SSE subscriber for this
    // user. The dashboard runner listens on the `intent_confirmed` event
    // and auto-fires the on-chain leg if the open ConfirmModal's
    // openClawIntentId matches. Best-effort: subscribers may have died
    // between subscribe and now (publish swallows write failures + sweeps
    // the dead subscriber). Privacy posture: payload carries cleartext
    // the user already saw the LLM emit at propose time — never the
    // confirm-token, never the OTP, never an encrypted handle.
    if (this.intentEventsChannel) {
      this.intentEventsChannel.publish({
        type: 'intent_confirmed',
        userId: input.userId,
        intentId: confirmed.intentId,
        payload: {
          kind: confirmed.kind,
          tier: confirmed.tier,
          ...(input.source ? { source: input.source } : {}),
          tokenAddress: confirmed.payload.token,
          amountUsd6: confirmed.amountUsd6.toString(),
        },
      });
    }

    return confirmed;
  }
}

export class DenyOpenClawIntentUseCase {
  constructor(
    private readonly intentRepo: IOpenClawIntentRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
    /** Wave 4 P4 — optional SSE fan-out (parallels the confirm path).
     *  Lets the open dashboard tab auto-close the ConfirmModal when the
     *  user denies from Telegram. */
    private readonly intentEventsChannel: OpenClawIntentEventsChannel | null = null,
  ) {}

  async execute(input: DenyOpenClawIntentInput): Promise<OpenClawIntent> {
    const now = input.now ?? new Date();
    await this.intentRepo.sweepExpired(now);
    const existing = await this.intentRepo.findById(input.intentId);
    if (!existing || existing.userId !== input.userId) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (existing.status !== OpenClawIntentStatus.Pending) {
      throw new ApplicationHttpError(410, 'intent not pending');
    }
    const denied = await this.intentRepo.deny({
      intentId: input.intentId,
      userId: input.userId,
      reason: input.reason,
      now,
    });
    if (!denied) {
      throw new ApplicationHttpError(409, 'deny race lost');
    }
    await this.appendAudit.execute({
      userId: input.userId,
      surface: Surface.OpenClaw,
      eventType: AuditEventType.PermitRevoked,
      metadata: {
        intentId: denied.intentId,
        tier: denied.tier,
        reason: input.reason ?? null,
      },
      now,
    });
    if (this.intentEventsChannel) {
      this.intentEventsChannel.publish({
        type: 'intent_denied',
        userId: input.userId,
        intentId: denied.intentId,
        payload: {
          kind: denied.kind,
          tier: denied.tier,
          tokenAddress: denied.payload.token,
          amountUsd6: denied.amountUsd6.toString(),
        },
      });
    }
    return denied;
  }
}

/**
 * Lookup an intent for the dashboard / Mini App preview. Uses
 * collapsed-oracle responses — any failure mode (not found, wrong user,
 * wrong chat, expired, consumed) returns 404 to defeat enumeration
 * attacks against intent ids. The intentHash is exposed so the user can
 * cross-check the displayed summary against what the LLM emitted.
 */
export class LookupOpenClawIntentUseCase {
  constructor(private readonly intentRepo: IOpenClawIntentRepository) {}

  async execute(input: LookupOpenClawIntentInput): Promise<PublicIntentSummary> {
    const now = input.now ?? new Date();
    await this.intentRepo.sweepExpired(now);
    const existing = await this.intentRepo.findById(input.intentId);
    if (!existing) throw ApplicationHttpError.notFound('intent not found');
    if (existing.status !== OpenClawIntentStatus.Pending) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (existing.isExpired(now)) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (input.expectedUserId !== undefined && existing.userId !== input.expectedUserId) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (
      input.expectedChatId !== undefined &&
      existing.telegramChatId !== input.expectedChatId
    ) {
      throw ApplicationHttpError.notFound('intent not found');
    }

    return {
      intentId: existing.intentId,
      kind: existing.kind,
      tier: existing.tier,
      status: existing.status,
      amountUsd6: existing.amountUsd6.toString(),
      payload: {
        token: existing.payload.token,
        summary: existing.payload.summary,
        ...(existing.payload.issuerLabel ? { issuerLabel: existing.payload.issuerLabel } : {}),
        ...(existing.payload.escrowId ? { escrowId: existing.payload.escrowId } : {}),
      },
      intentHash: existing.intentHash,
      expiresAt: existing.expiresAt.toISOString(),
      createdAt: existing.createdAt.toISOString(),
    };
  }
}
