// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IInvestorRegistry {
    // ── Events ──────────────────────────────────────────────────────────
    event InvestorRegistered(address indexed investor);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Investor management ─────────────────────────────────────────────
    function register(address investor) external;
    function isInvestor(address account) external view returns (bool);
    function getInvestorsPaginated(uint256 offset, uint256 limit) external view returns (address[] memory);
    function investorCount() external view returns (uint256);

    // ── Admin ───────────────────────────────────────────────────────────
    function setAuthorizedCaller(address caller, bool authorized) external;
    function transferOwnership(address newOwner) external;
}
