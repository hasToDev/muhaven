import { encodeAbiParameters, type Address, type Hex } from 'viem'
import type { EncryptedInput } from '../types.js'
import { EncryptionError } from '../errors.js'

/**
 * Coerce a value returned by `cofheClient.encryptInputs([...]).execute()` into
 * the canonical `EncryptedInput` tuple expected by MuHavenEscrow.batchCreate
 * (and the rest of the CoFHE-contract ABI).
 *
 * The CoFHE SDK returns items with ctHash/securityZone/utype/signature fields,
 * but field types may vary across SDK versions (e.g. signature as `0x...`
 * string vs hex). This normalizes to strict viem-compatible types.
 */
export function toEncryptedInput(raw: unknown, index = 0): EncryptedInput {
  if (!raw || typeof raw !== 'object') {
    throw new EncryptionError(`item[${index}] is not an object`)
  }

  const r = raw as Record<string, unknown>

  if (r['ctHash'] === undefined) throw new EncryptionError(`item[${index}] missing ctHash`)
  if (r['securityZone'] === undefined) throw new EncryptionError(`item[${index}] missing securityZone`)
  if (r['utype'] === undefined) throw new EncryptionError(`item[${index}] missing utype`)
  if (r['signature'] === undefined) throw new EncryptionError(`item[${index}] missing signature`)

  const ctHash = typeof r['ctHash'] === 'bigint' ? r['ctHash'] : BigInt(r['ctHash'] as string | number)
  const securityZone = Number(r['securityZone'])
  const utype = Number(r['utype'])
  const sigRaw = r['signature']
  const signature = (
    typeof sigRaw === 'string' && sigRaw.startsWith('0x')
      ? sigRaw
      : `0x${sigRaw as string}`
  ) as Hex

  return { ctHash, securityZone, utype, signature }
}

/**
 * Encode the per-escrow `resolverData` bytes blob for YieldGate:
 * a single ABI-encoded `address` (the plaintext beneficiary).
 */
export function encodeYieldGateResolverData(beneficiary: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }], [beneficiary])
}
