import type { Address } from 'viem'
import type { CofheLikeClient, EncryptedInput } from '../types.js'
import { EncryptionError } from '../errors.js'
import { toEncryptedInput } from './encoding.js'

/**
 * Build the CoFHE `Encryptable` items array for a batch of addresses.
 *
 * Lazy-imports `@cofhe/sdk` so consumers that only pay for structural types
 * don't drag the SDK (or its WASM) into every module graph.
 */
export async function buildAddressEncryptables(addresses: Address[]): Promise<unknown[]> {
  const { Encryptable } = await import('@cofhe/sdk')
  return addresses.map(addr => (Encryptable as any).address(addr))
}

/**
 * Build the CoFHE `Encryptable` item for a single uint64 value.
 */
export async function buildUint64Encryptable(value: bigint): Promise<unknown> {
  const { Encryptable } = await import('@cofhe/sdk')
  return (Encryptable as any).uint64(value)
}

/**
 * Encrypt a batch of addresses into `EncryptedInput[]` ready for batchCreate.
 * Shares a single ZK-proof computation across the batch (CoFHE SDK behavior).
 */
export async function encryptAddresses(
  cofhe: CofheLikeClient,
  addresses: Address[],
): Promise<EncryptedInput[]> {
  if (addresses.length === 0) return []

  const items = await buildAddressEncryptables(addresses)
  let raw: unknown[]
  try {
    raw = await cofhe.encryptInputs(items).execute()
  } catch (e) {
    throw new EncryptionError(`batch encrypt of ${addresses.length} addresses failed`, e)
  }

  if (raw.length !== addresses.length) {
    throw new EncryptionError(
      `expected ${addresses.length} encrypted results, got ${raw.length}`,
    )
  }

  return raw.map((r, i) => toEncryptedInput(r, i))
}

/**
 * Encrypt a single uint64 into `EncryptedInput`. Used for `startDistribution`
 * total-yield amount.
 */
export async function encryptUint64(
  cofhe: CofheLikeClient,
  value: bigint,
): Promise<EncryptedInput> {
  const item = await buildUint64Encryptable(value)
  let raw: unknown[]
  try {
    raw = await cofhe.encryptInputs([item]).execute()
  } catch (e) {
    throw new EncryptionError(`uint64 encrypt failed`, e)
  }
  const first = raw[0]
  if (first === undefined) throw new EncryptionError('no encrypted result returned')
  return toEncryptedInput(first, 0)
}
