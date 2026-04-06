// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IYieldDistributor {
    function startDistribution(address token, uint256 totalYield) external returns (uint256 distributionId);
    function processBatch(uint256 distributionId, uint256 batchSize) external;
    function isDistributionComplete(uint256 distributionId) external view returns (bool);
    function getDistribution(uint256 distributionId) external view returns (
        address token,
        uint256 totalYield,
        uint256 perInvestorYield,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    );
}
