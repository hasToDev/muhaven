import { ApplicationHttpError } from '../../../core/errors.js';
import type { CheckoutSession, CheckoutSessionStatus } from '../../../domain/checkout/model/checkout-session.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type {
  CheckoutSessionListItemDto,
  ListCheckoutSessionsResponseDto,
} from '../../dto/checkout/checkout.dto.js';
import { decodeSessionCursor, encodeSessionCursor } from './session-cursor.js';

/**
 * Wave 4 §5 Path D — list issuer's hosted-checkout sessions.
 *
 * Scoped to `authPayload.userId` — issuers cannot read peers' sessions
 * even with a valid JWT (mirrors the F2 lifecycle posture, see
 * `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.B).
 *
 * Privacy boundary: the response shape omits `encPayload` so a leaked
 * dashboard read cannot exfiltrate ciphertext blobs. The issuer minted
 * the session and already knew the cleartext — surfacing it again would
 * expand the recoverable-on-key-leak surface for no UX benefit.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface ListCheckoutSessionsInput {
  issuerUserId: string;
  status?: CheckoutSessionStatus;
  cursor?: string;
  limit?: number;
}

export class ListCheckoutSessionsUseCase {
  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(input: ListCheckoutSessionsInput): Promise<ListCheckoutSessionsResponseDto> {
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before checkout-sessions list',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const cursor = decodeSessionCursor(input.cursor);

    const { sessions, nextCursor } = await this.sessionRepo.findByIssuerUserId(
      input.issuerUserId,
      { status: input.status, limit, cursor },
    );

    return {
      sessions: sessions.map(toListItem),
      nextCursor: nextCursor ? encodeSessionCursor(nextCursor) : null,
    };
  }
}

export function toListItem(session: CheckoutSession): CheckoutSessionListItemDto {
  return {
    sessionId: session.sessionId,
    status: session.status,
    metadata: {
      issuerAddress: session.metadata.issuerAddress,
      tokenAddress: session.metadata.tokenAddress,
      tokenSymbol: session.metadata.tokenSymbol,
      issuerLabel: session.metadata.issuerLabel ?? null,
      description: session.metadata.description,
      successUrl: session.metadata.successUrl ?? null,
      cancelUrl: session.metadata.cancelUrl ?? null,
    },
    buyerAddress: session.buyerAddress,
    purchaseTxHash: session.purchaseTxHash,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
