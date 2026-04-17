// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IYieldDistributor {
    function startDistribution(InEuint64 memory encryptedTotalYield) external returns (uint256 distributionId);
    function startDistributionFromBalance() external returns (uint256 distributionId);
    function setEscrowIds(uint256 distributionId, uint256[] calldata escrowIds) external;
    function processBatch(uint256 distributionId, uint256 batchSize) external;
    function isDistributionComplete(uint256 distributionId) external view returns (bool);
    function getDistribution(uint256 distributionId) external view returns (
        address token,
        euint64 encTotalYield,
        euint64 encPerInvestorYield,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    );
    function getEscrowIds(uint256 distributionId) external view returns (uint256[] memory);
    function encryptedTotalYieldDistributed() external view returns (euint64);
}
