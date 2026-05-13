/**
 * Wave 4 P5 (Wave-5 buyer-side port, P3) — MuHavenClientContext for the
 * buyer page.
 *
 * Slim mirror of `frontend/src/services/v35/context.ts:buildWriteContext`.
 * The buyer page's context bundles the kernel-backed sender, the
 * cofhe client (ephemeral-EOA-signed per ADR-021), and the shared
 * public client into one object that every `@muhaven/sdk` client
 * accepts as its constructor first argument.
 *
 * Critical: `withSenderAccount(cofheClient, kernelAddress)` wraps the
 * cofhe client so every `encryptInputs(...)` call binds
 * `.setAccount(kernelAddress)` before execute. Without this, cofhe
 * signs the verifier proof against the ephemeral EOA, and the on-chain
 * `FHE.asEuint*` reverts with `InvalidSigner` (selector 0x7ba5ffb5)
 * because `msg.sender` (the kernel) doesn't match the encryption
 * account. See dashboard's context.ts comment + Phase 8 blocker doc
 * for the full walk-through.
 */

import type { Address, PublicClient } from 'viem';
import type { MuHavenClientContext, CofheLikeClient } from '@muhaven/sdk';
import type { KernelAccountClient } from '@zerodev/sdk';
import { getPublicClient } from './chain.js';
import { getCofheClient } from './cofhe.js';
import { createBuyerSender } from './sender.js';

/**
 * Wrap a cofhe client so every `encryptInputs(...)` call is bound to
 * a specific encryption account via `setAccount(senderAddress)`. Same
 * primitive as the dashboard's `withSenderAccount` — the encrypted
 * input is "owned by" the account whose address matches `msg.sender`
 * of the contract that calls `FHE.asEuint*(input)`.
 *
 * Without this binding, cofhe defaults to the connected wallet
 * client's account (the ephemeral EOA), and `extractSigner` recovers
 * a mismatching signer → on-chain revert.
 */
function withSenderAccount(
  cofheClient: CofheLikeClient,
  senderAddress: Address,
): CofheLikeClient {
  return {
    encryptInputs(items: unknown[]) {
      return cofheClient.encryptInputs(items).setAccount(senderAddress);
    },
  };
}

/**
 * Build the full write context for the buyer page. Lazy + idempotent
 * — the cofhe init runs only on first call (lazy `@cofhe/sdk` import
 * defers ~200 KB out of the funding-step initial bundle).
 *
 * @param kernelClient — the buyer's ZeroDev kernel from `passkey.ts`.
 * @param kernelAddress — the kernel's on-chain address (the
 *        `state.buyerAddress` after the passkey ceremony).
 */
export async function buildBuyerContext(
  kernelClient: KernelAccountClient,
  kernelAddress: Address,
): Promise<MuHavenClientContext> {
  const cofheClient = await getCofheClient();
  const sender = createBuyerSender(kernelClient, kernelAddress);
  const boundCofhe = withSenderAccount(
    cofheClient as unknown as CofheLikeClient,
    sender.address,
  );
  return {
    publicClient: getPublicClient() as unknown as PublicClient as unknown as MuHavenClientContext['publicClient'],
    sender,
    cofheClient:
      boundCofhe as unknown as MuHavenClientContext['cofheClient'],
  };
}
