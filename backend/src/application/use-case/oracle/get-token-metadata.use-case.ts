import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type { TokenMetadataRead } from '../../../domain/oracle/model/oracle-payload.js';
import { ApplicationHttpError } from '../../../core/errors.js';

export interface TokenMetadataDto {
  ticker: string;
  display_name: string;
  description: string | null;
  icon_url: string | null;
  color_hex: string | null;
  website: string | null;
  is_yield_bearing: boolean;
  is_yield_bearing_rwaxyz: boolean;
  distributes_income: boolean | null;
  asset_class_slug: string | null;
  asset_class_name: string | null;
  issuer_name: string | null;
  issuer_legal_name: string | null;
  issuer_lei: string | null;
  issuer_country: string | null;
  manager_name: string | null;
  jurisdiction_country: string | null;
  regulatory_framework: string | null;
  governing_body: string | null;
  legal_structure: string | null;
  inception_date: string | null;
  fee_management_bps: number | null;
  fee_performance_bps: number | null;
  fee_structure_description: string | null;
  pm_subscription_frequency: string | null;
  pm_subscription_minimum_dollar: string | null;
  pm_redemption_frequency: string | null;
  pm_kyc_required: boolean | null;
  underlying_tokens: Array<{
    network: string;
    network_id: number | null;
    address: string;
    decimals: number;
    standards: string[] | null;
  }> | null;
  last_refreshed_at: string;
}

function toDto(meta: TokenMetadataRead): TokenMetadataDto {
  return {
    ticker: meta.ticker,
    display_name: meta.displayName,
    description: meta.description,
    icon_url: meta.iconUrl,
    color_hex: meta.colorHex,
    website: meta.website,
    is_yield_bearing: meta.isYieldBearing,
    is_yield_bearing_rwaxyz: meta.isYieldBearingRwaxyz,
    distributes_income: meta.distributesIncome,
    asset_class_slug: meta.assetClassSlug,
    asset_class_name: meta.assetClassName,
    issuer_name: meta.issuerName,
    issuer_legal_name: meta.issuerLegalName,
    issuer_lei: meta.issuerLei,
    issuer_country: meta.issuerCountry,
    manager_name: meta.managerName,
    jurisdiction_country: meta.jurisdictionCountry,
    regulatory_framework: meta.regulatoryFramework,
    governing_body: meta.governingBody,
    legal_structure: meta.legalStructure,
    inception_date: meta.inceptionDate,
    fee_management_bps: meta.feeManagementBps,
    fee_performance_bps: meta.feePerformanceBps,
    fee_structure_description: meta.feeStructureDescription,
    pm_subscription_frequency: meta.pmSubscriptionFrequency,
    pm_subscription_minimum_dollar: meta.pmSubscriptionMinimumDollar,
    pm_redemption_frequency: meta.pmRedemptionFrequency,
    pm_kyc_required: meta.pmKycRequired,
    underlying_tokens:
      meta.underlyingTokens?.map((t) => ({
        network: t.network,
        network_id: t.networkId ?? null,
        address: t.address,
        decimals: t.decimals,
        standards: t.standards ?? null,
      })) ?? null,
    last_refreshed_at: meta.lastRefreshedAt.toISOString(),
  };
}

export class GetTokenMetadataUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(ticker: string): Promise<TokenMetadataDto> {
    const meta = await this.oracleRepo.findMetadata(ticker);
    if (!meta) {
      // Public endpoint — no operator hints leak ("run oracle ingest
      // first" was a stage-debug aid; trimmed for production posture).
      throw ApplicationHttpError.notFound(
        `No metadata for ticker ${ticker}`,
      );
    }
    return toDto(meta);
  }
}
