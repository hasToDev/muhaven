// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";

/// @title InvestorRegistry
/// @notice Standalone upgradeable registry tracking investor addresses.
///         Queried by MuHavenToken (on mint/transfer) and YieldDistributor (for batched distribution).
///         Deployed behind an OZ Transparent Proxy.
contract InvestorRegistry is Initializable, IInvestorRegistry {

    // ── Storage ──────────────────────────────────────────────────────────

    address[] private _investors;
    mapping(address => bool) private _registered;
    mapping(address => bool) public authorizedCallers;
    address public owner;

    /// @dev Reserved storage for future upgrades
    uint256[50] private __gap;

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyAuthorized();
    error ZeroAddress();

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Investor management ─────────────────────────────────────────────

    /// @notice Register an investor address. Skips if already registered.
    ///         Only callable by authorized contracts (e.g. MuHavenToken).
    function register(address investor) external onlyAuthorized {
        if (_registered[investor]) return;

        _registered[investor] = true;
        _investors.push(investor);

        emit InvestorRegistered(investor);
    }

    /// @notice Check if an address is a registered investor.
    function isInvestor(address account) external view returns (bool) {
        return _registered[account];
    }

    /// @notice Returns a paginated slice of the investor list.
    /// @param offset Starting index.
    /// @param limit  Maximum number of addresses to return.
    /// @return result Slice of investor addresses (may be shorter than limit).
    function getInvestorsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory result)
    {
        uint256 total = _investors.length;

        if (offset >= total) {
            return new address[](0);
        }

        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;

        result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _investors[offset + i];
        }
    }

    /// @notice Returns the total number of registered investors.
    function investorCount() external view returns (uint256) {
        return _investors.length;
    }

    // ── Admin ───────────────────────────────────────────────────────────

    /// @notice Grant or revoke authorization for a caller to register investors.
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;

        emit AuthorizedCallerUpdated(caller, authorized);
    }

    /// @notice Transfer ownership of the registry.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
