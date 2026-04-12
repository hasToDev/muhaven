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
  {
    name: 'requestYieldDecrypt',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getYieldDecryptResult',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [
      { name: 'totalYield', type: 'uint128' },
      { name: 'totalYieldDecrypted', type: 'bool' },
      { name: 'perInvestorYield', type: 'uint128' },
      { name: 'perInvestorYieldDecrypted', type: 'bool' },
    ],
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
] as const
