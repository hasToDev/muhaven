/**
 * Wave 4 P5 (Wave-5 buyer-side port, P3) — real wrap + approve + buy
 * ceremony for the hosted-checkout buyer page.
 *
 * Replaces `main.ts:onConfirmBuy`'s `0xdemo…` synthetic tx hash with
 * the six on-chain UserOps that mirror the dashboard's investor
 * onboarding flow (CashPage + TradePage combined):
 *
 *   Step 1: USDC.approve(LegacyPusdc, amount) — once per amount.
 *           Allowance < amount → approve; else skip.
 *   Step 2: LegacyPusdc.wrap(kernel, amount) — convert cleartext USDC
 *           into legacy PUSDC under the kernel. Cleartext leg —
 *           cleartext amount, cleartext recipient.
 *   Step 3: LegacyPusdc.setOperator(MuHavenStable, until) — grant the
 *           mhUSDC wrapper operator rights on the kernel's PUSDC.
 *           One-time per kernel (subsequent buys skip via isOperator
 *           pre-check).
 *   Step 4: MuHavenStable.wrap(InEuint64, ephemeralEOA) — convert
 *           cleartext PUSDC into confidential mhUSDC. Encrypted amount
 *           — cofhe-encrypted via the SDK. ephemeralEOA gets the
 *           FHE.allow ACL on the new mhUSDC balance handle.
 *   Step 5: MuHavenStable.setOperator(Subscription, until) — grant the
 *           Subscription contract operator rights on the kernel's
 *           mhUSDC. One-time per kernel.
 *   Step 6: Subscription.purchase(token, InEuint128(shares),
 *           maxSharesHint, ephemeralEOA) — atomic mint of fhERC-20
 *           RWA shares. Encrypted share count; cleartext maxSharesHint
 *           per ADR-004.
 *
 * Returns the Step 6 tx hash — that's the `purchaseTxHash` the buyer
 * page sends to `backend.transition({newStatus: 'purchased', purchaseTxHash})`.
 *
 * Idempotent re-entry: each step is gated on a pre-check, so a
 * re-execution after a partial failure (e.g., USDC approve succeeded
 * but wrap failed) picks up from the last completed step. The
 * cofhe-encrypted amounts are re-derived from `payload.amountUsd6`
 * deterministically.
 *
 * **Important: `shares` derivation.** The Wave 3.5 contract convention
 * (per `MuHavenSubscription.sol` + ADR-031) is that `shares` is a raw
 * integer share count, and `FHE.mul(shares, nav)` produces PUSDC base
 * units (6-decimal). For the buyer page's simple "buy $X of token" UX,
 * we assume **NAV = 1 USDC/share** (the canonical demo scaling).
 * Production-trajectory enhancement: read NAV from the Oracle contract
 * + scale accordingly. For now: `shares = amountUsd6 / 1_000_000` (so
 * $100 USDC = 100 shares). `maxSharesHint = shares` (no headroom —
 * the cleartext amount drives the cap directly).
 *
 * Progress reporting: every step fires `onProgress` with a stage
 * label, so `main.ts` can rotate the visible CTA progress indicator
 * + announce state transitions to the sr-only regions.
 */

import {
  erc20Abi,
  type Address,
  type Hash,
} from 'viem';
import type { KernelAccountClient } from '@zerodev/sdk';
import {
  muHavenStableAbi,
  SubscriptionClient,
  StableClient,
} from '@muhaven/sdk';

/**
 * Minimal legacy ConfidentialUSDC (PUSDC) ABI — just the three
 * functions the buyer-page wrap chain needs. Inlined here because
 * `@muhaven/sdk` doesn't export `pusdcAbi` (the SDK was designed for
 * the post-Wave-3.5 mhUSDC hot path; legacy PUSDC stays in the
 * dashboard's `contracts/abis.ts` since it's deprecated for everything
 * except this wrap chain). Mirrors the relevant entries from
 * `frontend/src/contracts/abis.ts:818`.
 */
const pusdcAbi = [
  {
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'setOperator',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'until', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    name: 'isOperator',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'holder', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
import {
  getLegacyPusdcAddress,
  getMuHavenStableAddress,
  getPublicClient,
  getSubscriptionAddress,
  getUsdcAddress,
} from './chain.js';
import { buildBuyerContext } from './context.js';
import { getEphemeralEOA } from './cofhe.js';
import { createBuyerSender } from './sender.js';

/**
 * Operator grants are bound to a uint48 unix timestamp. We grant for
 * 30 days — long enough that a buyer who returns within a month skips
 * re-granting, short enough to limit the blast radius if the grant
 * ever needs to expire. Same value the dashboard uses for
 * `OPERATOR_EXPIRY_SECONDS`.
 */
const OPERATOR_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

export type PurchaseStage =
  | 'approve_usdc'
  | 'wrap_pusdc'
  | 'grant_pusdc_operator'
  | 'wrap_mhusdc'
  | 'grant_mhusdc_operator'
  | 'purchase'
  | 'done';

export interface PurchaseProgress {
  stage: PurchaseStage;
  /** 1-indexed step number for UI rotation (1..6). */
  step: number;
  /** Total steps (always 6 even when some are skipped — the UI rotates
   *  through all stages so the buyer sees the full ceremony progress). */
  total: number;
  /** Human-facing message for visible UI text. */
  message: string;
  /** Whether this step was skipped (pre-check satisfied). */
  skipped?: boolean;
  /** Tx hash, when a UserOp landed. */
  txHash?: Hash;
}

export type PurchaseCallbacks = {
  onProgress?: (p: PurchaseProgress) => void;
  /**
   * Fired ONCE after step 4 (`MuHavenStable.wrap`) lands on chain.
   * The caller is expected to fire `backend.transition({newStatus:
   * 'wrapped'})` so the backend state machine advances `funded →
   * wrapped → purchased` (the FORWARD_TRANSITIONS table forbids the
   * `funded → purchased` shortcut). If this callback throws, the
   * 6-UserOp ceremony aborts — wrap the call site in a try/catch
   * that swallows non-409 errors (a 409 means the SSE channel beat
   * us, which is benign).
   */
  onWrappedComplete?: (wrapTxHash: Hash) => Promise<void> | void;
};

export interface ExecutePurchaseOpts {
  kernelClient: KernelAccountClient;
  /** The buyer's kernel address (msg.sender for every UserOp). */
  buyerAddress: Address;
  /** Cleartext USDC amount in 6-decimal base units (matches
   *  `state.payload.amountUsd6` from the decrypted checkout payload). */
  amountUsd6: bigint;
  /** RWA token address (from `state.session.metadata.tokenAddress`). */
  tokenAddress: Address;
  /** Callbacks for UI wiring. */
  callbacks?: PurchaseCallbacks;
}

/**
 * Run the 6-UserOp wrap+approve+buy ceremony. Returns the final
 * `Subscription.purchase` tx hash on success. Throws on any step
 * failure; the caller surfaces the error to the UI.
 */
export async function executePurchase(
  opts: ExecutePurchaseOpts,
): Promise<Hash> {
  const { kernelClient, buyerAddress, amountUsd6, tokenAddress, callbacks } =
    opts;
  if (amountUsd6 <= 0n) {
    throw new Error('amountUsd6 must be > 0');
  }
  if (amountUsd6 > (1n << 64n) - 1n) {
    throw new Error('amountUsd6 exceeds 2^64 - 1');
  }

  const publicClient = getPublicClient();
  const usdc = getUsdcAddress();
  const legacyPusdc = getLegacyPusdcAddress();
  const muHavenStable = getMuHavenStableAddress();
  const subscription = getSubscriptionAddress();
  const ephemeralEOA = getEphemeralEOA();
  const sender = createBuyerSender(kernelClient, buyerAddress);

  const report = (
    stage: PurchaseStage,
    step: number,
    message: string,
    extras?: Partial<PurchaseProgress>,
  ): void => {
    callbacks?.onProgress?.({
      stage,
      step,
      total: 6,
      message,
      ...extras,
    });
  };

  // ── Step 1: USDC.approve(LegacyPusdc, amount) ────────────────────
  report('approve_usdc', 1, 'Authorising USDC for the wrapper…');
  const usdcAllowance = (await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [buyerAddress, legacyPusdc],
  })) as bigint;
  if (usdcAllowance < amountUsd6) {
    const approveHash = await sender.write({
      address: usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [legacyPusdc, amountUsd6],
    });
    report('approve_usdc', 1, 'USDC approved', { txHash: approveHash });
  } else {
    report('approve_usdc', 1, 'USDC already approved', { skipped: true });
  }

  // ── Step 2: LegacyPusdc.wrap(kernel, amount) ─────────────────────
  // Cleartext USDC → cleartext PUSDC under the kernel.
  //
  // Idempotency check (post-review fix): if the kernel ALREADY holds
  // ≥ amountUsd6 of legacy PUSDC (cleartext ERC-20 balanceOf), skip
  // the wrap. This handles the partial-failure retry case where step
  // 3/4/5/6 failed AFTER step 2 succeeded: re-running executePurchase
  // would otherwise re-approve USDC (allowance is now 0 because legacy
  // PUSDC consumed it on the first wrap) + call wrap again, which
  // reverts at the underlying USDC.safeTransferFrom (kernel's USDC
  // balance is now 0). Reading the cleartext balance is the canonical
  // skip signal — legacy PUSDC has a CLEARTEXT `balanceOf(address)`
  // shadow alongside its confidential balance (per
  // LegacyPusdcService:38).
  report('wrap_pusdc', 2, 'Wrapping USDC into mhUSDC…');
  const pusdcCleartextBalance = (await publicClient.readContract({
    address: legacyPusdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [buyerAddress],
  })) as bigint;
  if (pusdcCleartextBalance < amountUsd6) {
    const wrapPusdcHash = await sender.write({
      address: legacyPusdc,
      abi: pusdcAbi,
      functionName: 'wrap',
      args: [buyerAddress, amountUsd6],
    });
    report('wrap_pusdc', 2, 'USDC wrapped into mhUSDC', { txHash: wrapPusdcHash });
  } else {
    report('wrap_pusdc', 2, 'mhUSDC balance already sufficient', { skipped: true });
  }

  // ── Step 3: LegacyPusdc.setOperator(MuHavenStable, until) ────────
  // Once per kernel — pre-check via `isOperator` so subsequent buys
  // skip the round-trip.
  report('grant_pusdc_operator', 3, 'Authorising mhUSDC wrapper…');
  const pusdcOperatorAlreadySet = (await publicClient.readContract({
    address: legacyPusdc,
    abi: pusdcAbi,
    functionName: 'isOperator',
    args: [buyerAddress, muHavenStable],
  })) as boolean;
  if (!pusdcOperatorAlreadySet) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS);
    const grantHash = await sender.write({
      address: legacyPusdc,
      abi: pusdcAbi,
      functionName: 'setOperator',
      args: [muHavenStable, expiry],
    });
    report('grant_pusdc_operator', 3, 'mhUSDC wrapper authorised', {
      txHash: grantHash,
    });
  } else {
    report('grant_pusdc_operator', 3, 'mhUSDC wrapper already authorised', {
      skipped: true,
    });
  }

  // ── Step 4: MuHavenStable.wrap(InEuint64, ephemeralEOA) ──────────
  // Cleartext PUSDC → confidential mhUSDC. Encrypted via the SDK's
  // StableClient — the cofhe encryption + `FHE.allow(handle, eph)`
  // happen inside StableClient.wrap.
  report('wrap_mhusdc', 4, 'Sealing into confidential mhUSDC…');
  const ctx = await buildBuyerContext(kernelClient, buyerAddress);
  const stableClient = new StableClient(ctx, muHavenStable);
  const wrapMhusdcHash = await stableClient.wrap(amountUsd6, ephemeralEOA);
  report('wrap_mhusdc', 4, 'mhUSDC ready', { txHash: wrapMhusdcHash });

  // Backend state machine requires `funded → wrapped → purchased` —
  // fire the wrapped transition here BEFORE step 5/6 so the next
  // `transition({purchased})` is a valid forward step. The caller
  // owns the actual HTTP call via `onWrappedComplete`; we just hand
  // them the tx hash so they can log / audit if they choose. A
  // throw from the callback aborts the ceremony (caller can swallow
  // 409-on-race themselves).
  if (callbacks?.onWrappedComplete) {
    await callbacks.onWrappedComplete(wrapMhusdcHash);
  }

  // ── Step 5: MuHavenStable.setOperator(Subscription, until) ───────
  // Subscription.purchase pulls mhUSDC via the operator path. Once
  // per kernel — pre-check via `isOperator`.
  report('grant_mhusdc_operator', 5, 'Authorising Subscription contract…');
  const mhusdcOperatorAlreadySet = (await publicClient.readContract({
    address: muHavenStable,
    abi: muHavenStableAbi,
    functionName: 'isOperator',
    args: [buyerAddress, subscription],
  })) as boolean;
  if (!mhusdcOperatorAlreadySet) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_SECONDS);
    const grantHash = await sender.write({
      address: muHavenStable,
      abi: muHavenStableAbi,
      functionName: 'setOperator',
      args: [subscription, expiry],
    });
    report('grant_mhusdc_operator', 5, 'Subscription contract authorised', {
      txHash: grantHash,
    });
  } else {
    report(
      'grant_mhusdc_operator',
      5,
      'Subscription contract already authorised',
      { skipped: true },
    );
  }

  // ── Step 6: Subscription.purchase(token, InEuint128, max, eph) ───
  // Atomic mint of fhERC-20 RWA shares. Encrypted share count;
  // cleartext maxSharesHint per ADR-004.
  //
  // Demo-NAV assumption: 1 USDC = 1 share (mhUSDC base units → share
  // count divides by 1_000_000). Production-trajectory: read NAV from
  // the Oracle contract + scale. This produces an integer share count
  // for clean demo numbers ($100 USDC → 100 shares).
  const shares = sharesFromAmountUsd6(amountUsd6);
  if (shares <= 0n) {
    throw new Error(
      `Computed share count is 0 for amountUsd6=${amountUsd6} (sub-$1 not supported in the demo-NAV scaling).`,
    );
  }
  const maxSharesHint = shares;
  report('purchase', 6, 'Buying RWA shares…');
  const subClient = new SubscriptionClient(ctx, subscription);
  const purchaseHash = await subClient.purchase(
    tokenAddress,
    shares,
    maxSharesHint,
    ephemeralEOA,
  );
  report('done', 6, 'Purchase complete', { txHash: purchaseHash });
  return purchaseHash;
}

/**
 * Demo-NAV scaling: `shares = floor(amountUsd6 / 1_000_000)`. Each
 * USDC base unit (1e-6 USDC) is too small to be a share; we round
 * down so the buyer never pays for more shares than their amount
 * covers. Production: replace with NAV-aware scaling against the
 * Oracle contract.
 */
export function sharesFromAmountUsd6(amountUsd6: bigint): bigint {
  return amountUsd6 / 1_000_000n;
}

/** Test seam — exposed so vitest can verify the scaling without
 *  needing the full publicClient/kernel stack. */
export const __internals = {
  OPERATOR_EXPIRY_SECONDS,
  sharesFromAmountUsd6,
};
