// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IComplianceModule} from "../interfaces/IComplianceModule.sol";

/// @title ComplianceModuleBase
/// @notice Shared storage + modifiers for Wave 3.5 compliance modules.
///         Concrete modules (`CountryAllow`, `CountryRestrict`, `MaxHolders`,
///         `Lockup`, `MaxBalance`) inherit this and provide the per-rule
///         logic + config surface.
///
/// @dev Rationale for the base:
///      - Every module needs an owner (config writes) and a compliance
///        coordinator pointer (authorises state-hook callbacks).
///      - Centralising the `onlyCompliance` modifier + ownership surface
///        keeps the per-module contracts focused on their rule.
///      - Storage layout is 50 slots (`owner` + `compliance` + 48 gap) so
///        each module starts its own layout at slot 50.
abstract contract ComplianceModuleBase is Initializable, IComplianceModule {

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;
    /// @notice Bound `ModularCompliance` coordinator — the only caller the
    ///         state-update hooks accept. Rotatable via `setCompliance`.
    address public compliance;

    uint256[48] private __baseGap;

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyCompliance();
    error ZeroAddress();

    // ── Events ───────────────────────────────────────────────────────────

    event ComplianceUpdated(address indexed newCompliance);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyCompliance() {
        if (msg.sender != compliance) revert OnlyCompliance();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @dev Internal initializer callable by concrete modules' own
    ///      `initialize` functions. `_compliance` may be zero at deploy time
    ///      — the coordinator can be wired later via `setCompliance`.
    function __ComplianceModuleBase_init(address _owner, address _compliance)
        internal
        onlyInitializing
    {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        if (_compliance != address(0)) {
            compliance = _compliance;
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Rotate the bound compliance coordinator. Owner-only.
    function setCompliance(address newCompliance) external onlyOwner {
        if (newCompliance == address(0)) revert ZeroAddress();
        compliance = newCompliance;
        emit ComplianceUpdated(newCompliance);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
