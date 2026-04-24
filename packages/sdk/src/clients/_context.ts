import type { Address } from 'viem'
import type { MuHavenClientContext } from '../types.js'
import { ConfigError } from '../errors.js'

/**
 * Guard used by every Wave 3.5 client ctor to validate the shared context
 * plus the client's own contract address in one spot. Keeps the repeated
 * three-field check from polluting each client's constructor.
 */
export function requireContext(
  ctx: MuHavenClientContext | undefined,
  opts: { addressLabel: string; address: Address | undefined },
): asserts ctx is MuHavenClientContext {
  if (!ctx) throw new ConfigError('context is required')
  if (!ctx.publicClient) throw new ConfigError('context.publicClient is required')
  if (!ctx.sender) throw new ConfigError('context.sender is required')
  if (!ctx.cofheClient) throw new ConfigError('context.cofheClient is required')
  if (!opts.address) throw new ConfigError(`${opts.addressLabel} address is required`)
}

const ZERO_ADDRESS_LOWER = '0x0000000000000000000000000000000000000000'

/**
 * Validate an `ephemeralEOA` per ADR-021. The session signer address MUST
 * be non-zero — contracts revert with `InvalidEphemeralEOA` on zero, but
 * surfacing the error SDK-side keeps the failure synchronous and avoids
 * burning gas for a request that will deterministically revert. Comparison
 * is case-insensitive because viem `Address` is checksum-cased.
 */
export function requireEphemeralEOA(ephemeralEOA: Address | undefined): asserts ephemeralEOA is Address {
  if (!ephemeralEOA || ephemeralEOA.toLowerCase() === ZERO_ADDRESS_LOWER) {
    throw new ConfigError('ephemeralEOA must be a non-zero address (ADR-021)')
  }
}
