import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../domain/nav-history/repository/nav-history.repository.js';
import type { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type { NavSnapshot } from '../../../domain/nav-history/model/nav-snapshot.js';
import type { TokenResponseDto, LatestNavDto } from '../../dto/token/token-response.dto.js';

function navToDto(snapshot: NavSnapshot): LatestNavDto {
  return {
    nav: snapshot.nav,
    apy: snapshot.apy ?? null,
    total_aum: snapshot.totalAum ?? null,
    yield_rate: snapshot.yieldRate ?? null,
    source: snapshot.source,
    source_type: snapshot.sourceType,
    source_timestamp: snapshot.sourceTimestamp?.toISOString() ?? null,
    fetched_at: snapshot.fetchedAt.toISOString(),
  };
}

function toDto(token: RwaToken, latestNav: NavSnapshot | null): TokenResponseDto {
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
    latest_nav: latestNav ? navToDto(latestNav) : null,
  };
}

export class GetTokensUseCase {
  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly navRepo?: INavHistoryRepository,
  ) {}

  async execute(): Promise<{ tokens: TokenResponseDto[] }> {
    const tokens = await this.tokenRepo.findAll();

    // Build address → latest NAV lookup
    const navMap = new Map<string, NavSnapshot>();
    if (this.navRepo) {
      const navSnapshots = await this.navRepo.findLatestForAllTokens();
      for (const snap of navSnapshots) {
        navMap.set(snap.tokenAddress, snap);
      }
    }

    return { tokens: tokens.map((t) => toDto(t, navMap.get(t.address) ?? null)) };
  }
}

export class GetTokenByAddressUseCase {
  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly navRepo?: INavHistoryRepository,
  ) {}

  async execute(address: string): Promise<TokenResponseDto | null> {
    const token = await this.tokenRepo.findByAddress(address);
    if (!token) return null;

    let latestNav: NavSnapshot | null = null;
    if (this.navRepo) {
      latestNav = await this.navRepo.findLatestByToken(address);
    }

    return toDto(token, latestNav);
  }
}
