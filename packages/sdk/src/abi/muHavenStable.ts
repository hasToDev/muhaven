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
  // ── Direct USDC exit (Wave 5 W3 — two-phase async, no PUSDC) ─────────
  {
    name: 'withdrawToUsdc',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [{ name: 'claimId', type: 'uint256' }],
  },
  {
    name: 'claimUsdc',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'setUsdcReserveToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usdc_', type: 'address' }],
    outputs: [],
  },
  {
    name: 'fundUsdcReserve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'withdrawUsdcReserve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'setClaimsPaused',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'paused_', type: 'bool' }],
    outputs: [],
  },
  {
    name: 'usdc',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'claimsPaused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'usdcReserveBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getWithdrawClaim',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'handle', type: 'bytes32' }, // euint64
          { name: 'amount', type: 'uint64' },
          { name: 'claimed', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getUserWithdrawClaims',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    name: 'withdrawDecryptResult',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [
      { name: 'amount', type: 'uint64' },
      { name: 'ready', type: 'bool' },
    ],
  },
  {
    name: 'MAX_PENDING_WITHDRAWALS',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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
  // Phase 9.A · Option Z follow-up — historical audit-handle re-grant
  // for cross-session decrypts on /activity. Gate inside the contract is
  // `FHE.isAllowed(handle, msg.sender)` — only the rightful kernel can
  // re-grant.
  {
    name: 'refreshAuditGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handle', type: 'bytes32' }, // euint64
      { name: 'ephemeralEOA', type: 'address' },
    ],
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
  // Phase 9.A · Option Z — Wrap / Unwrap events broadened to carry the
  // encrypted `amount` handle (`euint64` → `bytes32`). Pre-upgrade rows
  // emitted under the old 2-arg signature are intentionally invisible to
  // the new topic filter — by design, no back-index.
  {
    name: 'Wrap',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'Unwrap',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false },
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
  // Phase 9.A · Option Z follow-up — emitted when a caller re-grants ACL
  // on a historical audit handle to a fresh ephemeralEOA.
  {
    name: 'AuditGrantRefreshed',
    type: 'event',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'handle', type: 'bytes32', indexed: false }, // euint64
    ],
    anonymous: false,
  },
  // ── Direct USDC exit (Wave 5 W3) ─────────────────────────────────────
  {
    name: 'WithdrawRequested',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'handle', type: 'bytes32', indexed: false }, // euint64 (audit)
    ],
    anonymous: false,
  },
  {
    name: 'WithdrawClaimed',
    type: 'event',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint64', indexed: false }, // cleartext USDC (6-dp)
    ],
    anonymous: false,
  },
  {
    name: 'ClaimsPausedSet',
    type: 'event',
    inputs: [{ name: 'paused', type: 'bool', indexed: false }],
    anonymous: false,
  },
] as const
