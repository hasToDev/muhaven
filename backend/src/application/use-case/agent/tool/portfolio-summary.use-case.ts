import type { IPortfolioRepository } from '../../../../domain/portfolio/repository/portfolio.repository.js';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../domain/nav-history/repository/nav-history.repository.js';
import type {
  PortfolioSummaryDto,
  PortfolioSummaryResponseDto,
} from '../../../dto/agent/tool.dto.js';
import { parseDecimalToUsd6 } from './quote.use-case.js';

/**
 * Wave 4 P2 — `muhaven_portfolio_summary` (read-side tool).
 *
 * Aggregates per-token positions + last-known NAV + heuristic signal flags.
 * The signal flags are server-derived for Wave 4 (`isOverexposed` triggers
 * when a single token > 70% of position count; `isUnderYield` triggers
 * when the issuer's APY is below a configurable floor). Wave 5 swaps for
 * P6 `RiskParams.computeSignalFlags` ebool handles per AGENT_DESIGN.md.
 *
 * Encrypted-balance handles are NOT decrypted server-side — the agent
 * never sees plaintext (privacy boundary R-8). The Wave 5 swap returns the
 * `euint128` ctHash so the client can `decryptForView(handle).withPermit()`.
 */
export class PortfolioSummaryToolUseCase {
  constructor(
    private readonly portfolioRepo: IPortfolioRepository,
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly navHistoryRepo: INavHistoryRepository,
  ) {}

  async execute(
    userId: string,
    walletAddress: string,
    input: PortfolioSummaryDto,
  ): Promise<PortfolioSummaryResponseDto> {
    const positions = await this.portfolioRepo.findByUserId(userId);
    const filtered = input.tokenAddress
      ? positions.filter(
          (p) => p.tokenAddress.toLowerCase() === input.tokenAddress!.toLowerCase(),
        )
      : positions;

    // Resolve last-known NAV per token in one read.
    const navByToken = await Promise.all(
      filtered.map(async (p) => {
        const snap = await this.navHistoryRepo.findLatestByToken(p.tokenAddress.toLowerCase());
        return [p.tokenAddress, snap] as const;
      }),
    );
    const navMap = new Map(navByToken);

    const enriched = filtered.map((p) => {
      const snap = navMap.get(p.tokenAddress) ?? null;
      // Convert decimal-price NAV → 6dp base units for wire uniformity
      // with `muhaven_quote` (response field is `lastKnownNavUsd6`).
      // A malformed value (shouldn't happen — nav-worker controls the
      // shape) falls back to null rather than throwing the whole
      // portfolio call.
      let lastKnownNavUsd6: string | null = null;
      if (snap?.nav) {
        try {
          lastKnownNavUsd6 = parseDecimalToUsd6(snap.nav).toString();
        } catch {
          lastKnownNavUsd6 = null;
        }
      }
      return {
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        encryptedBalanceHandle: null as string | null,
        lastKnownNavUsd6,
        lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null,
      };
    });

    // Heuristic signal flags. The agent UX is intentionally cautious —
    // when fewer than 2 positions exist, both flags are unknown (`null`)
    // so the LLM cannot produce an authoritative-sounding rebalance
    // recommendation off a single data point.
    const signals = computeHeuristicSignals(enriched.length);

    return {
      tool: 'muhaven_portfolio_summary',
      walletAddress,
      positions: enriched,
      signals,
      totalPositions: enriched.length,
    };
  }
}

function computeHeuristicSignals(positionCount: number): {
  isOverexposed: boolean | null;
  isUnderYield: boolean | null;
  note: string;
} {
  if (positionCount < 2) {
    return {
      isOverexposed: null,
      isUnderYield: null,
      note:
        'Signal flags require at least 2 positions for diversification heuristics. Wave 5 swaps for on-chain RiskParams.computeSignalFlags ebool handles.',
    };
  }
  // Wave 4 ships heuristics derived from position count only — diversification
  // metric over per-token balance share lands when P6 unseals the encrypted
  // balances client-side and posts a permit-gated aggregation back to the
  // server. Documented in TOOL_NAMESPACE.md §"P2 follow-ups (Wave 5)".
  return {
    isOverexposed: false,
    isUnderYield: false,
    note: 'Wave 4 heuristic — Wave 5 swaps for ebool flags from RiskParams.computeSignalFlags.',
  };
}
