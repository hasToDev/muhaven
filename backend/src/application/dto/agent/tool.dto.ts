import { z } from 'zod';
import { TIER_VALUES, type Tier } from '../../../domain/agent/model/tier.enum.js';
import { SURFACE_VALUES, type Surface } from '../../../domain/agent/model/surface.enum.js';

/**
 * Wave 4 Phase P2 — HavenBot tool surface.
 *
 * Eight strict-enum tools per `TOOL_NAMESPACE.md` §"HavenBot tool registry".
 * Every input schema uses `.strict()` (the Zod equivalent of JSON Schema's
 * `additionalProperties: false`) so an LLM that hallucinates a novel field
 * is rejected at the boundary — the cheapest defense against tool-call
 * injection that mutates an unvalidated field.
 *
 * Naming convention: snake_case under `muhaven_*`. The MCP namespace
 * (P3) uses dotted `muhaven.<group>.<verb>` — a host-runtime constraint,
 * not a duplication. See TOOL_NAMESPACE.md §"Why two patterns instead of one".
 */

// ── Hex address — Wave 3.5 viem-style 0x[40-hex] regex ─────────────────
const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 40-hex EVM address');

// ── Cleartext USDC amount in 6-decimal units (1 USDC = 1_000_000) ─────
//
// String to preserve bigint precision across the wire — JSON numbers max
// out at 2^53 - 1 which fits today's volumes but a Subscription buy at
// $1B in 6dp = 1e15, well under that. Using string anyway for forward-
// compat with bigger amounts and for parser-uniformity with InEuint64.
const usd6Schema = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountUsd6 must be a positive integer string (1 = 1e-6 USDC)');

// ── Cleartext share count (raw fhERC-20 integer; decimals == 0) ───────
const sharesSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'shares must be a positive integer string');

// ── CoFHE encrypted-handle ctHash — 0x-prefixed 32-byte digest ────────
const ctHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'ctHash must be a 0x-prefixed 32-byte hex string');

const tierSchema = z.enum(TIER_VALUES as readonly [Tier, ...Tier[]]);
const surfaceSchema = z.enum(SURFACE_VALUES as readonly [Surface, ...Surface[]]);

// ─────────────────────────────────────────────────────────────────────
// Tool 1 — muhaven_portfolio_summary  (read; no policy gate)
// ─────────────────────────────────────────────────────────────────────

export const PortfolioSummaryDtoSchema = z
  .object({
    /** Optional — limit positions to a single token (default: all). */
    tokenAddress: addressSchema.optional(),
  })
  .strict();

export type PortfolioSummaryDto = z.infer<typeof PortfolioSummaryDtoSchema>;

export interface PortfolioSummaryResponseDto {
  tool: 'muhaven_portfolio_summary';
  walletAddress: string;
  positions: Array<{
    tokenAddress: string;
    tokenSymbol: string;
    /** P6 will return the encrypted handle; Wave 4 P2 returns null + a
     * short Wave 5 swap note so the wire shape is stable. */
    encryptedBalanceHandle: string | null;
    /** Public (cleartext) NAV at last sync — joined from `nav_history`. */
    lastKnownNavUsd6: string | null;
    lastSyncedAt: string | null;
  }>;
  /** Server-derived heuristics — Wave 5 swaps for P6
   * `RiskParams.computeSignalFlags` ebool handles. */
  signals: {
    isOverexposed: boolean | null;
    isUnderYield: boolean | null;
    note: string;
  };
  totalPositions: number;
}

// ─────────────────────────────────────────────────────────────────────
// Tool 2 — muhaven_quote(asset, amount)  (read; no policy gate)
// ─────────────────────────────────────────────────────────────────────

export const QuoteDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    /** Cleartext USDC notional (6-dp). Quote returns implied share count. */
    notionalUsd6: usd6Schema,
  })
  .strict();

export type QuoteDto = z.infer<typeof QuoteDtoSchema>;

export interface QuoteResponseDto {
  tool: 'muhaven_quote';
  tokenAddress: string;
  tokenSymbol: string;
  notionalUsd6: string;
  navUsd6: string;
  navAt: string;
  /** Floor(notionalUsd6 / navUsd6) — purchase-side share count. */
  estimatedShares: string;
  /** maxSharesHint pinned to estimatedShares (ADR-004 over-hint silent-fails). */
  maxSharesHint: string;
}

// ─────────────────────────────────────────────────────────────────────
// Tool 3 — muhaven_propose_buy  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

export const ProposeBuyDtoSchema = z
  .object({
    tokenAddress: addressSchema,
    shares: sharesSchema,
    /** maxSharesHint defaults to shares; override only if quoting drift
     *  matters (ADR-004 over-hint silent-fails to zero on chain). */
    maxSharesHint: sharesSchema.optional(),
  })
  .strict();

export type ProposeBuyDto = z.infer<typeof ProposeBuyDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 4 — muhaven_propose_claim  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

export const ProposeClaimDtoSchema = z
  .object({
    /** Backend yield-record id (UUID). The use-case resolves the on-chain
     *  escrow id from the linked Escrow row — same as GetYieldsUseCase. */
    yieldRecordId: z.string().uuid(),
  })
  .strict();

export type ProposeClaimDto = z.infer<typeof ProposeClaimDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 5 — muhaven_propose_rebalance  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

export const ProposeRebalanceLegSchema = z
  .object({
    kind: z.enum(['sell', 'buy']),
    tokenAddress: addressSchema,
    shares: sharesSchema,
    maxSharesHint: sharesSchema.optional(),
  })
  .strict();

export const ProposeRebalanceDtoSchema = z
  .object({
    /** ≤8 legs per intent — practical Arb Sepolia ceiling for atomic
     *  policy-engine validation. The frontend signs each leg sequentially. */
    legs: z.array(ProposeRebalanceLegSchema).min(1).max(8),
  })
  .strict();

export type ProposeRebalanceDto = z.infer<typeof ProposeRebalanceDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 6 — muhaven_set_policy  (propose; tier-gated)
// ─────────────────────────────────────────────────────────────────────

export const SetPolicyDtoSchema = z
  .object({
    surface: surfaceSchema.default('havenbot'),
    targetTier: tierSchema,
  })
  .strict();

export type SetPolicyDto = z.infer<typeof SetPolicyDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 7 — muhaven_pause  (propose; idempotent)
// ─────────────────────────────────────────────────────────────────────

export const PauseToolDtoSchema = z
  .object({
    /** Optional surface scope; omitted = explicit-pause (T-1) on every surface. */
    surface: surfaceSchema.optional(),
  })
  .strict();

export type PauseToolDto = z.infer<typeof PauseToolDtoSchema>;

// ─────────────────────────────────────────────────────────────────────
// Tool 8 — muhaven_unseal_position  (read; client-side decrypt)
// ─────────────────────────────────────────────────────────────────────
//
// Returns metadata describing how the client should decrypt — backend
// NEVER decrypts on behalf of the user. The actual `cofheClient
// .decryptForView(handle).withPermit().execute()` runs in the browser so
// the agent cannot exfiltrate cleartext via prompt injection (R-1).
export const UnsealPositionDtoSchema = z
  .object({
    handle: ctHashSchema,
    /** Hint to the client about which permit signer to use (passkey
     *  master vs. session key). Defaults to session-key on the dashboard. */
    signerHint: z.enum(['session', 'master']).default('session'),
  })
  .strict();

export type UnsealPositionDto = z.infer<typeof UnsealPositionDtoSchema>;

export interface UnsealPositionResponseDto {
  tool: 'muhaven_unseal_position';
  handle: string;
  signerHint: 'session' | 'master';
  /** Wire-shape note: client invokes
   *  `cofheClient.decryptForView(handle).withPermit().execute()`.
   *  Backend never sees plaintext. */
  decryptInstruction: string;
}

// ─────────────────────────────────────────────────────────────────────
// ActionDescriptor — every propose_* tool returns this shape
// ─────────────────────────────────────────────────────────────────────
//
// The frontend ConfirmModal receives an ActionDescriptor + uses MuHaven
// SDK + ZeroDev kernel to encrypt + sign + submit. Backend never touches
// the FHE encrypt step (CoFHE input signature requires the user's signer)
// nor the UserOp signing step (passkey / session key on device).
//
// confirmTokenId is the R-3 single-use replay token: client passes it on
// the audit-commit POST after the on-chain tx confirms, backend records
// PermitGranted audit row and consumes the token.

export type ActionDescriptorKind =
  | 'buy'
  | 'claim'
  | 'rebalance'
  | 'set_policy'
  | 'pause'
  | 'resume'
  | 'distribute_yield'
  | 'kyc_add'
  | 'kyc_remove'
  | 'unpause_token'
  // Wave 4 P11 — governance ceremony
  | 'governance_propose'
  | 'governance_vote';

export interface ActionDescriptorBase {
  kind: ActionDescriptorKind;
  toolCallId: string;
  confirmTokenId: string;
  expiresAtSec: number;
  /** Human-readable summary for the ConfirmModal preview pane. */
  summary: string;
  /** Cleartext preview values — never the encrypted handles, never the
   *  raw permit signature. The ConfirmModal renders these directly.
   *  Per-descriptor concrete shapes narrow this in the union members. */
  preview: Record<string, unknown>;
  /** Wire-shape note for the frontend SDK call. */
  sdkCall: {
    contractName: string;
    functionName: string;
    /** Cleartext args — frontend wraps the FHE-leg before submit. */
    args: Record<string, unknown>;
  };
}

export interface BuyActionDescriptor extends ActionDescriptorBase {
  kind: 'buy';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    shares: string;
    maxSharesHint: string;
    navUsd6: string;
    /** ISO timestamp pinned in the action-hash so the commit-side
     *  ConfirmTokenService.consume can reproduce the hash exactly.
     *  Required — omitting this would silently break every buy
     *  commit (action hashes would never match). */
    navAt: string;
    estimatedTotalUsd6: string;
    /** Wave 4 P4 — when the user has linked Telegram, propose-buy
     *  parallel-mints an OpenClawIntent and pings the bot worker. The
     *  intent's id is surfaced here so the dashboard's open ConfirmModal
     *  can correlate the SSE `intent_confirmed` event back to itself
     *  and auto-fire the on-chain leg without the operator re-clicking
     *  Authorize on the dashboard. Absent when the user has NOT linked
     *  Telegram or when the bot delivery failed (Telegram outage falls
     *  back silently — the dashboard still works without auto-fire).
     */
    openClawIntentId?: string;
  };
}

export interface ClaimActionDescriptor extends ActionDescriptorBase {
  kind: 'claim';
  preview: {
    yieldRecordId: string;
    onChainEscrowId: string | null;
    tokenAddress: string;
    distributionId: number;
  };
}

export interface RebalanceActionDescriptor extends ActionDescriptorBase {
  kind: 'rebalance';
  preview: {
    legCount: number;
    legs: Array<{
      kind: 'sell' | 'buy';
      tokenAddress: string;
      shares: string;
      maxSharesHint: string;
    }>;
    /** Privacy disclaimer — backend cannot read encrypted balances, so
     *  per-leg sells silent-fail-to-zero on insufficient holdings. The
     *  user verifies on-chain after signing. Wave 5 swap: client
     *  unseals position before propose + posts a permit-gated balance
     *  assertion. */
    privacyNote: string;
  };
}

export interface SetPolicyActionDescriptor extends ActionDescriptorBase {
  kind: 'set_policy';
  preview: {
    surface: Surface;
    targetTier: Tier;
    requestedAt: string;
  };
}

export interface PauseActionDescriptor extends ActionDescriptorBase {
  kind: 'pause';
  preview: {
    surface: Surface | null;
    cascade: boolean;
    note: string;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Wave 4 P7 — issuer-side ActionDescriptors
// ─────────────────────────────────────────────────────────────────────
//
// Distribution / KYC / unpause-token tools share the same shape as the
// investor-side propose tools — confirm-token-bearing ActionDescriptors
// that the frontend ConfirmModal renders + the issuer's kernel signs via
// the existing ZeroDev session-key path. See ADR-8 for the issuer-side
// namespace + naming locks.

// `requestedAtSec` (Unix seconds) is pinned into the action hash for every
// issuer-side propose so a stale-quote replay is rejected at consume time
// (R-3 mitigation, mirrors BuyActionDescriptor.preview.navAt). Required
// — omitting it would silently break every commit (action hashes would
// never match across propose / commit).

export interface DistributeYieldActionDescriptor extends ActionDescriptorBase {
  kind: 'distribute_yield';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    /** Cleartext mhUSDC amount (6-decimal base units) the issuer will
     *  deposit into the distribution. Encrypted SDK-side BEFORE the
     *  submit — backend never sees the encrypted handle. */
    totalYieldUsd6: string;
    /** Human-readable distribution label captured at propose time. */
    label: string;
    /** Issuer wallet that funds + signs the distribution. */
    issuerAddress: string;
    requestedAtSec: number;
  };
}

export interface KycAddActionDescriptor extends ActionDescriptorBase {
  kind: 'kyc_add';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    investorAddress: string;
    /** ERC-3643 KYC tier: 1 = retail, 2 = accredited. */
    kycTier: 1 | 2;
    kycAdapterAddress: string;
    requestedAtSec: number;
  };
}

export interface KycRemoveActionDescriptor extends ActionDescriptorBase {
  kind: 'kyc_remove';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    investorAddress: string;
    kycAdapterAddress: string;
    requestedAtSec: number;
  };
}

export interface UnpauseTokenActionDescriptor extends ActionDescriptorBase {
  kind: 'unpause_token';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    /** Initial NAV in mhUSDC base units (6 decimals). */
    initialNavUsd6: string;
    issuerOracleAddress: string;
    tokenRegistryAddress: string;
    requestedAtSec: number;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Wave 4 P11 — governance ActionDescriptors
// ─────────────────────────────────────────────────────────────────────
//
// Two-step governance ceremony — `propose` opens a proposal on the
// `EncryptedGovernance` contract; `cast_vote` submits an FHE-encrypted
// ballot. Backend never sees the ballot cleartext post-encrypt.
//
// `requestedAtSec` is pinned for the same R-3 reason as P7 — the
// commit POST round-trips it byte-for-byte through the action hash so
// stale-quote replay is rejected.
//
// `governanceAddress` is surfaced in the descriptor so the frontend
// runner sees exactly which proxy it must hit; the addresses are
// resolved server-side from `ENCRYPTED_GOVERNANCE_ADDRESS`. This makes
// post-deploy address rotations a single env-var swap (no frontend
// release needed) and gives the ConfirmModal a verified target.

export interface GovernanceProposeActionDescriptor extends ActionDescriptorBase {
  kind: 'governance_propose';
  preview: {
    tokenAddress: string;
    tokenSymbol: string;
    /** 0 = TRIGGER_PROTECTION (Wave 4 only); 1 reserved Wave 5. */
    proposalType: 0 | 1;
    proposalTypeLabel: string;
    governanceAddress: string;
    requestedAtSec: number;
  };
}

export interface GovernanceVoteActionDescriptor extends ActionDescriptorBase {
  kind: 'governance_vote';
  preview: {
    proposalId: string;
    /** Cleartext yes/no. SDK encrypts to InEuint128 client-side BEFORE
     *  the on-chain `castVote` write — backend never sees the
     *  encrypted handle. */
    voteYes: boolean;
    governanceAddress: string;
    requestedAtSec: number;
  };
}

export type ActionDescriptor =
  | BuyActionDescriptor
  | ClaimActionDescriptor
  | RebalanceActionDescriptor
  | SetPolicyActionDescriptor
  | PauseActionDescriptor
  | DistributeYieldActionDescriptor
  | KycAddActionDescriptor
  | KycRemoveActionDescriptor
  | UnpauseTokenActionDescriptor
  | GovernanceProposeActionDescriptor
  | GovernanceVoteActionDescriptor;

// ─────────────────────────────────────────────────────────────────────
// Audit-commit DTO — frontend POSTs this after the SDK tx confirms
// ─────────────────────────────────────────────────────────────────────

export const CommitToolActionDtoSchema = z
  .object({
    confirmToken: z.string().min(8).max(128),
    /** 32-byte tx hash from the bundler (or `null` for tools whose audit
     *  is purely off-chain — e.g., set_policy.request which the user
     *  finishes via /agent/policy/transition). */
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 0x-prefixed 32-byte hex tx hash')
      .nullable(),
    /** Optional metadata captured at submit time — block, gasUsed, etc. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CommitToolActionDto = z.infer<typeof CommitToolActionDtoSchema>;

export interface CommitToolActionResponseDto {
  consumed: true;
  auditEventId: string;
}
