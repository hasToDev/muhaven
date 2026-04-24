// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IModularCompliance} from "../interfaces/IModularCompliance.sol";
import {IMuHavenIdentityRegistry} from "../interfaces/IMuHavenIdentityRegistry.sol";
import {IComplianceModule} from "../interfaces/IComplianceModule.sol";

/// @title DenyAllCompliance
/// @notice Tiny stub implementing `IModularCompliance.canTransfer` as a blanket
///         deny. Phase 2 tests use this to force `MuHavenSubscription.purchase`
///         through the `ComplianceBlocked` revert path before the real
///         `ModularCompliance` lands in Phase 3.
/// @dev The non-view interface methods are stubbed out as no-ops/empties — the
///      subscription hot path only consults `canTransfer` in Phase 2.
contract DenyAllCompliance is IModularCompliance {
    function canTransfer(
        address /* token */,
        address /* from */,
        address /* to */,
        uint256 /* amount */
    ) external pure returns (bool) {
        return false;
    }

    function transferred(address, address, address, uint256) external {}
    function created(address, address, uint256) external {}
    function destroyed(address, address, uint256) external {}

    function bindModule(address, address) external {}
    function unbindModule(address, address) external {}

    function getBoundModules(address) external pure returns (address[] memory) {
        return new address[](0);
    }

    function moduleCount(address) external pure returns (uint256) {
        return 0;
    }

    function isModuleBound(address, address) external pure returns (bool) {
        return false;
    }
}

/// @title AllowAllIdentityRegistry
/// @notice Tiny stub implementing `IMuHavenIdentityRegistry.isVerified` as a
///         blanket allow — the dev-mode default per ADR-011 / ADR-023.
///         Phase 2 tests use this to prove that wiring an identity registry
///         supersedes the Wave 3 `kycGate` whitelist.
contract AllowAllIdentityRegistry is IMuHavenIdentityRegistry {
    function isVerified(address /* account */) external pure returns (bool) {
        return true;
    }

    function devMode() external pure returns (bool) {
        return true;
    }

    function devModeDisabled() external pure returns (bool) {
        return false;
    }

    function setDevMode(bool) external {}
    function disableDevModeForever() external {}

    function addWhitelisted(address[] calldata) external {}
    function removeWhitelisted(address) external {}

    function claimTopicsRegistry() external pure returns (address) {
        return address(0);
    }

    function trustedIssuersRegistry() external pure returns (address) {
        return address(0);
    }

    function setClaimTopicsRegistry(address) external {}
    function setTrustedIssuersRegistry(address) external {}

    function countryOf(address) external pure returns (uint16) { return 0; }
    function isAccredited(address) external pure returns (bool) { return false; }
}

/// @title BurnOnlyDenyCompliance
/// @notice Allows mint (`from == address(0)`) and transfer
///         (`from != 0 && to != 0`); denies burn (`to == address(0)`).
///         Used by Phase 2 redeem tests to lock in that
///         `MuHavenSubscription.redeem` calls `canTransfer` with the burn
///         convention (`to == address(0)`) — purchase keeps working under
///         this stub while redeem revertsinside `_requireCompliance`.
contract BurnOnlyDenyCompliance is IModularCompliance {
    function canTransfer(
        address /* token */,
        address /* from */,
        address to,
        uint256 /* amount */
    ) external pure returns (bool) {
        return to != address(0);
    }

    function transferred(address, address, address, uint256) external {}
    function created(address, address, uint256) external {}
    function destroyed(address, address, uint256) external {}

    function bindModule(address, address) external {}
    function unbindModule(address, address) external {}

    function getBoundModules(address) external pure returns (address[] memory) {
        return new address[](0);
    }

    function moduleCount(address) external pure returns (uint256) {
        return 0;
    }

    function isModuleBound(address, address) external pure returns (bool) {
        return false;
    }
}

/// @title DenyAllIdentityRegistry
/// @notice Companion stub that always returns `false` from `isVerified`.
///         Phase 2 tests use this to prove `MuHavenSubscription.purchase`
///         consults the wired `identityRegistry` instead of `kycGate` —
///         an investor that passes kycGate still gets blocked by the
///         identity-registry-driven `NotEligible` revert.
/// @title AllowStubModule
/// @notice Minimal `IComplianceModule` stub for Phase 3 ModularCompliance
///         coordinator tests. `canTransfer` always returns true; state
///         hooks record the last call so fan-out tests can assert routing.
contract AllowStubModule is IComplianceModule {
    uint8  public lastKind; // 1=created, 2=transferred, 3=destroyed
    address public lastTo;
    address public lastFrom;
    uint256 public lastAmount;

    function canTransfer(address, address, address, uint256) external pure returns (bool) {
        return true;
    }

    function transferred(address, address from, address to, uint256 amount) external {
        lastKind = 2; lastFrom = from; lastTo = to; lastAmount = amount;
    }

    function created(address, address to, uint256 amount) external {
        lastKind = 1; lastTo = to; lastAmount = amount;
    }

    function destroyed(address, address from, uint256 amount) external {
        lastKind = 3; lastFrom = from; lastAmount = amount;
    }

    function name() external pure returns (bytes32) {
        return keccak256("AllowStubModule");
    }
}

/// @title DenyStubModule
/// @notice Minimal `IComplianceModule` stub for Phase 3 tests. `canTransfer`
///         always returns false — pairs with `AllowStubModule` to exercise
///         short-circuit behaviour in the coordinator.
contract DenyStubModule is IComplianceModule {
    function canTransfer(address, address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transferred(address, address, address, uint256) external {}
    function created(address, address, uint256) external {}
    function destroyed(address, address, uint256) external {}

    function name() external pure returns (bytes32) {
        return keccak256("DenyStubModule");
    }
}

/// @title CountingCompliance
/// @notice Accepts every transfer and records per-hook call counts.
///         Phase 4 Queue tests use this to prove state-hook fires are
///         idempotent on `processEpoch` re-runs (no double-count).
contract CountingCompliance is IModularCompliance {
    uint256 public createdCount;
    uint256 public transferredCount;
    uint256 public destroyedCount;

    function canTransfer(address, address, address, uint256) external pure returns (bool) {
        return true;
    }

    function transferred(address, address, address, uint256) external {
        transferredCount++;
    }

    function created(address, address, uint256) external {
        createdCount++;
    }

    function destroyed(address, address, uint256) external {
        destroyedCount++;
    }

    function bindModule(address, address) external {}
    function unbindModule(address, address) external {}

    function getBoundModules(address) external pure returns (address[] memory) {
        return new address[](0);
    }

    function moduleCount(address) external pure returns (uint256) {
        return 0;
    }

    function isModuleBound(address, address) external pure returns (bool) {
        return false;
    }
}

contract DenyAllIdentityRegistry is IMuHavenIdentityRegistry {
    function isVerified(address /* account */) external pure returns (bool) {
        return false;
    }

    function devMode() external pure returns (bool) {
        return true;
    }

    function devModeDisabled() external pure returns (bool) {
        return false;
    }

    function setDevMode(bool) external {}
    function disableDevModeForever() external {}

    function addWhitelisted(address[] calldata) external {}
    function removeWhitelisted(address) external {}

    function claimTopicsRegistry() external pure returns (address) {
        return address(0);
    }

    function trustedIssuersRegistry() external pure returns (address) {
        return address(0);
    }

    function setClaimTopicsRegistry(address) external {}
    function setTrustedIssuersRegistry(address) external {}

    function countryOf(address) external pure returns (uint16) { return 0; }
    function isAccredited(address) external pure returns (bool) { return false; }
}
