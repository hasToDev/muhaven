import { inEncryptedTuple } from './_shared.js'

/**
 * MuHavenTreasury — per-token PUSDC custodian (one instance per RWA token).
 *
 * `deposit`/`withdraw` are issuer-only; no user-decryptable state is produced,
 * so no `ephemeralEOA` parameter — see `IMuHavenTreasury` natspec.
 */
export const muhavenTreasuryAbi = [
  // ── Issuer hot path ──────────────────────────────────────────────────
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'encAmount', ...inEncryptedTuple }],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'encAmount', ...inEncryptedTuple }],
    outputs: [],
  },
  // ── Admin ─────────────────────────────────────────────────────────────
  {
    name: 'setMinFloat',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newMin', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'setIssuer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newIssuer', type: 'address' }],
    outputs: [],
  },
  // ── Views ─────────────────────────────────────────────────────────────
  {
    name: 'getFloat',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getMinFloat',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'token',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'subscription',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'queue',
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
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'TreasuryDeposited',
    type: 'event',
    inputs: [{ name: 'issuer', type: 'address', indexed: true }],
    anonymous: false,
  },
  {
    name: 'TreasuryWithdrawn',
    type: 'event',
    inputs: [{ name: 'issuer', type: 'address', indexed: true }],
    anonymous: false,
  },
] as const
