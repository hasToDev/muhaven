import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import type { INavHistoryRepository } from '../../../../domain/nav-history/repository/nav-history.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type { QuoteDto, QuoteResponseDto } from '../../../dto/agent/tool.dto.js';

/**
 * Parse a decimal-price string ("1.000000", "2400.5", "1") into 6-dp
 * base units (`1.0` → `1000000n`, `2400.5` → `2400500000n`). The
 * `nav_history.nav` column is a Postgres NUMERIC populated by
 * nav-worker as a human-readable price (FRED par = `1.0`, stooq XAUUSD
 * = `2400.5` etc.); the agent / SDK / on-chain-oracle layer all work
 * in 6-dp base units (1 USDC = `1000000`). Float arithmetic isn't
 * safe here (subtle rounding on values like `0.123457`), so we
 * string-parse + zero-pad the fractional part.
 *
 * Rejects: empty / non-numeric / negative / scientific notation. Truncates
 * fractional precision past 6 decimals (no rounding — matches the
 * fhERC-20 `decimals=0` floor convention used by `Subscription.purchase`).
 */
export function parseDecimalToUsd6(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!m) {
    throw new Error(`Invalid decimal price: ${JSON.stringify(decimal)}`);
  }
  const intPart = m[1];
  const fracPart = m[2] ?? '';
  // Pad with trailing zeros to 6dp; truncate (NOT round) anything past
  // 6dp so we never over-report buying power.
  const fracPadded = (fracPart + '000000').slice(0, 6);
  return BigInt(intPart + fracPadded);
}

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

    // `snap.nav` is a Postgres NUMERIC string written by nav-worker as
    // a decimal price ("1.000000" for treasury par, "2400.5" for gold).
    // Convert to 6dp base units before any BigInt arithmetic — `BigInt`
    // doesn't accept fractional decimal strings (surfaced 2026-05-09 by
    // AGENTIC_TEST_PLAN §1c step 4 against TBILL1's NAV of "1.000000").
    let navUsd6: bigint;
    try {
      navUsd6 = parseDecimalToUsd6(snap.nav);
    } catch (err) {
      throw ApplicationHttpError.conflict(
        `NAV for ${token.symbol} is malformed (${snap.nav}); quote unavailable. ${err instanceof Error ? err.message : ''}`,
      );
    }
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
      // Emit the base-unit integer string — matches the rest of the
      // agent surface (1 mhUSDC = 1000000) and lets the stub
      // synthesiser format `(navUsd6 / 1_000_000).toFixed(4)` correctly.
      navUsd6: navUsd6.toString(),
      navAt,
      estimatedShares: estimatedShares.toString(),
      maxSharesHint: estimatedShares.toString(),
    };
  }
}
