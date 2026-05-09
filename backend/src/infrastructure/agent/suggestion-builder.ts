import type { SuggestionItem } from '../../application/dto/agent/chat-stream.dto.js';

/**
 * Wave 4 P2 follow-up — context-aware ActionCard chips.
 *
 * The chips below each agent reply USED to be a static
 * "Show portfolio breakdown / Optimize my yield allocation / Explain
 * the trade-offs" triple regardless of what the agent actually said.
 * That's misleading: a fresh wallet with no mhUSDC saw "Optimize my
 * yield allocation" instead of the obviously-correct "Wrap mhUSDC".
 *
 * This module maps the most-recent tool dispatch outcome onto a small
 * set of follow-up suggestions, all of which are short re-prompts the
 * user can click to keep the conversation moving in the right
 * direction. The frontend's `handleAction(label)` already forwards
 * the chip text back to the agent as a new user message, so the
 * suggestions are pure copy — no separate routing.
 *
 * Surfaced 2026-05-09 from AGENTIC_TEST_PLAN §1c step 5 walkthrough.
 */

export interface SuggestionContext {
  /** Last tool the agent loop dispatched on this turn (null if no tool fired). */
  lastTool?: string;
  /** Raw tool result. Only fields commonly checked are read. */
  lastResult?: unknown;
  /** Set when the tool dispatch threw — mapped from the structured error message. */
  lastError?: string;
  /** Token symbol mentioned in the last tool call args, when available. */
  tokenSymbol?: string | null;
}

/**
 * Default fallback chips when no other branch fires. Matches the
 * shape the frontend used to ship statically.
 */
export const FALLBACK_SUGGESTIONS: SuggestionItem[] = [
  { label: 'Show portfolio breakdown', variant: 'primary' },
  { label: 'Optimize my yield allocation', variant: 'secondary' },
  { label: 'Explain MuHaven', variant: 'ghost' },
];

/**
 * Map a tool dispatch outcome onto follow-up chips. Each branch
 * returns 2-3 items chosen to nudge the user toward the next sane
 * action. When no branch matches, the caller can decide between
 * `FALLBACK_SUGGESTIONS` and emitting nothing at all.
 */
export function buildSuggestions(ctx: SuggestionContext): SuggestionItem[] {
  // 1. Fresh-wallet INSUFFICIENT_MHUSDC error from propose_buy → wrap path.
  if (ctx.lastError && /INSUFFICIENT_MHUSDC|no mhUSDC history|wrap.*USDC/i.test(ctx.lastError)) {
    return [
      { label: 'Wrap USDC into mhUSDC', variant: 'primary' },
      { label: 'Show available RWA tokens', variant: 'secondary' },
      { label: 'Explain how MuHaven works', variant: 'ghost' },
    ];
  }

  // 2. Empty portfolio (totalPositions=0) → invite first deposit.
  if (
    ctx.lastTool === 'muhaven_portfolio_summary'
    && isEmptyPortfolio(ctx.lastResult)
  ) {
    return [
      { label: 'Wrap USDC into mhUSDC', variant: 'primary' },
      { label: 'Show available RWA tokens', variant: 'secondary' },
      { label: 'Explain how MuHaven works', variant: 'ghost' },
    ];
  }

  // 3. Successful quote → invite the buy + comparison.
  if (ctx.lastTool === 'muhaven_quote' && hasQuoteResult(ctx.lastResult)) {
    const symbol = extractTokenSymbol(ctx.lastResult) ?? ctx.tokenSymbol ?? 'this token';
    const shares = extractShares(ctx.lastResult);
    return [
      {
        label: shares
          ? `Buy ${shares} ${symbol}`
          : `Buy ${symbol}`,
        variant: 'primary',
      },
      { label: 'Quote a different amount', variant: 'secondary' },
      { label: 'Show my portfolio', variant: 'ghost' },
    ];
  }

  // 4. propose_buy successful → ConfirmModal handles the next step;
  //    chips offer related follow-ups but don't repeat the buy itself.
  if (ctx.lastTool === 'muhaven_propose_buy' && !ctx.lastError) {
    return [
      { label: 'Show my portfolio', variant: 'primary' },
      { label: 'Set my agent to Confirm-per-action', variant: 'secondary' },
      { label: 'Show TBILL1 yield history', variant: 'ghost' },
    ];
  }

  // 5. Stale-quote / no-NAV / archived-token error → recovery suggestions.
  if (
    ctx.lastError
    && /No NAV snapshot|not active|archived|paused/i.test(ctx.lastError)
  ) {
    return [
      { label: 'Show available RWA tokens', variant: 'primary' },
      { label: 'Show my portfolio', variant: 'secondary' },
      { label: 'Explain why this failed', variant: 'ghost' },
    ];
  }

  // 6. Pause executed → resume + audit chips.
  if (ctx.lastTool === 'muhaven_pause' && !ctx.lastError) {
    return [
      { label: 'Resume my agent', variant: 'primary' },
      { label: 'Show my audit log', variant: 'secondary' },
      { label: 'Explain the pause', variant: 'ghost' },
    ];
  }

  return FALLBACK_SUGGESTIONS;
}

function isEmptyPortfolio(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { totalPositions?: number };
  return typeof r.totalPositions === 'number' && r.totalPositions === 0;
}

function hasQuoteResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return 'estimatedShares' in result && 'tokenSymbol' in result;
}

function extractTokenSymbol(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { tokenSymbol?: unknown };
  return typeof r.tokenSymbol === 'string' ? r.tokenSymbol : null;
}

function extractShares(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { estimatedShares?: unknown };
  return typeof r.estimatedShares === 'string' ? r.estimatedShares : null;
}
