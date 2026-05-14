import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { IssuerStatus } from '../../../domain/auth/model/user.js';
import type { ITelegramLinkRepository } from '../../../domain/agent/repository/telegram-link.repository.js';
import { ApplicationHttpError } from '../../../core/errors.js';

/**
 * Plan A (2026-05-15) — telegram-link summary surfaced on /me so the
 * dashboard can render an "already linked" pill in the sidebar without
 * a second round-trip. We surface only the most-recently-linked active
 * row (multiple chats are allowed, but the sidebar pill is single-
 * valued); the modal's Unlink CTA targets the same chatId.
 */
export interface TelegramLinkSummaryDto {
  linked: true;
  telegram_chat_id: string;
  telegram_username: string | null;
  linked_at: string;
}

export interface UserResponse {
  id: string;
  wallet_address: string;
  wallet_provider: string;
  role: string;
  email?: string;
  created_at: string;
  // Phase 9.A · Expansion (F2) — issuer onboarding metadata. Always
  // present so the frontend can drive the `/apply-issuer` route guard
  // and the conditional sidebar nav item without a second roundtrip.
  // For investors this is the default `unregistered` and unused.
  issuer_status: IssuerStatus;
  issuer_display_name?: string;
  issuer_jurisdiction?: string;
  issuer_approved_at?: string;
  // Plan A (2026-05-15). `null` when no active link; otherwise the
  // most-recent active row. Optional in the wire shape so a frontend
  // built against the prior schema doesn't crash on absence.
  telegram_link?: TelegramLinkSummaryDto | null;
}

export class GetCurrentUserUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    /** Optional. When provided, /me populates the `telegram_link` field
     *  from active rows; when null/undefined, the field is omitted. */
    private readonly telegramLinkRepository?: ITelegramLinkRepository,
  ) {}

  async execute(userId: string): Promise<UserResponse> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw ApplicationHttpError.notFound('User not found');
    }

    let telegramLink: TelegramLinkSummaryDto | null = null;
    if (this.telegramLinkRepository) {
      const rows = await this.telegramLinkRepository.findByUserId(userId);
      // Multiple chats may be active simultaneously; pick the most-
      // recently-linked active one for the sidebar pill. The modal's
      // Unlink CTA targets the same chatId.
      const active = rows
        .filter((r) => r.isActive())
        .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime());
      const latest = active[0];
      if (latest) {
        telegramLink = {
          linked: true,
          telegram_chat_id: latest.telegramChatId,
          telegram_username: latest.telegramUsername,
          linked_at: latest.linkedAt.toISOString(),
        };
      }
    }

    return {
      id: user.id,
      wallet_address: user.walletAddress,
      wallet_provider: user.walletProvider,
      role: user.role,
      email: user.email,
      created_at: user.createdAt.toISOString(),
      issuer_status: user.issuerStatus,
      issuer_display_name: user.issuerDisplayName,
      issuer_jurisdiction: user.issuerJurisdiction,
      issuer_approved_at: user.issuerApprovedAt?.toISOString(),
      telegram_link: telegramLink,
    };
  }
}
