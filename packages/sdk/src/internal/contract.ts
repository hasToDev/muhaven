import type { Address, Hash, PublicClient } from 'viem'
import { parseEventLogs } from 'viem'
import type { MuHavenSender } from '../sender.js'
import { TxFailedError } from '../errors.js'

/**
 * Submit a write via the pluggable sender and wait for the receipt.
 * Throws TxFailedError if the receipt reverts.
 *
 * The sender is responsible for returning a confirmed **tx hash** (not a
 * UserOp hash) so `publicClient.waitForTransactionReceipt` resolves cleanly
 * — see `MuHavenSender` docstring.
 */
export async function writeAndWait(args: {
  publicClient: PublicClient
  sender: MuHavenSender
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  operation: string
}): Promise<{ hash: Hash; logs: import('viem').Log[] }> {
  const { publicClient, sender, address, abi, functionName, args: callArgs, operation } = args

  let hash: Hash
  try {
    hash = await sender.write({
      address,
      abi,
      functionName,
      args: callArgs,
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
