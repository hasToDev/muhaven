import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../domain/nav-history/repository/nav-history.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import type { RwaToken } from '../../../domain/token-registry/model/rwa-token.js';
import type { NavSnapshot } from '../../../domain/nav-history/model/nav-snapshot.js';
import type { TokenResponseDto, LatestNavDto } from '../../dto/token/token-response.dto.js';

/**
 * Per-issuer token list. Mirrors `GetTokensUseCase` (the public one)
 * but filters via `tokenRepo.findByIssuer(addr)`. Drives the issuer
 * Tokens / Distribute dashboards which must only show tokens whose
 * legal issuer matches the connected kernel.
 *
 * Phase 9.A · multi-issuer scoping: replaces the prior pattern where
 * every issuer-roled user saw the public catalogue (an `onlyIssuer`
 * on-chain check would have rejected their writes anyway, but
 * surfacing tokens they can't actually distribute on is misleading).
 */
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

function toDto(
  token: RwaToken,
  latestNav: NavSnapshot | null,
  issuerDisplayName: string | null,
): TokenResponseDto {
  return {
    id: token.id,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    issuer_address: token.issuerAddress,
    issuer_display_name: issuerDisplayName,
    apy: token.apy ?? null,
    yield_schedule: token.yieldSchedule ?? null,
    kyc_tier: token.kycTier,
    asset_class: token.assetClass,
    min_investment: token.minInvestment ?? null,
    status: token.status,
    yield_snapshot_address: token.yieldSnapshotAddress ?? null,
    // Wave 5 Slice 1 — the issuer view doesn't surface the per-token queue
    // address (it's an investor-side sell concern). Always null here; the
    // public /api/v1/tokens response is the one that resolves it from the env.
    redemption_queue_address: null,
    created_at: token.createdAt.toISOString(),
    updated_at: token.updatedAt.toISOString(),
    latest_nav: latestNav ? navToDto(latestNav) : null,
  };
}

export class GetIssuerTokensUseCase {
  constructor(
    private readonly tokenRepo: IRwaTokenRepository,
    private readonly navRepo?: INavHistoryRepository,
    private readonly userRepo?: IUserRepository,
  ) {}

  async execute(issuerAddress: string): Promise<{ tokens: TokenResponseDto[] }> {
    const tokens = await this.tokenRepo.findByIssuer(issuerAddress);

    const navMap = new Map<string, NavSnapshot>();
    if (this.navRepo) {
      const navSnapshots = await this.navRepo.findLatestForAllTokens();
      for (const snap of navSnapshots) {
        navMap.set(snap.tokenAddress, snap);
      }
    }

    // Phase 9.A · Expansion (F3) — single issuer, single name lookup.
    let issuerDisplayName: string | null = null;
    if (this.userRepo && tokens.length > 0) {
      const issuer = await this.userRepo.findByWalletAddress(issuerAddress);
      issuerDisplayName = issuer?.issuerDisplayName ?? null;
    }

    return {
      tokens: tokens.map((t) => toDto(t, navMap.get(t.address) ?? null, issuerDisplayName)),
    };
  }
}
