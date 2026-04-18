import { inEncryptedTuple } from './_shared.js'

export const yieldDistributorAbi = [
  // ── Writes ─────────────────────────────────────────────────────────
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
    name: 'setMuHavenEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newEscrow', type: 'address' }],
    outputs: [],
  },
  // ── Views ──────────────────────────────────────────────────────────
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
    name: 'getEscrowIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [{ type: 'uint256[]' }],
  },
  // ── Events ─────────────────────────────────────────────────────────
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
    inputs: [{ name: 'distributionId', type: 'uint256', indexed: true }],
    anonymous: false,
  },
  {
    name: 'MuHavenEscrowUpdated',
    type: 'event',
    inputs: [{ name: 'newEscrow', type: 'address', indexed: true }],
    anonymous: false,
  },
] as const
