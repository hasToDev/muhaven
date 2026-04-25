import { inEncryptedTuple } from './_shared.js'

/**
 * MuHavenStable — Wave 3.5 Phase 7.5 confidential-USDC wrapper.
 *
 * Surfaces the modern (ephemeralEOA-aware) ABI consumed by `StableClient`.
 * The legacy IFHERC20 shim selectors (`confidentialTransfer(address,uint256)`
 * etc.) are not exported here — Wave 3.5 contracts call them via the ADR-008
 * low-level path and SDK consumers should use the modern surface.
 */
export const muHavenStableAbi = [
  // ── Initialiser metadata ─────────────────────────────────────────────
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  // ── Wrap / unwrap ────────────────────────────────────────────────────
  {
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'unwrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  // ── Confidential transfers (modern surface) ─────────────────────────
  // Note: there are also `transfer(address, euint64, address)` overloads
  // but the SDK only encrypts EOA inputs so we expose the InEuint64 form
  // here. Callers wanting the on-chain-handle overload can hand-encode.
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'encAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }], // euint64
  },
  {
    name: 'transferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'encAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }], // euint64
  },
  // ── Operator model ───────────────────────────────────────────────────
  {
    name: 'setOperator',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'until', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    name: 'isOperator',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'holder', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  // ── Encrypted views ──────────────────────────────────────────────────
  {
    name: 'confidentialBalanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bytes32' }], // euint64 ctHash
  },
  {
    name: 'confidentialTotalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }], // euint64 ctHash
  },
  // ── Self-service ACL refresh (mirror of MuHavenToken.refreshDecryptGrant) ─
  {
    name: 'refreshDecryptGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'ephemeralEOA', type: 'address' }],
    outputs: [],
  },
  // ── Admin views ──────────────────────────────────────────────────────
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'legacyPusdc',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  // ── Events ───────────────────────────────────────────────────────────
  {
    name: 'Wrap',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'Unwrap',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'OperatorSet',
    type: 'event',
    inputs: [
      { name: 'holder', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'until', type: 'uint48', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'DecryptGrantRefreshed',
    type: 'event',
    inputs: [
      { name: 'holder', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const
