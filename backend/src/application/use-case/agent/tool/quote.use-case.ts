import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../domain/nav-history/repository/nav-history.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { QuoteDto, QuoteResponseDto } from '../../../dto/agent/tool.dto.js';

/**
 * Wave 4 P2 — `muhaven_quote` (read-side tool).
 *
 * Returns NAV-derived purchase quote: cleartext notional → estimated
 * shares + maxSharesHint pinned to estimatedShares (ADR-004 over-hint
 * silent-fails). NAV is sourced from the latest indexed NAV snapshot;
 * Wave 5 may add a freshness gate that 503s on stale (>24h) NAV.
 *
 * The agent surface explicitly does NOT call Subscription.purchase from
 * the quote tool — that's the propose_buy action. Quote is read-only,
 * idempotent, and never mutates state.
 */
export class QuoteToolUseCase {
  constructor(
    private readonly rwaTokenRepo: IRwaTokenRepository,
    private readonly navHistoryRepo: INavHistoryRepository,
  ) {}

  async execute(input: QuoteDto): Promise<QuoteResponseDto> {
    const tokenAddress = input.tokenAddress.toLowerCase();
    const token = await this.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not registered: ${input.tokenAddress}`);
    }
    if (token.status !== 'active') {
      throw ApplicationHttpError.conflict(
        `Token ${token.symbol} is not active (status=${token.status}); quoting is disabled.`,
      );
    }

    const snap = await this.navHistoryRepo.findLatestByToken(tokenAddress);
    if (!snap) {
      throw ApplicationHttpError.notFound(
        `No NAV snapshot indexed for ${token.symbol}; quote unavailable.`,
      );
    }

    const navUsd6 = BigInt(snap.nav);
    if (navUsd6 <= 0n) {
      throw ApplicationHttpError.conflict(
        `NAV for ${token.symbol} is non-positive (${snap.nav}); quote unavailable.`,
      );
    }
    const notionalUsd6 = BigInt(input.notionalUsd6);
    // estimatedShares = floor(notional / nav). Both sides 6dp so the
    // ratio is dimensionless count of whole shares (decimals=0 fhERC-20).
    const estimatedShares = notionalUsd6 / navUsd6;
    if (estimatedShares <= 0n) {
      throw ApplicationHttpError.badRequest(
        `Notional ${input.notionalUsd6} (1e-6 USDC) yields zero shares at NAV ${snap.nav}.`,
      );
    }

    const navAt = (snap.sourceTimestamp ?? snap.fetchedAt).toISOString();

    return {
      tool: 'muhaven_quote',
      tokenAddress,
      tokenSymbol: token.symbol,
      notionalUsd6: input.notionalUsd6,
      navUsd6: snap.nav,
      navAt,
      estimatedShares: estimatedShares.toString(),
      maxSharesHint: estimatedShares.toString(),
    };
  }
}
