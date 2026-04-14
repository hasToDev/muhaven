/**
 * ABI definitions for blockchain event polling.
 *
 * Event signatures:
 * - MockReineiraEscrow: EscrowCreated(uint256 indexed escrowId, address indexed beneficiary, address indexed gate)
 * - ReineiraOS escrow:  EscrowRedeemed(uint256 indexed escrowId)
 * - YieldDistributor:   BatchProcessed(uint256 indexed distributionId, uint256 processedCount, uint256 investorCount)
 */

export const escrowAbi = [
  {
    type: 'event',
    name: 'EscrowCreated',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
      { name: 'beneficiary', type: 'address', indexed: true },
      { name: 'gate', type: 'address', indexed: true },
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
    name: 'BatchProcessed',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'processedCount', type: 'uint256', indexed: false },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DistributionStarted',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'investorCount', type: 'uint256', indexed: false },
    ],
  },
] as const;
