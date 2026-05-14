/**
 * Wave 4 — HavenBot tool surface barrel.
 *
 * P2 (8 tools): muhaven_portfolio_summary, muhaven_quote (read);
 *   muhaven_propose_buy, muhaven_propose_claim, muhaven_propose_rebalance,
 *   muhaven_set_policy, muhaven_pause (propose; tier-gated);
 *   muhaven_unseal_position (read; client-driven decrypt).
 * P7 (5 issuer-side tools): muhaven_propose_distribute_yield,
 *   muhaven_propose_kyc_add, muhaven_propose_kyc_remove,
 *   muhaven_propose_unpause_token (propose; tier-gated, issuer-only),
 *   muhaven_audit_query (read; issuer-self).
 * P11 (4 governance / protection / KYC tools):
 *   muhaven_check_protection_coverage (read; on-chain proxy state),
 *   muhaven_explain_kyc_attestation (read; informational),
 *   muhaven_propose_governance_vote (propose; tier-gated),
 *   muhaven_cast_encrypted_vote (propose; tier-gated, FHE ceremony).
 * + commit-tool-action closes propose → confirm → commit loop.
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
// ── Wave 4 P7 — issuer-side tools ───────────────────────────────────
export { ProposeDistributeYieldToolUseCase } from './propose-distribute-yield.use-case.js';
export type { ProposeDistributeYieldContext } from './propose-distribute-yield.use-case.js';
export { ProposeKycAddToolUseCase } from './propose-kyc-add.use-case.js';
export type { ProposeKycAddContext } from './propose-kyc-add.use-case.js';
export { ProposeKycRemoveToolUseCase } from './propose-kyc-remove.use-case.js';
export type { ProposeKycRemoveContext } from './propose-kyc-remove.use-case.js';
export { ProposeUnpauseTokenToolUseCase } from './propose-unpause-token.use-case.js';
export type { ProposeUnpauseTokenContext } from './propose-unpause-token.use-case.js';
export { AuditQueryToolUseCase } from './audit-query.use-case.js';
export type { AuditQueryToolContext } from './audit-query.use-case.js';
export { ProposeCreateCheckoutToolUseCase } from './propose-create-checkout.use-case.js';
export type { ProposeCreateCheckoutContext } from './propose-create-checkout.use-case.js';
// ── Wave 4 P11 — governance / protection / KYC tools ────────────────
export { CheckProtectionCoverageToolUseCase } from './check-protection-coverage.use-case.js';
export type { CheckProtectionCoverageDeps } from './check-protection-coverage.use-case.js';
export { ExplainKycAttestationToolUseCase } from './explain-kyc-attestation.use-case.js';
export type { ExplainKycAttestationDeps } from './explain-kyc-attestation.use-case.js';
export {
  ProposeGovernanceVoteToolUseCase,
} from './propose-governance-vote.use-case.js';
export type { ProposeGovernanceVoteContext } from './propose-governance-vote.use-case.js';
export { CastEncryptedVoteToolUseCase } from './cast-encrypted-vote.use-case.js';
export type { CastEncryptedVoteContext } from './cast-encrypted-vote.use-case.js';
// ── Q4 Part B (2026-05-15) — Telegram-link HavenBot tool ────────────
export { LinkTelegramToolUseCase } from './link-telegram.use-case.js';
export type { LinkTelegramToolContext } from './link-telegram.use-case.js';
