import { randomUUID } from 'crypto';
import { SiweMessage } from 'siwe';
import type { ISessionRepository } from '../../../domain/auth/repository/session.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import { Session } from '../../../domain/auth/model/session.js';
import { User } from '../../../domain/auth/model/user.js';
import type { JwtService } from '../../../infrastructure/auth/jwt.service.js';
import type { NonceService } from '../../../infrastructure/auth/nonce.service.js';
import type { SiweVerifier } from '../../../infrastructure/auth/siwe-verifier.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import type { VerifyWalletDto } from '../../dto/auth/verify-wallet.dto.js';
import type { TokenResponse } from '../../dto/auth/verify-wallet.dto.js';

export interface SessionMetadata {
  userAgent?: string;
  ipAddress?: string;
}

export class VerifyWalletUseCase {
  constructor(
    private readonly siweVerifier: SiweVerifier,
    private readonly nonceService: NonceService,
    private readonly userRepository: IUserRepository,
    private readonly sessionRepository: ISessionRepository,
    private readonly jwtService: JwtService,
  ) {}

  async execute(dto: VerifyWalletDto, meta?: SessionMetadata): Promise<TokenResponse> {
    const result = await this.siweVerifier.verify(dto.message, dto.signature);
    if (!result.valid) {
      throw ApplicationHttpError.unauthorized('Invalid SIWE signature');
    }

    // Defense-in-depth: ensure the SIWE message address matches the claimed wallet
    if (result.address.toLowerCase() !== dto.wallet_address.toLowerCase()) {
      throw ApplicationHttpError.unauthorized('SIWE address does not match wallet_address');
    }

    const siweMessage = new SiweMessage(dto.message);
    const nonceValid = await this.nonceService.verifyNonce(dto.wallet_address, siweMessage.nonce);
    if (!nonceValid) {
      throw ApplicationHttpError.unauthorized('Invalid or expired nonce');
    }

    let user = await this.userRepository.findByWalletAddress(dto.wallet_address);
    if (!user) {
      // First-time registration: a role is REQUIRED on the DTO. Login
      // mode UIs may omit the role to defer to the existing user's
      // record, but a new wallet has no record to defer to.
      if (!dto.role) {
        throw ApplicationHttpError.badRequest(
          'role is required to register a new wallet',
        );
      }
      user = new User({
        id: randomUUID(),
        walletAddress: dto.wallet_address,
        walletProvider: dto.wallet_provider ?? 'zerodev',
        role: dto.role,
        email: dto.email,
        createdAt: new Date(),
      });
      await this.userRepository.save(user);
    } else if (dto.role && dto.role !== user.role) {
      // Phase 9.A · role guardrail. Existing wallet's role is locked at
      // registration; reject role-mismatched login with a structured 403
      // so the frontend can auto-flip the role toggle to the registered
      // value. The previous behaviour silently overwrote `user.role` on
      // every login, which let any user act as either side and broke the
      // RWA-platform invariant that issuer ≠ investor for a single
      // counterparty identity.
      throw ApplicationHttpError.forbidden(
        `Wallet registered as ${user.role}`,
        { code: 'ROLE_MISMATCH', registeredRole: user.role },
      );
    }
    // When `dto.role` is omitted on login (the post-Phase-9.A
    // flow), `user.role` is the source of truth and falls through
    // to the JWT generation below unchanged.

    const tokenPair = await this.jwtService.generateTokenPair({
      sub: user.id,
      walletAddress: user.walletAddress,
      walletProvider: user.walletProvider,
      role: dto.role ?? user.role,
      email: user.email,
    });

    const session = new Session({
      id: randomUUID(),
      userId: user.id,
      refreshToken: tokenPair.refreshToken,
      expiresAt: new Date(Date.now() + tokenPair.refreshExpiresIn * 1000),
      createdAt: new Date(),
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });
    await this.sessionRepository.save(session);

    return {
      access_token: tokenPair.accessToken,
      refresh_token: tokenPair.refreshToken,
      token_type: 'Bearer',
      expires_in: tokenPair.expiresIn,
    };
  }
}
