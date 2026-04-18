/**
 * ABI definitions for blockchain event polling.
 *
 * MuHavenEscrow events (Phase 19B onwards — replaces the older MockReineiraEscrow
 * signatures that included an indexed `beneficiary`). Beneficiary is stored as
 * an encrypted `eaddress` on-chain — events only carry `escrowId` + `resolver`.
 * The poller reconstructs escrowId → investor by reading the registry +
 * `yieldDistributor.getEscrowIds(distributionId)` after `EscrowIdsAttached`.
 *
 * - MuHavenEscrow: EscrowCreated(uint256 indexed escrowId, address indexed resolver)
 * - MuHavenEscrow: EscrowFunded(uint256 indexed escrowId)
 * - MuHavenEscrow: EscrowRedeemed(uint256 indexed escrowId)
 * - YieldDistributor: DistributionStarted(uint256 indexed distributionId, address indexed token, uint256 investorCount)
 * - YieldDistributor: EscrowIdsAttached(uint256 indexed distributionId, uint256 count)
 * - YieldDistributor: BatchProcessed(uint256 indexed distributionId, uint256 processedCount, uint256 investorCount)
 */

export const escrowAbi = [
  {
    type: 'event',
    name: 'EscrowCreated',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
      { name: 'resolver', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'EscrowFunded',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'EscrowRedeemed',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
    ],
  },
] as const;

export const yieldDistributorAbi = [
  {
    type: 'event',
    name: 'DistributionStarted',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EscrowIdsAttached',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'count', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BatchProcessed',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'processedCount', type: 'uint256', indexed: false },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Minimal read-only ABIs the poller uses to resolve escrowId → investor after
 * EscrowIdsAttached lands.
 */
export const yieldDistributorReadAbi = [
  {
    type: 'function',
    name: 'getEscrowIds',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getDistribution',
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
] as const;

export const investorRegistryReadAbi = [
  {
    type: 'function',
    name: 'getInvestorsPaginated',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ type: 'address[]' }],
  },
] as const;
