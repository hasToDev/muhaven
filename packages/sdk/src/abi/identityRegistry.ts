/**
 * MuHavenIdentityRegistry — ERC-3643-shaped identity registry (ADR-011).
 *
 * SDK surface is the subset consumed by `IdentityRegistryClient`: verification
 * reads + the whitelist / dev-mode / claim mutators the frontend dev banner
 * and the Wave 3 bulk-import script need.
 */
export const identityRegistryAbi = [
  // ── Reads ─────────────────────────────────────────────────────────────
  {
    name: 'isVerified',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'devMode',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'devModeDisabled',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'countryOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint16' }],
  },
  {
    name: 'isAccredited',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // ── Dev-mode lifecycle (ADR-023) ─────────────────────────────────────
  {
    name: 'setDevMode',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'enabled', type: 'bool' }],
    outputs: [],
  },
  {
    name: 'disableDevModeForever',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  // ── Whitelist management ─────────────────────────────────────────────
  {
    name: 'addWhitelisted',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'accounts', type: 'address[]' }],
    outputs: [],
  },
  {
    name: 'removeWhitelisted',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'WhitelistAdded',
    type: 'event',
    inputs: [{ name: 'account', type: 'address', indexed: true }],
    anonymous: false,
  },
  {
    name: 'WhitelistRemoved',
    type: 'event',
    inputs: [{ name: 'account', type: 'address', indexed: true }],
    anonymous: false,
  },
  {
    name: 'DevModeToggled',
    type: 'event',
    inputs: [
      { name: 'enabled', type: 'bool', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'DevModeDisabledForever',
    type: 'event',
    inputs: [{ name: 'timestamp', type: 'uint256', indexed: false }],
    anonymous: false,
  },
] as const
