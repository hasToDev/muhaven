/**
 * Contract interaction helpers.
 * - Reads: publicClient.readContract() (free eth_call)
 * - Writes: sendUserOperation() (gasless via ZeroDev bundler)
 */

import { encodeFunctionData } from 'viem'
import { useWalletStore } from '@/stores/wallet'
import { WalletNotConnectedError, ContractReadError, UserOpError, DecryptPendingError } from './errors'
import type { TxHash } from './types'

/**
 * Read from a contract (view/pure calls). Uses publicClient — free and instant.
 */
export async function contractRead<TAbi extends readonly unknown[]>(
  address: `0x${string}`,
  abi: TAbi,
  functionName: string,
  args: unknown[] = [],
  contractName = 'Contract',
): Promise<unknown> {
  const wallet = useWalletStore()
  const clients = wallet.getViemClients()
  if (!clients) throw new WalletNotConnectedError()

  try {
    return await clients.publicClient.readContract({
      address,
      abi: abi as any,
      functionName,
      args,
    })
  } catch (e) {
    throw new ContractReadError(contractName, functionName, e)
  }
}

/**
 * Write to a contract (state-changing calls). Encodes calldata and sends
 * via ZeroDev bundler as a gasless user operation.
 */
export async function contractWrite<TAbi extends readonly unknown[]>(
  address: `0x${string}`,
  abi: TAbi,
  functionName: string,
  args: unknown[] = [],
  contractName = 'Contract',
): Promise<TxHash> {
  const wallet = useWalletStore()
  if (!wallet.getViemClients()) throw new WalletNotConnectedError()

  let data: `0x${string}`
  try {
    data = encodeFunctionData({
      abi: abi as any,
      functionName,
      args,
    })
  } catch (e) {
    throw new UserOpError(contractName, functionName, undefined, e)
  }

  try {
    const hash = await wallet.sendUserOperation([{ to: address, data }])
    return hash as TxHash
  } catch (e) {
    throw new UserOpError(contractName, functionName, undefined, e)
  }
}

/**
 * Poll a view function until a condition is met.
 * Used for async decrypt flows (request → wait → read result).
 */
export async function pollUntil<T>(
  readFn: () => Promise<T>,
  isReady: (result: T) => boolean,
  { intervalMs = 3000, maxAttempts = 20, label = 'decrypt' } = {},
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, intervalMs))
    const result = await readFn()
    if (isReady(result)) return result
  }
  throw new DecryptPendingError(
    `${label} (timed out after ${(maxAttempts - 1) * intervalMs / 1000}s, ${maxAttempts} attempts)`,
  )
}
