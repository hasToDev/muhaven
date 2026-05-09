import { randomUUID } from 'crypto';
import { ApplicationHttpError } from '../../../core/errors.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { ISessionRepository } from '../../../domain/auth/repository/session.repository.js';
import type { IPortfolioRepository } from '../../../domain/portfolio/repository/portfolio.repository.js';
import type { ITaxEventRepository } from '../../../domain/tax-event/repository/tax-event.repository.js';
import { Session } from '../../../domain/auth/model/session.js';
import { User, type IssuerKybSubmission } from '../../../domain/auth/model/user.js';
import type { JwtService } from '../../../infrastructure/auth/jwt.service.js';
import type { ApplyIssuerDto, ApplyIssuerResponseDto } from '../../dto/issuer/apply-issuer.dto.js';
import type { SessionMetadata } from '../auth/verify-wallet.use-case.js';

/**
 * Phase 9.A · Expansion (F2) — self-serve issuer onboarding step 1.
 *
 * Flips the bearer's user row from `unregistered` to `approved` (with
 * `role='issuer'`) and returns a freshly-issued token pair so the SPA
 * can replace the in-memory JWT with one carrying the new role. The
 * legacy session, if any, stays alive — the wizard route guard reads
 * the new token, and the old session simply ages out on its own TTL
 * (no bulk-invalidate today).
 *
 * Guardrails:
 *   - Already approved (idempotency double-click): 409 ALREADY_APPROVED.
 *   - Active investor activity (any portfolio row OR any RWA-related
 *     tax_event row — Acquisition, Disposition, IncomeAccrual,
 *     FeeEvent, Transfer — keyed by the wallet): 403
 *     HAS_INVESTOR_ACTIVITY. Same kernel rotating roles mid-flight
 *     breaks every audit trail; force the applicant to register a new
 *     kernel (matches Phase 9.A role-guardrail posture from
 *     `verify-wallet.use-case.ts`). Cash-rail markers (Wrap/Unwrap on
 *     MuHavenStable) are deliberately NOT in the gate set — wrapping
 *     USDC is a payment-rail step, not investor history, and a fresh
 *     applicant who just funded their wallet must not be locked out.
 *   - Suspended: 403 ISSUER_SUSPENDED.
 */
export class ApplyIssuerUseCase {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly sessionRepository: ISessionRepository,
    private readonly portfolioRepository: IPortfolioRepository,
    private readonly taxEventRepository: ITaxEventRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(
    userId: string,
    dto: ApplyIssuerDto,
    meta?: SessionMetadata,
  ): Promise<ApplyIssuerResponseDto> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw ApplicationHttpError.unauthorized('User not found');
    }

    if (user.issuerStatus === 'approved') {
      throw ApplicationHttpError.conflict('Issuer already approved', {
        code: 'ALREADY_APPROVED',
      });
    }
    if (user.issuerStatus === 'suspended') {
      throw ApplicationHttpError.forbidden('Issuer suspended', {
        code: 'ISSUER_SUSPENDED',
      });
    }

    // Anti-self-dealing guardrail: if this kernel has any investor
    // history, refuse the role flip so the audit trail stays clean.
    // Both checks are O(1) — one indexed query each.
    const portfolios = await this.portfolioRepository.findByUserId(user.id);
    if (portfolios.length > 0) {
      throw ApplicationHttpError.forbidden(
        'Wallet has investor activity; register a new kernel for issuer onboarding',
        { code: 'HAS_INVESTOR_ACTIVITY', source: 'portfolios' },
      );
    }
    const hasInvestorActivity = await this.taxEventRepository.hasInvestorActivity(
      user.walletAddress,
    );
    if (hasInvestorActivity) {
      throw ApplicationHttpError.forbidden(
        'Wallet has investor activity; register a new kernel for issuer onboarding',
        { code: 'HAS_INVESTOR_ACTIVITY', source: 'tax_events' },
      );
    }

    const submission: IssuerKybSubmission = {
      display_name: dto.display_name,
      jurisdiction: dto.jurisdiction,
      contact_email: dto.contact_email,
      attestation: dto.attestation,
      submitted_at: new Date().toISOString(),
    };

    const approvedAt = new Date();
    const updated = new User({
      id: user.id,
      walletAddress: user.walletAddress,
      walletProvider: user.walletProvider,
      role: 'issuer',
      email: dto.contact_email,
      createdAt: user.createdAt,
      issuerStatus: 'approved',
      issuerDisplayName: dto.display_name,
      issuerJurisdiction: dto.jurisdiction,
      issuerApprovedAt: approvedAt,
      issuerKybSubmission: submission,
    });
    await this.userRepository.save(updated);

    const tokenPair = await this.jwtService.generateTokenPair({
      sub: updated.id,
      walletAddress: updated.walletAddress,
      walletProvider: updated.walletProvider,
      role: 'issuer',
      email: updated.email,
    });

    const session = new Session({
      id: randomUUID(),
      userId: updated.id,
      refreshToken: tokenPair.refreshToken,
      expiresAt: new Date(Date.now() + tokenPair.refreshExpiresIn * 1000),
      createdAt: new Date(),
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });
    await this.sessionRepository.save(session);

    return {
      user: {
        id: updated.id,
        wallet_address: updated.walletAddress,
        role: 'issuer',
        issuer_status: 'approved',
        issuer_display_name: dto.display_name,
        issuer_jurisdiction: dto.jurisdiction,
        issuer_approved_at: approvedAt.toISOString(),
      },
      tokens: {
        access_token: tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
        token_type: 'Bearer',
        expires_in: tokenPair.expiresIn,
      },
    };
  }
}
