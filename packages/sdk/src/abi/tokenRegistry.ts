/**
 * TokenRegistry — per-token platform configuration (ADR-024).
 *
 * Read-only surface consumed by the other clients (they resolve treasury +
 * oracle addresses off the registry when the caller wants to avoid
 * double-bookkeeping).
 */
export const tokenRegistryAbi = [
  {
    name: 'isActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getConfig',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'active', type: 'bool' },
          { name: 'treasury', type: 'address' },
          { name: 'queue', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'issuer', type: 'address' },
          { name: 'minInvestment', type: 'uint128' },
          { name: 'instantRedeemCap', type: 'uint128' },
          { name: 'epochDuration', type: 'uint32' },
          { name: 'paused', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getRegisteredTokens',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ type: 'address[]' }],
  },
  {
    name: 'registeredTokenCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const
