import { ApplicationHttpError } from '../../../core/errors.js';
import type { ICheckoutSessionRepository } from '../../../domain/checkout/repository/checkout-session.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { GetCheckoutSessionResponseDto } from '../../dto/checkout/checkout.dto.js';
import { toListItem } from './list-sessions.use-case.js';

/**
 * Wave 4 §5 Path D — get a single session by id for the issuer dashboard.
 *
 * Cross-issuer isolation: a 404 (not 403) is returned when the caller is
 * NOT the issuer-of-record so endpoint-id enumeration can't distinguish
 * "wrong issuer" from "does not exist". Matches the disable-webhook
 * posture established at P5 port-time.
 *
 * Privacy boundary: `encPayload` is NOT surfaced (same rationale as the
 * list endpoint). The buyer-side `LookupCheckoutSessionUseCase` is the
 * sole consumer that returns ciphertext.
 */

export interface GetSessionForIssuerInput {
  issuerUserId: string;
  sessionId: string;
}

export class GetSessionForIssuerUseCase {
  constructor(
    private readonly sessionRepo: ICheckoutSessionRepository,
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(
    input: GetSessionForIssuerInput,
  ): Promise<GetCheckoutSessionResponseDto> {
    const issuer = await this.userRepo.findById(input.issuerUserId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before checkout-session get',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }

    const session = await this.sessionRepo.findById(input.sessionId);
    if (!session || session.issuerUserId !== input.issuerUserId) {
      throw ApplicationHttpError.notFound('checkout session not found');
    }

    return { session: toListItem(session) };
  }
}
