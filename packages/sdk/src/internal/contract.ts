import type { Address, Hash, PublicClient, WalletClient } from 'viem'
import { parseEventLogs } from 'viem'
import { TxFailedError } from '../errors.js'

/**
 * Send a write transaction via the provided wallet client and wait for its receipt.
 * Throws TxFailedError if the receipt reverts.
 */
export async function writeAndWait(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  operation: string
}): Promise<{ hash: Hash; logs: import('viem').Log[] }> {
  const { publicClient, walletClient, address, abi, functionName, args: callArgs, operation } = args
  const account = walletClient.account
  if (!account) throw new TxFailedError(operation, undefined, new Error('walletClient has no account'))
  const chain = walletClient.chain

  let hash: Hash
  try {
    hash = await walletClient.writeContract({
      account,
      chain,
      address,
      abi: abi as any,
      functionName,
      args: callArgs as any,
    })
  } catch (e) {
    throw new TxFailedError(operation, undefined, e)
  }

  let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash })
  } catch (e) {
    throw new TxFailedError(operation, hash, e)
  }

  if (receipt.status !== 'success') {
    throw new TxFailedError(operation, hash, new Error(`receipt status: ${receipt.status}`))
  }

  return { hash, logs: receipt.logs }
}

/**
 * Extract escrowIds from EscrowCreated event logs in a tx receipt.
 * Returns IDs in log order (matches the order of `owners[]` submitted to batchCreate).
 */
export function parseEscrowCreatedIds(logs: import('viem').Log[], escrowAbi: readonly unknown[], escrowAddress: Address): bigint[] {
  const parsed = parseEventLogs({
    abi: escrowAbi as any,
    eventName: 'EscrowCreated',
    logs,
  })

  const ids: bigint[] = []
  for (const log of parsed) {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) continue
    const args = (log as unknown as { args: { escrowId: bigint } }).args
    ids.push(args.escrowId)
  }
  return ids
}
