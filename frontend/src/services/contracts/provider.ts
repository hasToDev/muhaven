/**
 * Contract interaction helpers.
 * - Reads: publicClient.readContract() (free eth_call)
 * - Writes: sendUserOperation() (gasless via ZeroDev bundler)
 */

import { createPublicClient, http, encodeFunctionData } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { useWalletStore } from '@/stores/wallet'
import { WalletNotConnectedError, ContractReadError, UserOpError, DecryptPendingError } from './errors'
import type { TxHash } from './types'

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'

/** Standalone public client for read-only calls — no wallet connection needed. */
let _publicClient: ReturnType<typeof createPublicClient> | null = null
function getPublicClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC_URL) })
  }
  return _publicClient
}

/**
 * Read from a contract (view/pure calls). Uses a standalone publicClient — free, instant,
 * and works without wallet connection (no passkey prompt on page load).
 */
export async function contractRead<TAbi extends readonly unknown[]>(
  address: `0x${string}`,
  abi: TAbi,
  functionName: string,
  args: unknown[] = [],
  contractName = 'Contract',
): Promise<unknown> {
  try {
    return await getPublicClient().readContract({
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
  // Check address presence, not provider readiness. The ZeroDev provider is
  // lazy-initialized on first sendUserOperation via ensureConnected() — avoids
  // a passkey prompt on every page load. Gating on getViemClients() here would
  // throw before that lazy path runs, breaking fresh sessions where address
  // is restored from localStorage but provider hasn't been recreated yet.
  if (!wallet.connected) {
    // Surface exactly what the store thinks — helps diagnose lost-localStorage
    // vs stale Pinia state vs hydrate-failed-silently scenarios in the E2E run.
    // Intentionally verbose so the failure message on DistributePage is actionable.
    console.error('[contractWrite] wallet.connected=false', {
      address: wallet.address,
      connecting: wallet.connecting,
      localStorageAddr: typeof localStorage !== 'undefined' ? localStorage.getItem('muhaven-wallet') : '(no localStorage)',
    })
    throw new WalletNotConnectedError()
  }

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
    // Re-log the underlying cause so the bundler/validator error is visible.
    // Without this, DepositPage's toast shows only the wrapper message and
    // hides the real AA2x / validator revert that we need to debug.
    console.error(`[contractWrite] ${contractName}.${functionName}() failed:`, e)
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
