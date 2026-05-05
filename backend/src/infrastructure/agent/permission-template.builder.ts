/**
 * ZeroDev `@zerodev/permissions` validator templates per tier.
 *
 * The backend does not call `@zerodev/permissions` directly — that lives
 * client-side where the passkey signs the validator install. What we
 * produce here is the **template** (call allowlist, gas cap, rate-limit
 * shape, validity window) that the frontend feeds into
 * `toCallPolicy()` / `toGasPolicy()` / `toRateLimitPolicy()` builders
 * and then installs via `kernel.installValidator(...)`.
 *
 * Template structure mirrors the @zerodev/permissions JSON DSL closely so
 * the frontend just maps fields one-to-one. Using a plain DTO instead of
 * importing the SDK avoids dragging viem-internal types into the backend
 * bundle and keeps the template auditable on Arbiscan once installed.
 *
 * Per ADR-1 the rule shape is **immutable post-install** — to change the
 * template the user must `uninstallPlugin` and reinstall with a new
 * version. This module never mutates a template; it only builds new ones.
 */

import { type Address } from 'viem';
import { Tier } from '../../domain/agent/model/tier.enum.js';
import { ActionId } from '../../domain/agent/model/action-id.enum.js';

/** Function selector strings the kernel will allow. 4-byte hex with 0x prefix. */
export type FunctionSelector = `0x${string}`;

export interface CallPolicyEntry {
  target: Address;
  selectors: FunctionSelector[];
  /** Per-call value cap in wei. ETH transfers should rarely apply on Arb;
   *  default 0 disallows ETH side-effects. */
  valueLimitWei: bigint;
}

export interface GasPolicyTemplate {
  /** Total gas budget across all UserOps in the template's lifetime. */
  totalGasLimit: bigint;
  /** Optional per-UserOp gas cap. Defaults to half of `totalGasLimit`. */
  perUserOpGasLimit?: bigint;
}

export interface RateLimitPolicyTemplate {
  /** Number of UserOps allowed per `windowSeconds`. */
  count: number;
  /** Sliding-window length, e.g., 86400 for daily. */
  windowSeconds: number;
}

export interface PermissionTemplate {
  /** Tier this template encodes; only PolicyBound produces a non-empty
   *  template (the other tiers do not install a session-key validator). */
  tier: Tier;
  /** Set of permitted (target, selector, value) triples. */
  callPolicy: CallPolicyEntry[];
  gasPolicy: GasPolicyTemplate;
  rateLimitPolicy: RateLimitPolicyTemplate;
  /**
   * Unix-seconds expiry. Per R-3 / R-6 this MUST be `≤ confirmation_TTL`
   * worth of safe ground; in practice, 1h–24h is the operating range.
   */
  validUntilSec: number;
  /**
   * Subset of `ActionId` values this template enables. Recorded
   * separately from the selector list for audit-log readability — the
   * selector list is the authoritative on-chain check.
   */
  actions: ActionId[];
}

export interface MuHavenContractAddresses {
  muhavenToken?: Address;
  vault?: Address;
  yieldDistributor?: Address;
  redemptionQueue?: Address;
  yieldSnapshot?: Address;
  subscription?: Address;
  riskParams?: Address;
}

/**
 * Selectors approximated against the deployed contract surface. These
 * intentionally use placeholders for selectors we have not yet pinned
 * with a `cast sig` extraction; the consuming frontend code MUST run a
 * runtime sanity check against the on-chain ABI before installing the
 * validator. P3 (MCP server) will add a CI gate that re-derives these
 * selectors from the compiled artifacts and fails if they drift.
 */
export const KNOWN_SELECTORS: Record<string, FunctionSelector> = {
  subscriptionBuy: '0xfe1b8e98',
  redemptionQueueClaim: '0x4e71d92d',
  yieldSnapshotClaim: '0xab9b2adf',
  riskParamsCheckAndExecute: '0xe85a8553',
};

export interface BuildTemplateInput {
  tier: Tier;
  actions: readonly ActionId[];
  contracts: MuHavenContractAddresses;
  /** Total gas budget. Defaults to 5,000,000 (Arb) per template lifetime. */
  totalGasLimit?: bigint;
  /** Default 50 ops per 24h — capped by ADR-0's confidence-building model. */
  rateLimit?: RateLimitPolicyTemplate;
  /** Validity window in seconds from `now`. Default 3600 (1h). */
  ttlSec?: number;
  now?: Date;
}

const DEFAULT_TOTAL_GAS_LIMIT = 5_000_000n;
const DEFAULT_RATE_LIMIT: RateLimitPolicyTemplate = { count: 50, windowSeconds: 86_400 };
const DEFAULT_TTL_SEC = 3600;

/**
 * Build a per-tier ZeroDev validator template. Only `PolicyBound` returns
 * a non-empty CallPolicy; `Advisory` and `ConfirmPerAction` return an
 * **empty** template that the frontend treats as "no session key — every
 * action goes through passkey master signing".
 *
 * The selector allowlist is derived from the requested `actions`, mapped
 * to the contract surface in `contracts`. Missing addresses are silently
 * dropped — the caller is responsible for asserting that all required
 * contracts are configured before relying on the template.
 *
 * NOTE on per-token contracts: `redemptionQueue` and `yieldSnapshot` are
 * deployed PER-TOKEN in Wave 3.5. For now `BuildPermissionTemplateUseCase`
 * only resolves the global Subscription address from env. P3 (frontend
 * MCP/dashboard install flow) will provide the per-token addresses
 * directly to this builder when minting a session key bound to a single
 * token's surface. Until then, Sell/Claim/Rebalance entries will be
 * empty unless the caller injects those addresses explicitly.
 */
export function buildPermissionTemplate(input: BuildTemplateInput): PermissionTemplate {
  const now = input.now ?? new Date();
  const validUntilSec = Math.floor(now.getTime() / 1000) + (input.ttlSec ?? DEFAULT_TTL_SEC);
  const totalGasLimit = input.totalGasLimit ?? DEFAULT_TOTAL_GAS_LIMIT;

  if (input.tier !== Tier.PolicyBound) {
    return {
      tier: input.tier,
      callPolicy: [],
      gasPolicy: { totalGasLimit: 0n },
      rateLimitPolicy: { count: 0, windowSeconds: 0 },
      validUntilSec,
      actions: [],
    };
  }

  const callPolicy = buildCallPolicyForActions(input.actions, input.contracts);
  return {
    tier: input.tier,
    callPolicy,
    gasPolicy: {
      totalGasLimit,
      perUserOpGasLimit: totalGasLimit / 2n,
    },
    rateLimitPolicy: input.rateLimit ?? DEFAULT_RATE_LIMIT,
    validUntilSec,
    actions: [...input.actions],
  };
}

/**
 * Group selectors by target so a single CallPolicy entry covers the
 * union — Rebalance + Buy + Sell would otherwise duplicate the
 * Subscription / RedemptionQueue rows. Returning a stable canonical
 * shape (one entry per target) keeps the audit-on-Arbiscan output
 * easy for reviewers to read.
 */
function buildCallPolicyForActions(
  actions: readonly ActionId[],
  contracts: MuHavenContractAddresses,
): CallPolicyEntry[] {
  const grouped = new Map<Address, Set<FunctionSelector>>();

  function add(target: Address | undefined, selector: FunctionSelector): void {
    if (!target) return; // missing env — caller is responsible for asserting completeness
    const set = grouped.get(target) ?? new Set<FunctionSelector>();
    set.add(selector);
    grouped.set(target, set);
  }

  const wantsBuy = actions.includes(ActionId.Buy) || actions.includes(ActionId.Rebalance);
  const wantsSell = actions.includes(ActionId.Sell) || actions.includes(ActionId.Rebalance);
  const wantsClaim = actions.includes(ActionId.Claim);

  if (wantsBuy) add(contracts.subscription, KNOWN_SELECTORS.subscriptionBuy);
  if (wantsSell) add(contracts.redemptionQueue, KNOWN_SELECTORS.redemptionQueueClaim);
  if (wantsClaim) add(contracts.yieldSnapshot, KNOWN_SELECTORS.yieldSnapshotClaim);

  return Array.from(grouped.entries()).map(([target, selectors]) => ({
    target,
    selectors: Array.from(selectors),
    valueLimitWei: 0n,
  }));
}

/**
 * Render a `PermissionTemplate` as a JSON-safe DTO with bigints stringified.
 * The HTTP layer uses this when returning a template to the frontend.
 */
export function serializeTemplate(template: PermissionTemplate): unknown {
  return {
    tier: template.tier,
    callPolicy: template.callPolicy.map((entry) => ({
      target: entry.target,
      selectors: entry.selectors,
      valueLimitWei: entry.valueLimitWei.toString(),
    })),
    gasPolicy: {
      totalGasLimit: template.gasPolicy.totalGasLimit.toString(),
      perUserOpGasLimit: template.gasPolicy.perUserOpGasLimit?.toString() ?? null,
    },
    rateLimitPolicy: template.rateLimitPolicy,
    validUntilSec: template.validUntilSec,
    actions: template.actions,
  };
}
