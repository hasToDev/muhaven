// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, InEuint64, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IYieldDistributor {
    function startDistribution(InEuint64 memory encryptedTotalYield) external returns (uint256 distributionId);
    function processBatch(uint256 distributionId, uint256 batchSize) external;
    function isDistributionComplete(uint256 distributionId) external view returns (bool);
    function getDistribution(uint256 distributionId) external view returns (
        address token,
        euint128 encTotalYield,
        euint128 encPerInvestorYield,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    );
    function encryptedTotalYieldDistributed() external view returns (euint128);
    function requestYieldDecrypt(uint256 distributionId) external;
    function getYieldDecryptResult(uint256 distributionId) external view returns (
        uint128 totalYield,
        bool totalYieldDecrypted,
        uint128 perInvestorYield,
        bool perInvestorYieldDecrypted
    );
}
