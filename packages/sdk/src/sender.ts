import type { Address, Hash, WalletClient } from 'viem'

/**
 * Pluggable transaction sender. Decouples the SDK from viem's `WalletClient`
 * so consumers can route writes through ERC-4337 account-abstraction bundlers
 * (e.g. ZeroDev Kernel + passkeys) instead of EOA `eth_sendTransaction`.
 *
 * Implementations:
 *   - `walletClientToSender(walletClient)` — ships with the SDK; used by
 *     Node scripts + backend + any consumer holding a raw private key or a
 *     browser EOA connector.
 *   - Consumer-owned adapter — any frontend using a bundler/kernel writes
 *     their own ~30-line adapter that implements this interface in terms of
 *     their bundler SDK (e.g. `kernelClient.sendUserOperation`). The SDK
 *     only depends on the shape below, never on `@zerodev/*` or similar.
 *
 * ### Expected semantics
 *
 * - `write(...)` resolves with a **confirmed transaction hash**, not a
 *   user-operation hash. Implementations backed by a bundler MUST wait for
 *   the UserOp receipt internally and return its `transactionHash`, so the
 *   SDK's `publicClient.waitForTransactionReceipt(hash)` call Just Works.
 * - `address` is the signer/sender's on-chain address (EOA for walletClient,
 *   smart-account address for AA senders).
 * - `getChainId()` is async to match viem's `walletClient.getChainId()`
 *   shape — bundler SDKs typically expose chain info async too.
 */
export interface MuHavenSender {
  readonly address: Address
  getChainId(): Promise<number>
  write(params: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<Hash>
}

/**
 * Wrap a viem `WalletClient` as a `MuHavenSender`. This is the default path
 * for Node scripts (`scripts/test-e2e-sdk.ts`), backend services, and any
 * consumer holding a raw private key.
 *
 * Throws if the wallet client has no `account` set — the SDK needs a
 * concrete signer to populate `writeContract`'s `account` param.
 */
export function walletClientToSender(walletClient: WalletClient): MuHavenSender {
  const account = walletClient.account
  if (!account) {
    throw new Error('walletClientToSender: walletClient has no account')
  }

  return {
    address: account.address,
    getChainId: () => walletClient.getChainId(),
    write: async ({ address, abi, functionName, args }) => {
      return walletClient.writeContract({
        account,
        chain: walletClient.chain,
        address,
        abi: abi as any,
        functionName,
        args: args as any,
      })
    },
  }
}
