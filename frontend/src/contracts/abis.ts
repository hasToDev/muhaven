/**
 * Minimal ABI fragments for MuHaven contracts.
 * Only includes functions the frontend actually calls.
 *
 * Encrypted input struct (InEuint128 / InEuint64):
 *   tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
 *
 * Encrypted handles (euint128 / euint64) are bytes32 in the ABI.
 */

// ── Shared tuple definition ────────────────────────────────────────

const inEncryptedTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'ctHash', type: 'uint256' as const },
    { name: 'securityZone', type: 'uint8' as const },
    { name: 'utype', type: 'uint8' as const },
    { name: 'signature', type: 'bytes' as const },
  ],
}

// ── MuHavenToken ───��───────────────────────────────────────────────

export const muHavenTokenAbi = [
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
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', ...inEncryptedTuple },
    ],
    outputs: [],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', ...inEncryptedTuple },
    ],
    outputs: [],
  },
  // Wave 3.5 canonical transfer — ADR-021 ephemeralEOA overload.
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', ...inEncryptedTuple },
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'transferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'encryptedAmount', ...inEncryptedTuple },
    ],
    outputs: [],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'encryptedAmount', ...inEncryptedTuple },
    ],
    outputs: [],
  },
  {
    name: 'encryptedBalanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'encryptedTotalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'requestBalanceDecrypt',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    // Wave 3.5 Phase 7 — self-service ACL refresh. Caller re-grants decrypt
    // access on their own balance handle to `ephemeralEOA` (ADR-021 +
    // PERMIT_DECRYPT_LIFECYCLE §8 Q4). Frontend auto-fires on 403 decrypt.
    name: 'refreshDecryptGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'ephemeralEOA', type: 'address' }],
    outputs: [],
  },
  // Phase 9.A · Option Z follow-up — historical Transfer audit-handle
  // re-grant for cross-session decrypts on /activity. Gate inside the
  // contract is `FHE.isAllowed(handle, msg.sender)` — only the
  // transfer-time sender or recipient can re-grant.
  {
    name: 'refreshAuditGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handle', type: 'bytes32' }, // euint128
      { name: 'ephemeralEOA', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'getBalanceDecryptResult',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'result', type: 'uint128' },
      { name: 'decrypted', type: 'bool' },
    ],
  },
  {
    name: 'totalSupplyPublic',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'owner',
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
    name: 'minters',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // ── Events (Phase 9.A · Option Z follow-up — broadened Transfer + new
  // AuditGrantRefreshed event for cross-session audit decrypts) ───────
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'bytes32', indexed: false }, // euint128
    ],
    anonymous: false,
  },
  {
    name: 'AuditGrantRefreshed',
    type: 'event',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'ephemeralEOA', type: 'address', indexed: true },
      { name: 'handle', type: 'bytes32', indexed: false }, // euint128
    ],
    anonymous: false,
  },
] as const

// ── MuHavenVault ──────���─────────────────────────────���──────────────

export const muHavenVaultAbi = [
  {
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'unwrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getLockedBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalLocked',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'minInvestment',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'underlyingToken',
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
] as const

// ── InvestorRegistry ───��───────────────────────────────────────────

export const investorRegistryAbi = [
  {
    name: 'isInvestor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'investorCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getInvestorsPaginated',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ type: 'address[]' }],
  },
] as const

// ── YieldDistributor ───────��───────────────────────────────────────

export const yieldDistributorAbi = [
  {
    name: 'authorizedCallers',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'startDistribution',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'encryptedTotalYield', ...inEncryptedTuple }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'startDistributionFromBalance',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'processBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'distributionId', type: 'uint256' },
      { name: 'batchSize', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'isDistributionComplete',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getDistribution',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'encTotalYield', type: 'bytes32' },
      { name: 'encPerInvestorYield', type: 'bytes32' },
      { name: 'investorCount', type: 'uint256' },
      { name: 'processedCount', type: 'uint256' },
      { name: 'escrowsCreated', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
  },
  {
    name: 'distributionCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  // ── SDK-driven escrow attachment (Phase 19B) ──────────────────────
  {
    name: 'setEscrowIds',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'distributionId', type: 'uint256' },
      { name: 'escrowIds', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    name: 'getEscrowIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [{ type: 'uint256[]' }],
  },
  // ── Admin setter (renamed from setReineiraEscrow in 19B.6) ─────────
  {
    name: 'setMuHavenEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newEscrow', type: 'address' }],
    outputs: [],
  },
  // ── Admin: grant aggregate yield decrypt access (Phase 19D.0) ──────
  {
    name: 'grantYieldDecryptAccess',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'distributionId', type: 'uint256' },
      { name: 'viewer', type: 'address' },
    ],
    outputs: [],
  },
  // ── Events ────────────────────────────────────────────────────────
  {
    name: 'DistributionStarted',
    type: 'event',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'EscrowIdsAttached',
    type: 'event',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'count', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'BatchProcessed',
    type: 'event',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'processedCount', type: 'uint256', indexed: false },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    name: 'DistributionCompleted',
    type: 'event',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'MuHavenEscrowUpdated',
    type: 'event',
    inputs: [{ name: 'newEscrow', type: 'address', indexed: true }],
    anonymous: false,
  },
  {
    name: 'YieldDecryptAccessGranted',
    type: 'event',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'viewer', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const

// ── MuHavenEscrow (Phase 19B) ──────────────────────────────────────
// Custom FHE escrow. Replaces the ReineiraOS ConfidentialEscrow in the yield
// pipeline. Investor-facing paths the frontend cares about are redeem /
// redeemMultiple + the views (exists, getPaidAmount, getIsRedeemed).
// batchCreate + fundFrom are SDK-driven from Phase 19C.

export const muhavenEscrowAbi = [
  // ── Role checks ────────────────────────────────────────────────────
  {
    name: 'authorizedCallers',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // ── SDK creation + funding ─────────────────────────────────────────
  {
    name: 'batchCreate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owners', type: 'tuple[]', components: [
        { name: 'ctHash', type: 'uint256' },
        { name: 'securityZone', type: 'uint8' },
        { name: 'utype', type: 'uint8' },
        { name: 'signature', type: 'bytes' },
      ] },
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
  // ── Events (consumed by backend poller + frontend activity feed) ───
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

// ── ERC3643KYCAdapter ──────────────────────────────────────────────

export const kycAdapterAbi = [
  {
    name: 'isEligible',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'isEligibleForTier',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'tier', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'isWhitelisted',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'isAccredited',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'addToWhitelist',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    name: 'removeFromWhitelist',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    name: 'batchAddToWhitelist',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'accounts', type: 'address[]' }],
    outputs: [],
  },
  {
    name: 'addToAccreditedList',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    name: 'removeFromAccreditedList',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    name: 'providerName',
    type: 'function',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const

// ── RiskParams ──────────────────────────────────────────��──────────

export const riskParamsAbi = [
  {
    name: 'setRiskParams',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encMaxDrawdownBps', ...inEncryptedTuple },
      { name: 'encMinYieldBps', ...inEncryptedTuple },
      { name: 'encDriftToleranceBps', ...inEncryptedTuple },
      { name: 'encMaxDailySpend', ...inEncryptedTuple },
    ],
    outputs: [],
  },
  {
    name: 'requestRiskParamsDecrypt',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'investor', type: 'address' }],
    outputs: [],
  },
  {
    name: 'getRiskParamsDecryptResult',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'investor', type: 'address' }],
    outputs: [
      { name: 'maxDrawdownBps', type: 'uint64' },
      { name: 'minYieldBps', type: 'uint64' },
      { name: 'driftToleranceBps', type: 'uint64' },
      { name: 'maxDailySpend', type: 'uint64' },
      { name: 'd0', type: 'bool' },
      { name: 'd1', type: 'bool' },
      { name: 'd2', type: 'bool' },
      { name: 'd3', type: 'bool' },
    ],
  },
  {
    name: 'hasRiskParams',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'investor', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

// ── ERC-20 (generic) ───���───────────────────────────────────────────

export const erc20Abi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  // Standard ERC-20 Transfer event — used by `viem.watchContractEvent` on
  // /cash to auto-detect inbound USDC and refresh the right-aside balance
  // without a manual click.
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const

// ── ConfidentialUSDC (PUSDC) ─────────────────────────────────────────
// Minimal ABI covering only what the frontend needs for pre-flight checks
// and self-operator approval. All FHE-ciphertext methods are intentionally
// omitted — consumers should not attempt to read encrypted balances here.
//
// Deployed ConfidentialUSDC on Arb Sepolia predates cofhe-contracts v0.1.0
// (uses uint256 for euint64 selectors). All functions below are plaintext
// and unaffected by that mismatch.
export const pusdcAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    // Returns the encrypted euint64 balance handle (a 32-byte ctHash packed
    // into uint256 because the deployed contract predates cofhe-contracts
    // v0.1.0). Pass the return value to `cofheClient.decryptForView(hash,
    // FheTypes.Uint64)` to reveal the plaintext — gated by the caller's
    // self-permit; only the balance holder can decrypt.
    name: 'confidentialBalanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
    // Cleartext USDC → encrypted PUSDC. Caller must have ERC-20 approved
    // the PUSDC contract for `amount` first (PUSDC pulls via
    // safeTransferFrom internally).
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

