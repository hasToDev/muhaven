// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IInvestorRegistry {
    function register(address investor) external;
    function isInvestor(address account) external view returns (bool);
    function getInvestors() external view returns (address[] memory);
    function getInvestorsPaginated(uint256 offset, uint256 limit) external view returns (address[] memory);
    function investorCount() external view returns (uint256);
}
