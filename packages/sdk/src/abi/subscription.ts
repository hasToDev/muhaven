import { inEncryptedTuple } from './_shared.js'

/**
 * MuHavenSubscription — Wave 3.5 atomic buy/sell coordinator.
 *
 * ABI surface kept to what the SDK actually calls. Trailing `ephemeralEOA`
 * param on every mutation is the ADR-021 session signer address.
 */
export const muhavenSubscriptionAbi = [
  // ── Investor hot path ────────────────────────────────────────────────
  {
    name: 'purchase',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'encShares', ...inEncryptedTuple },
      { name: 'maxSharesHint', type: 'uint128' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'encShares', ...inEncryptedTuple },
      { name: 'maxSharesHint', type: 'uint128' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  // ── Views ─────────────────────────────────────────────────────────────
  {
    name: 'getInstantCapRemaining',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getCurrentEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'tokenRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'identityRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'pusdc',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'Purchased',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'maxSharesHint', type: 'uint128', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'Redeemed',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'maxSharesHint', type: 'uint128', indexed: false },
      { name: 'escalated', type: 'bool', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'EscalatedToQueue',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
] as const
