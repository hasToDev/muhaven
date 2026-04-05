// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IKYCGate {
    function isEligible(address account) external view returns (bool);
    function isEligibleForTier(address account, uint256 tier) external view returns (bool);
    function providerName() external view returns (string memory);
}
