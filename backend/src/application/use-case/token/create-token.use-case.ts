import { randomUUID } from 'node:crypto';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type { CreateTokenDto, TokenResponseDto } from '../../dto/token/token-response.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export class CreateTokenUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(dto: CreateTokenDto, issuerAddress: string): Promise<TokenResponseDto> {
    const existing = await this.tokenRepo.findByAddress(dto.address);
    if (existing) {
      throw ApplicationHttpError.conflict(`Token already registered at address ${dto.address}`);
    }

    const now = new Date();
    const token = new RwaToken({
      id: randomUUID(),
      address: dto.address,
      name: dto.name,
      symbol: dto.symbol,
      issuerAddress,
      apy: dto.apy,
      yieldSchedule: dto.yield_schedule,
      kycTier: dto.kyc_tier,
      assetClass: dto.asset_class,
      minInvestment: dto.min_investment,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await this.tokenRepo.save(token);

    return {
      id: token.id,
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      issuer_address: token.issuerAddress,
      // create-token is the legacy admin endpoint (Wave 3 catalogue
      // seed); the wizard owns issuer KYB now and goes through
      // GetTokens / GetIssuerTokens for display name lookup.
      issuer_display_name: null,
      apy: token.apy ?? null,
      yield_schedule: token.yieldSchedule ?? null,
      kyc_tier: token.kycTier,
      asset_class: token.assetClass,
      min_investment: token.minInvestment ?? null,
      status: token.status,
      created_at: token.createdAt.toISOString(),
      updated_at: token.updatedAt.toISOString(),
      latest_nav: null,
    };
  }
}
