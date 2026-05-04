import { inEncryptedTuple } from './_shared.js'

/**
 * YieldSnapshot — pull-based yield distribution (ADR-005).
 */
export const yieldSnapshotAbi = [
  // ── Issuer cold path ─────────────────────────────────────────────────
  {
    name: 'openEpoch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'epochId', type: 'uint256' }],
  },
  {
    name: 'snapshotBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'investors', type: 'address[]' },
    ],
    outputs: [],
  },
  {
    name: 'finalizeSnapshot',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'fundEpoch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'encTotalYield', ...inEncryptedTuple },
      { name: 'ratePerShare', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    name: 'sweepExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [],
  },
  // ── Investor hot path ────────────────────────────────────────────────
  {
    name: 'claimYield',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  // ── Audit-handle cross-session decrypt (ADR-042 mirror) ──────────────
  {
    name: 'refreshAuditGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handle', type: 'bytes32' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  // Phase 9.C / L2 follow-up — re-stamp the issuer's kernel ACL grant
  // on encTotalSupply onto a fresh ephemeralEOA. Required because the
  // L2 grant in finalizeSnapshot only reaches the kernel; permit-based
  // decrypt needs the eph (ADR-009: kernels can't sign permits).
  {
    name: 'refreshSnapshotSupplyGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  // ── Views ─────────────────────────────────────────────────────────────
  {
    name: 'getEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'snapshotStartTs', type: 'uint256' },
          { name: 'snapshotEndTs', type: 'uint256' },
          { name: 'finalized', type: 'bool' },
          { name: 'funded', type: 'bool' },
          { name: 'encTotalYield', type: 'bytes32' },
          { name: 'encTotalSupply', type: 'bytes32' },
          { name: 'encRatio', type: 'bytes32' },
          { name: 'claimExpiry', type: 'uint256' },
          { name: 'holderCount', type: 'uint256' },
          { name: 'ratePerShare', type: 'uint128' },
        ],
      },
    ],
  },
  {
    name: 'getSnapshotBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'investor', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'hasClaimed',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'investor', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'currentEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'isSwept',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getClaimExpiryFor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  // ── Events ────────────────────────────────────────────────────────────
  {
    name: 'EpochOpened',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'SnapshotBatchApplied',
    type: 'event',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'batchSize', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'SnapshotFinalized',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'holderCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'EpochFunded',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    // Phase 9.A audit-handle follow-up: broadened with `amount` (euint64
    // handle, bytes32). Carries kernel + ephemeralEOA ACL grants so the
    // investor can decrypt the per-claim amount via the audit handle —
    // bypasses the cumulative `MuHavenStable._balances[investor]`
    // chain-depth issue (`project_cofhe_tn_chain_length_cap`).
    name: 'YieldClaimed',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'investor', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'AuditGrantRefreshed',
    type: 'event',
    inputs: [
      { name: 'kernel', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'handle', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'EpochExpired',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
] as const
