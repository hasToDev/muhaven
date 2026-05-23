/**
 * Wave 5 Option D · Commit 1 (D-1) — Scoped-tier on-chain CallPolicy
 * allowlist, extracted from `zerodev.provider.ts` so:
 *
 *  - Tests can import the shape without pulling the full kernel SDK +
 *    passkey-validator load chain.
 *  - The Scoped tier validator (broad on-chain envelope, ex-transfer)
 *    and the legacy session-key validator (broader: ex-Scoped + transfer
 *    + Wave-3 legacy) both build from a shared source-of-truth — so a
 *    future Slice 4/5 contributor adding e.g. a new MuHavenStable
 *    selector can't accidentally drop Scoped sessions out of sync with
 *    legacy session-key sessions.
 *
 * The CRITICAL invariant codified here (load-bearing, do NOT relax
 * without the operator + a SecEng review):
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  `muHavenToken.transfer` MUST NOT appear in                       │
 *   │  `SCOPED_AUTONOMOUS_PERMISSIONS`.                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * **Threat (SecEng T-2 — R2 Option D plan review)**: a leaked Scoped
 * session-key + compromised broker can sign UserOps without further
 * passkey ceremony. The broker's `selectorCaps` (off-chain narrow
 * defense) caps `subscription.purchase`'s `maxSharesHint` arg — but a
 * compromised broker bypasses `selectorCaps` entirely; on-chain
 * `CallPolicy` is then the ONLY narrowing layer.
 *
 * `muHavenToken.transfer(address to, InEuint128 encAmount, address ephemeralEOA)`
 * has NO uint-denominated cap arg the on-chain CallPolicy can bound —
 * the encrypted `encAmount` is opaque and the destination is attacker-
 * supplied. Including `transfer` in the Scoped envelope would let an
 * attacker drain every RWA holding to an attacker-controlled address.
 *
 * **Therefore**: Scoped sessions ALWAYS bounce P2P transfers to the
 * passkey kernel. The legacy session-key tier (confirm-per-action /
 * policy-bound) DOES permit transfer because its trust posture is
 * weaker but the lifetime is much shorter (tab-scoped sessionStorage
 * vs. up to 8h Scoped TTL after D-3) AND it requires an in-browser
 * passkey ceremony to mint, so the threat surface is qualitatively
 * different.
 *
 * See `development/DEV_WAVE_5/NEXT_SESSION_PROMPT_OPTION_D.md` § D-1
 * for the full rationale + memory
 * `[[feedback-legacy-session-key-allowlist-as-scoped-source-of-truth]]`.
 */

import {
  toFunctionSelector,
  keccak256,
  toHex,
  type Address,
  type AbiFunction,
} from 'viem';
import {
  yieldDistributorAbi,
  muhavenEscrowAbi,
  pusdcAbi,
  muHavenTokenAbi,
} from '@/contracts/abis';
import { addresses as CONTRACTS, v35Addresses } from '@/contracts/addresses';
import {
  muhavenSubscriptionAbi,
  redemptionQueueAbi,
  yieldSnapshotAbi,
  muHavenStableAbi,
} from '@muhaven/sdk';
import { setSessionPermsVersion } from '../session-key';
import type { Call } from '../wallet-provider.interface';
import type { Hex } from 'viem';

// ────────────────────────────────────────────────────────────────────
// ABI primitives
// ────────────────────────────────────────────────────────────────────

/**
 * Dedicated single-entry ABI for
 * `MuHavenToken.transfer(address,InEuint128,address)` — the Wave 3.5
 * overload per ADR-021. The full `muHavenTokenAbi` carries both the
 * Wave 3 and Wave 3.5 transfer signatures, which would make
 * `toCallPolicy`'s selector inference ambiguous. Constraining the
 * scope to the new ephemeralEOA-bearing overload also means a stale
 * frontend that somehow falls back to the legacy 2-arg path would
 * correctly miss session scope and bounce to the passkey kernel.
 *
 * NOTE: this entry is **intentionally not** in
 * `SCOPED_AUTONOMOUS_PERMISSIONS`. See the file-level JSDoc.
 */
export const muHavenTokenTransferV35Abi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      {
        name: 'encryptedAmount',
        type: 'tuple',
        components: [
          { name: 'ctHash', type: 'uint256' },
          { name: 'securityZone', type: 'uint8' },
          { name: 'utype', type: 'uint8' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// ────────────────────────────────────────────────────────────────────
// Helpers (test-importable so the dedupe/zero-filter behavior can be
// asserted directly).
// ────────────────────────────────────────────────────────────────────

export function nonZero<T extends { target: string }>(perms: readonly T[]): T[] {
  return perms.filter((p) => p.target.toLowerCase() !== ZERO_ADDR);
}

/**
 * Collapse permissions that share the same `(target, selector)` to a
 * single entry. The deployed `CallPolicy` contracts (notably V0_0_4 at
 * `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`) reject duplicate
 * `(target, selector)` pairs at install time with `revert("duplicate
 * permissionHash")`. Duplicates are easy to introduce by accident in
 * our env: when the same `YieldSnapshot` proxy serves multiple RWA
 * tokens (e.g. staging maps both TBILL1 and GOLD1 to the same snapshot
 * address), the `Object.values(yieldSnapshots).map(...)` expansion
 * yields N identical entries.
 */
export function dedupePermissions<
  T extends { target: string; abi: readonly unknown[]; functionName: string },
>(perms: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const perm of perms) {
    const abiItem = (perm.abi as readonly { type?: string; name?: string }[]).find(
      (item) => item.type === 'function' && item.name === perm.functionName,
    );
    if (!abiItem) {
      throw new Error(`dedupePermissions: missing ABI for ${perm.functionName}`);
    }
    const selector = toFunctionSelector(abiItem as AbiFunction).toLowerCase();
    const key = `${perm.target.toLowerCase()}:${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(perm);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Permission groups (per-feature)
//
// Each group is independently `nonZero`-filtered so a Wave-3.5
// not-yet-onboarded env (some `v35Addresses.*` defaulting to
// `0x0000…0000`) drops the empty entries before they reach
// `toCallPolicy`. Including a zero target would let the policy match
// unrelated Wave 3 calls to `address(0)`.
// ────────────────────────────────────────────────────────────────────

/**
 * Wave 3.5 — atomic buy / sell.
 *
 * `subscription.purchase` is the Scoped tier's primary surface; Slice
 * 1 broker only signs purchase, but installing `redeem` in the
 * on-chain CallPolicy means Slice 5 broker code can ship without
 * forcing every Scoped session to be re-minted. Both selectors are
 * non-payable (`valueLimit: 0n`).
 */
const subscriptionPermissions = nonZero([
  {
    target: v35Addresses.subscription,
    functionName: 'purchase',
    abi: muhavenSubscriptionAbi,
    valueLimit: 0n,
  },
  {
    target: v35Addresses.subscription,
    functionName: 'redeem',
    abi: muhavenSubscriptionAbi,
    valueLimit: 0n,
  },
]);

/**
 * Wave 3.5 — queued sell per-RWA. `RedemptionQueue` is deployed
 * one-per-token. Includes `submit` (open a queued sell) and `claim`
 * (settle a previously-submitted entry).
 */
const queuePermissions = nonZero(
  Object.values(v35Addresses.queues).flatMap((queueAddr) => [
    { target: queueAddr, functionName: 'submit', abi: redemptionQueueAbi, valueLimit: 0n },
    { target: queueAddr, functionName: 'claim', abi: redemptionQueueAbi, valueLimit: 0n },
  ]),
);

/**
 * Wave 3.5 — yield-snapshot surface. Includes investor-side `claimYield`
 * + the issuer-side distribution methods (openEpoch / snapshotBatch /
 * finalizeSnapshot / fundEpoch) so issuer-mode autonomous tooling can
 * land via the same Scoped envelope. ACL re-stamps
 * (`refreshAuditGrant`, `refreshSnapshotSupplyGrant`) are also in
 * scope — strictly weaker than the distribution surface.
 */
const snapshotPermissions = nonZero(
  Object.values(v35Addresses.yieldSnapshots).flatMap((snapAddr) => [
    { target: snapAddr, functionName: 'claimYield', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'openEpoch', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'snapshotBatch', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'finalizeSnapshot', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'fundEpoch', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'refreshAuditGrant', abi: yieldSnapshotAbi, valueLimit: 0n },
    { target: snapAddr, functionName: 'refreshSnapshotSupplyGrant', abi: yieldSnapshotAbi, valueLimit: 0n },
  ]),
);

/**
 * Issuer-side mhUSDC operator approval — required so `YieldSnapshot`
 * can pull mhUSDC from the issuer during `fundEpoch`. One-shot per
 * `(issuer, snapshotProxy)` pair until expiry.
 */
const stableOperatorPermissions = nonZero([
  {
    target: v35Addresses.muHavenStable,
    functionName: 'setOperator',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
]);

/**
 * Self-service ACL refresh primitives (ADR-042 + Phase 7.5 mirror).
 * These don't move funds — they only re-grant FHE decrypt access on
 * the caller's own balance handle to a passed `ephemeralEOA`.
 * Strictly weaker than the purchase / redeem entries already in
 * scope.
 */
const perTokenRwaAddresses = Object.keys(v35Addresses.treasuries) as Address[];
const refreshGrantPermissions = nonZero([
  // Wave 3 single-token surface (back-compat with `MPrivacyProofPanel`).
  {
    target: CONTRACTS.muHavenToken,
    functionName: 'refreshDecryptGrant',
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  },
  ...perTokenRwaAddresses.map((addr) => ({
    target: addr,
    functionName: 'refreshDecryptGrant' as const,
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  })),
  ...perTokenRwaAddresses.map((addr) => ({
    target: addr,
    functionName: 'refreshAuditGrant' as const,
    abi: muHavenTokenAbi,
    valueLimit: 0n,
  })),
  {
    target: v35Addresses.muHavenStable,
    functionName: 'refreshDecryptGrant',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
  {
    target: v35Addresses.muHavenStable,
    functionName: 'refreshAuditGrant',
    abi: muHavenStableAbi,
    valueLimit: 0n,
  },
]);

// ────────────────────────────────────────────────────────────────────
// Public exports
// ────────────────────────────────────────────────────────────────────

/**
 * **The Scoped-tier on-chain CallPolicy envelope.**
 *
 * Broad enough that Slice 4+5 broker features (queued sell, claim,
 * issuer-side distribution, ACL refreshes) ship without re-minting
 * every Scoped session (the permissionId is bound at mint time —
 * narrowing today + broadening tomorrow forces a per-user re-mint
 * cost; see memory
 * `[[feedback-legacy-session-key-allowlist-as-scoped-source-of-truth]]`).
 *
 * **NARROWED RELATIVE TO `SESSION_PERMISSIONS`:**
 *  - `muHavenToken.transfer` is EXCLUDED (SecEng T-2 — see file-level
 *    JSDoc for the drain-risk rationale).
 *  - Wave 3 legacy `(yieldDistributor / muhavenEscrow / pusdc)` are
 *    EXCLUDED (deprecated surface; not needed for the broker's
 *    autonomous-buy / autonomous-yield path).
 *
 * The broker's per-selector `maxAmount` cap (in `agent_scoped_sessions
 * .selector_caps`) is the narrow off-chain defense. This array is the
 * broad on-chain envelope — both layers are load-bearing.
 */
export const SCOPED_AUTONOMOUS_PERMISSIONS = dedupePermissions([
  ...subscriptionPermissions,
  ...queuePermissions,
  ...snapshotPermissions,
  ...stableOperatorPermissions,
  ...refreshGrantPermissions,
]);

/**
 * The legacy in-tab session-key allowlist.
 *
 * = `SCOPED_AUTONOMOUS_PERMISSIONS`
 *   + `muHavenToken.transfer` (P2P payments via confirm-per-action)
 *   + Wave 3 legacy (yieldDistributor / muhavenEscrow / pusdc).
 *
 * Same dedupe pass collapses any (target, selector) collision so the
 * CallPolicy install doesn't revert with `duplicate permissionHash`.
 */
export const SESSION_PERMISSIONS = dedupePermissions([
  ...SCOPED_AUTONOMOUS_PERMISSIONS,
  // P2P transfer — Wave 3.5 ephemeralEOA-bearing overload. NOT in
  // Scoped: see file-level JSDoc + memory
  // `[[feedback-legacy-session-key-allowlist-as-scoped-source-of-truth]]`.
  {
    target: CONTRACTS.muHavenToken,
    functionName: 'transfer',
    abi: muHavenTokenTransferV35Abi,
    valueLimit: 0n,
  },
  // Wave 3 legacy — deprecated path; safe to leave for back-compat
  // with already-minted legacy sessions.
  { target: CONTRACTS.yieldDistributor, functionName: 'startDistribution', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'setEscrowIds', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.yieldDistributor, functionName: 'processBatch', abi: yieldDistributorAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'batchCreate', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeem', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.muhavenEscrow, functionName: 'redeemMultiple', abi: muhavenEscrowAbi, valueLimit: 0n },
  { target: CONTRACTS.pusdc, functionName: 'setOperator', abi: pusdcAbi, valueLimit: 0n },
]);

/**
 * Pre-computed `${target}:${selector}` pairs for every entry in
 * `SESSION_PERMISSIONS`. Used by `sendUserOperation` to gate the
 * session-kernel path — calls outside this set skip the session
 * install/retry entirely and go straight to the passkey kernel.
 */
export const SESSION_SCOPE_KEYS: ReadonlySet<string> = new Set<string>(
  SESSION_PERMISSIONS.map((perm) => {
    const abiItem = (perm.abi as readonly { type?: string; name?: string }[]).find(
      (item) => item.type === 'function' && item.name === perm.functionName,
    );
    if (!abiItem) throw new Error(`SESSION_PERMISSIONS: missing ABI for ${perm.functionName}`);
    const selector = toFunctionSelector(abiItem as AbiFunction).toLowerCase();
    return `${perm.target.toLowerCase()}:${selector}`;
  }),
);

/**
 * Stable fingerprint of the currently-installed session policy.
 * Embedded in the sessionStorage key (see `session-key.ts::storageKey`)
 * so that any source-side change to `SESSION_PERMISSIONS` auto-
 * invalidates older cached records — forcing `installSessionKey` to
 * mint a fresh validator install whose on-chain CallPolicy matches
 * what the local code thinks is in scope. 8 hex chars = 32 bits of
 * stable fingerprint; collision probability across our < 100
 * permission combinations is negligible.
 */
export const SESSION_PERMS_FINGERPRINT = keccak256(
  toHex([...SESSION_SCOPE_KEYS].sort().join('|')),
).slice(2, 10);
setSessionPermsVersion(SESSION_PERMS_FINGERPRINT);

export function isCallInSessionScope(call: Call): boolean {
  const data = (call.data ?? '0x') as Hex;
  if (data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  const target = (call.to as string).toLowerCase();
  return SESSION_SCOPE_KEYS.has(`${target}:${selector}`);
}

// ────────────────────────────────────────────────────────────────────
// Module-load invariant — SecEng-MED-4 (multi-agent review 2026-05-23)
//
// The transfer-exclusion property is enforced at the aggregation
// layer only; a future contributor adding a sixth `*Permissions`
// group (e.g. governance, KYC) could accidentally include
// `(muHavenToken, transfer)` in that group and the bug would not be
// caught by the existing aggregation-level dedupe. This runtime
// assert fires at module-load — meaning every test run, every dev
// server start, every prod build's smoke step — so a regression
// surfaces immediately at the import boundary, NOT at runtime when
// a UserOp tries to call transfer.
//
// The full vitest snapshot test at
// `frontend/src/providers/zerodev/__tests__/scoped-permissions.test.ts`
// is the CI-level guard; this assert is the runtime backstop for
// any environment that doesn't run vitest (production builds,
// integration smoke).
// ────────────────────────────────────────────────────────────────────
{
  const TRANSFER_SELECTOR = toFunctionSelector(
    muHavenTokenTransferV35Abi[0] as AbiFunction,
  ).toLowerCase();
  const MUHAVEN_TOKEN_TARGET = CONTRACTS.muHavenToken.toLowerCase();
  for (const perm of SCOPED_AUTONOMOUS_PERMISSIONS) {
    if (
      perm.target.toLowerCase() === MUHAVEN_TOKEN_TARGET &&
      perm.functionName === 'transfer'
    ) {
      throw new Error(
        'SecEng T-2 invariant violated: muHavenToken.transfer was added to SCOPED_AUTONOMOUS_PERMISSIONS. ' +
          'Scoped tier MUST NOT permit transfer (drain risk under broker compromise). ' +
          'See scoped-permissions.ts file-level JSDoc for the rationale.',
      );
    }
    // Defense-in-depth: also reject any other `transfer` selector
    // anywhere in the Scoped set, regardless of target. Every
    // ERC-20-shaped transfer carries balance-moving semantics that
    // CallPolicy can't bound without a uint-denominated cap arg.
    if (perm.functionName === 'transfer') {
      throw new Error(
        `SecEng T-2 invariant violated: function 'transfer' on target ${perm.target} appeared in SCOPED_AUTONOMOUS_PERMISSIONS. Every transfer-shaped selector is forbidden in Scoped (no uint cap).`,
      );
    }
    // Secondary check by 4-byte selector — defends against a future
    // ABI tweak where the transfer overload's name changes but the
    // selector stays the same.
    const abiItem = (perm.abi as readonly { type?: string; name?: string }[]).find(
      (i) => i.type === 'function' && i.name === perm.functionName,
    );
    if (!abiItem) continue;
    const selector = toFunctionSelector(abiItem as AbiFunction).toLowerCase();
    if (
      selector === TRANSFER_SELECTOR &&
      perm.target.toLowerCase() === MUHAVEN_TOKEN_TARGET
    ) {
      throw new Error(
        `SecEng T-2 invariant violated: muHavenToken transfer selector ${TRANSFER_SELECTOR} reached SCOPED_AUTONOMOUS_PERMISSIONS via function ${perm.functionName}.`,
      );
    }
  }
}
