/**
 * MuHavenSender adapter for ZeroDev-backed passkey kernels.
 *
 * The MuHaven SDK (`@muhaven/sdk`) speaks through the `MuHavenSender`
 * interface for all writes. The SDK ships a `walletClientToSender(walletClient)`
 * helper for Node/EOA consumers. Browser consumers using ERC-4337 account
 * abstraction own their own adapter — this file is ours.
 *
 * Internally, `write(...)` encodes the call via viem's `encodeFunctionData`
 * and submits through the existing `wallet.sendUserOperation([...])` path,
 * which waits for the UserOp receipt and returns a confirmed tx hash —
 * satisfying the SDK's "return a tx hash, not a UserOp hash" contract.
 */

import { encodeFunctionData, type Address, type Hash } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import type { MuHavenSender } from '@muhaven/sdk'
import { useWalletStore } from '@/stores/wallet'

/**
 * Build a `MuHavenSender` bound to the current ZeroDev kernel session.
 *
 * Call this at the point of use (e.g. inside a Distribute button handler),
 * not at module scope — `wallet.address` must be set (user logged in) and
 * is captured at construction.
 */
export function createZeroDevSender(): MuHavenSender {
  const wallet = useWalletStore()
  const address = wallet.address
  if (!address) {
    throw new Error('createZeroDevSender: wallet not connected — sign in first')
  }

  return {
    address: address as Address,

    // The ZeroDev kernel is constructed pinned to Arbitrum Sepolia. There's
    // no per-call path to switch networks from the browser, so we report the
    // static chain id the kernel was built with. The SDK's validateNetwork()
    // will cross-check against publicClient.getChainId() independently.
    getChainId: async () => arbitrumSepolia.id,

    write: async ({ address: to, abi, functionName, args }): Promise<Hash> => {
      const data = encodeFunctionData({
        abi: abi as any,
        functionName,
        args: args as any,
      })
      const hash = await wallet.sendUserOperation([{ to: to as `0x${string}`, data }])
      return hash as Hash
    },
  }
}
