import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { IssuerStatus } from '../../../domain/auth/model/user.js';
import { ApplicationHttpError } from '../../../core/errors.js';

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
}

export class GetCurrentUserUseCase {
  constructor(private readonly userRepository: IUserRepository) {}

  async execute(userId: string): Promise<UserResponse> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw ApplicationHttpError.notFound('User not found');
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
    };
  }
}
