import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../domain/nav-history/repository/nav-history.repository.js';
import type { IssuerStatsResponseDto } from '../../dto/issuer/issuer-stats-response.dto.js';

/**
 * Computes aggregate-only issuer stats.
 * Privacy: returns totals only — never individual investor positions.
 */
export class GetIssuerStatsUseCase {
  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly navRepo: INavHistoryRepository,
  ) {}

  async execute(issuerAddress: string): Promise<IssuerStatsResponseDto> {
    const tokens = await this.tokenRepo.findByIssuer(issuerAddress);

    if (tokens.length === 0) {
      return {
        total_aum: null,
        total_investors: 0,
        weighted_apy: null,
        active_tokens: 0,
        total_tokens: 0,
        total_yield_distributed: null,
      };
    }

    const activeTokens = tokens.filter((t) => t.status === 'active');

    // Build NAV lookup for AUM calculation
    const navSnapshots = await this.navRepo.findLatestForAllTokens();
    const navMap = new Map<string, { aum: number; apy: number }>();
    for (const snap of navSnapshots) {
      navMap.set(snap.tokenAddress, {
        aum: snap.totalAum ? parseFloat(snap.totalAum) : 0,
        apy: snap.apy ? parseFloat(snap.apy) : 0,
      });
    }

    // Aggregate stats across issuer's tokens
    let totalAum = 0;
    let weightedApySum = 0;
    let weightTotal = 0;

    for (const token of tokens) {
      const nav = navMap.get(token.address);
      if (nav) {
        totalAum += nav.aum;
        if (nav.apy > 0 && nav.aum > 0) {
          weightedApySum += nav.apy * nav.aum;
          weightTotal += nav.aum;
        }
      }
    }

    const weightedApy = weightTotal > 0 ? weightedApySum / weightTotal : null;

    return {
      total_aum: totalAum > 0 ? totalAum.toFixed(2) : null,
      total_investors: 0, // Populated from on-chain InvestorRegistry — frontend reads directly
      weighted_apy: weightedApy !== null ? weightedApy.toFixed(2) : null,
      active_tokens: activeTokens.length,
      total_tokens: tokens.length,
      total_yield_distributed: null, // Populated from on-chain YieldDistributor — frontend reads directly
    };
  }
}
