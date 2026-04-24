import { inEncryptedTuple } from './_shared.js'

/**
 * RedemptionQueue — per-token overflow queue (ADR-004).
 *
 * Note: `submitFor` is a trusted-caller-only entry (the bound
 * `MuHavenSubscription` fires it on cap-overflow escalation). The SDK does
 * NOT expose it — kept out of the ABI to avoid consumers wiring it directly.
 */
export const redemptionQueueAbi = [
  // ── Investor hot path ────────────────────────────────────────────────
  {
    name: 'submit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encShares', ...inEncryptedTuple },
      { name: 'maxSharesHint', type: 'uint128' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }],
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [],
  },
  // ── Issuer cold path ─────────────────────────────────────────────────
  {
    name: 'processEpoch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'startIdx', type: 'uint256' },
      { name: 'endIdx', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'cancelOnKYCRevocation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [],
  },
  // ── Views ─────────────────────────────────────────────────────────────
  {
    name: 'token',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'treasury',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'issuer',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'currentEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'nextRequestId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getRequest',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'investor', type: 'address' },
          { name: 'encShares', type: 'bytes32' },
          { name: 'encProceeds', type: 'bytes32' },
          { name: 'epochId', type: 'uint256' },
          { name: 'ephemeralEOA', type: 'address' },
          { name: 'maxSharesHint', type: 'uint128' },
          { name: 'settled', type: 'bool' },
          { name: 'claimed', type: 'bool' },
          { name: 'cancelled', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getEpochRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [{ type: 'uint256[]' }],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'QueueSubmitted',
    type: 'event',
    inputs: [
      { name: 'investor', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'EpochProcessed',
    type: 'event',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'requestCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'QueueClaimed',
    type: 'event',
    inputs: [
      { name: 'investor', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'QueueCancelled',
    type: 'event',
    inputs: [
      { name: 'investor', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
] as const
