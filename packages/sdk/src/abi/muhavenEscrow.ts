export const muhavenEscrowAbi = [
  // ── SDK creation + funding ─────────────────────────────────────────
  {
    name: 'batchCreate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'owners',
        type: 'tuple[]',
        components: [
          { name: 'ctHash', type: 'uint256' },
          { name: 'securityZone', type: 'uint8' },
          { name: 'utype', type: 'uint8' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'resolver', type: 'address' },
      { name: 'resolverData', type: 'bytes[]' },
    ],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    name: 'fundFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'amount', type: 'bytes32' },
    ],
    outputs: [],
  },
  // ── Investor redemption ────────────────────────────────────────────
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'redeemMultiple',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowIds', type: 'uint256[]' }],
    outputs: [],
  },
  // ── Views ──────────────────────────────────────────────────────────
  {
    name: 'exists',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getOwner',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'getPaidAmount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'getIsRedeemed',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'getResolver',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'total',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'escrowCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'paymentToken',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'MAX_BATCH_SIZE',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  // ── Events ─────────────────────────────────────────────────────────
  {
    name: 'EscrowCreated',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
      { name: 'resolver', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'EscrowFunded',
    type: 'event',
    inputs: [{ name: 'escrowId', type: 'uint256', indexed: true }],
    anonymous: false,
  },
  {
    name: 'EscrowRedeemed',
    type: 'event',
    inputs: [{ name: 'escrowId', type: 'uint256', indexed: true }],
    anonymous: false,
  },
] as const
