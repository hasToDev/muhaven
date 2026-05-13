/**
 * Wave 4 P5 (Wave-5 buyer-side port, P3) — MuHavenSender adapter for
 * the buyer page's ZeroDev kernel.
 *
 * Slim mirror of `frontend/src/services/contracts/zeroDevSender.ts`,
 * adapted for the buyer page's stateless kernel-client passing
 * pattern (no Pinia store — the kernel is held in `state.kernelClient`
 * in `main.ts:PageState`). The MuHaven SDK consumes `MuHavenSender`
 * for every write; this adapter wraps the kernel's
 * `sendUserOperation([{to, data}])` call.
 *
 * Contract (per `@muhaven/sdk`'s `MuHavenSender`):
 *  - `address`: the on-chain msg.sender that contracts see (the kernel).
 *  - `getChainId()`: static — kernels are pinned to Arb Sepolia.
 *  - `write({address, abi, functionName, args})`: returns CONFIRMED
 *    tx hash, not a UserOp hash. The SDK's `writeAndWait` then waits
 *    for the receipt and parses logs — passing a UserOp hash here
 *    would break that contract.
 *
 * The kernel's `sendUserOperation` returns a UserOp hash; we wait for
 * the receipt + extract the actual on-chain tx hash via
 * `waitForUserOperationReceipt`. This matches the dashboard's
 * `wallet.sendUserOperation` shape post-Wave-3 cutover.
 */

import { encodeFunctionData, type Address, type Hash } from 'viem';
import type { KernelAccountClient } from '@zerodev/sdk';
import type { MuHavenSender } from '@muhaven/sdk';
import { ARB_SEPOLIA_CHAIN } from './chain.js';

/**
 * Build a `MuHavenSender` bound to a specific kernel client. The
 * kernel must be live (passkey ceremony complete + account ready) —
 * callers should pass `state.kernelClient` from the buyer-page page
 * state, which is non-null after `connectOrCreate()` resolves.
 */
export function createBuyerSender(
  kernelClient: KernelAccountClient,
  kernelAddress: Address,
): MuHavenSender {
  return {
    address: kernelAddress,

    // The kernel is constructed pinned to Arb Sepolia in
    // `passkey.ts:buildKernelClient`. No per-call network switching.
    // The SDK's `validateNetwork()` cross-checks publicClient.getChainId().
    getChainId: async () => ARB_SEPOLIA_CHAIN.id,

    write: async ({ address: to, abi, functionName, args }): Promise<Hash> => {
      const data = encodeFunctionData({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abi: abi as any,
        functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: args as any,
      });
      // `sendUserOperation` on a KernelAccountClient submits to the
      // bundler + returns the UserOp hash. We need to wait for the
      // receipt so the SDK's downstream `waitForTransactionReceipt`
      // gets a real on-chain hash, not a 4337 UserOp hash. Use
      // `waitForUserOperationReceipt` which returns the underlying
      // tx receipt with the on-chain hash inside.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kc = kernelClient as any;
      const userOpHash: Hash = await kc.sendUserOperation({
        calls: [{ to: to as `0x${string}`, value: 0n, data }],
      });
      const receipt = await kc.waitForUserOperationReceipt({
        hash: userOpHash,
      });
      // ZeroDev's `waitForUserOperationReceipt` returns shape
      // `{success, userOpHash, receipt: {transactionHash, ...}}`.
      const txHash: Hash =
        receipt?.receipt?.transactionHash ?? receipt?.transactionHash;
      if (!txHash) {
        throw new Error(
          `sendUserOperation receipt missing transactionHash for ${functionName}`,
        );
      }
      return txHash;
    },
  };
}
