import type { IPortfolioRepository } from '../../../domain/portfolio/repository/portfolio.repository.js';

export interface PortfolioPositionDto {
  token_address: string;
  token_symbol: string;
  last_synced_at: string | null;
}

export interface PortfolioResponseDto {
  positions: PortfolioPositionDto[];
  total_tokens: number;
}

export class GetPortfolioUseCase {
  constructor(private readonly portfolioRepo: IPortfolioRepository) {}

  async execute(userId: string): Promise<PortfolioResponseDto> {
    const positions = await this.portfolioRepo.findByUserId(userId);

    return {
      positions: positions.map((p) => ({
        token_address: p.tokenAddress,
        token_symbol: p.tokenSymbol,
        last_synced_at: p.lastSyncedAt?.toISOString() ?? null,
      })),
      total_tokens: positions.length,
    };
  }
}
