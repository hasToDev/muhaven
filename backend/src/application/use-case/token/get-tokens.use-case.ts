import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type { TokenResponseDto } from '../../dto/token/token-response.dto.js';

function toDto(token: RwaToken): TokenResponseDto {
  return {
    id: token.id,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    issuer_address: token.issuerAddress,
    apy: token.apy ?? null,
    yield_schedule: token.yieldSchedule ?? null,
    kyc_tier: token.kycTier,
    asset_class: token.assetClass,
    min_investment: token.minInvestment ?? null,
    status: token.status,
    created_at: token.createdAt.toISOString(),
    updated_at: token.updatedAt.toISOString(),
  };
}

export class GetTokensUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(): Promise<{ tokens: TokenResponseDto[] }> {
    const tokens = await this.tokenRepo.findAll();
    return { tokens: tokens.map(toDto) };
  }
}

export class GetTokenByAddressUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(address: string): Promise<TokenResponseDto | null> {
    const token = await this.tokenRepo.findByAddress(address);
    return token ? toDto(token) : null;
  }
}
