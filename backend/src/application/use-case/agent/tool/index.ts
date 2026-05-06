/**
 * Wave 4 P2 — HavenBot tool surface barrel.
 *
 * Eight tool use cases per ADR-0 + TOOL_NAMESPACE.md:
 *   muhaven_portfolio_summary, muhaven_quote (read; no policy gate)
 *   muhaven_propose_buy, muhaven_propose_claim, muhaven_propose_rebalance
 *   muhaven_set_policy, muhaven_pause (propose; tier-gated)
 *   muhaven_unseal_position (read; client-driven decrypt)
 * + commit-tool-action (closes propose → confirm → commit loop)
 */
export {
  PortfolioSummaryToolUseCase,
} from './portfolio-summary.use-case.js';
export { QuoteToolUseCase } from './quote.use-case.js';
export { ProposeBuyToolUseCase } from './propose-buy.use-case.js';
export type { ProposeBuyContext } from './propose-buy.use-case.js';
export { ProposeClaimToolUseCase } from './propose-claim.use-case.js';
export type { ProposeClaimContext } from './propose-claim.use-case.js';
export { ProposeRebalanceToolUseCase } from './propose-rebalance.use-case.js';
export type { ProposeRebalanceContext } from './propose-rebalance.use-case.js';
export { SetPolicyToolUseCase } from './set-policy-tool.use-case.js';
export type { SetPolicyContext } from './set-policy-tool.use-case.js';
export { PauseToolUseCase } from './pause-tool.use-case.js';
export type { PauseToolContext } from './pause-tool.use-case.js';
export { UnsealPositionToolUseCase } from './unseal-position.use-case.js';
export { CommitToolActionUseCase } from './commit-tool-action.use-case.js';
