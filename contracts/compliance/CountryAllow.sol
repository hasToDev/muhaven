// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComplianceModuleBase} from "./ComplianceModuleBase.sol";
import {IMuHavenIdentityRegistry} from "../interfaces/IMuHavenIdentityRegistry.sol";

/// @title CountryAllow
/// @notice Per-token allow-list of ISO-3166 numeric country codes. Transfer /
///         mint / burn succeeds iff every participating non-zero address
///         lives in an allowed country per the bound `IdentityRegistry`.
///         Deployed behind an OZ Transparent Proxy (one module instance
///         shared across tokens; per-token config lives in `_allowed`).
///
/// @dev ADR-011 dev-mode default: when the issuer has not called
///      `setAllowed`, the module treats the token as permissive (returns
///      `true`). A token flipping into production mode must explicitly call
///      `setAllowed(country, true)` for every acceptable jurisdiction — the
///      empty-list case is permissive specifically so dev-mode demos don't
///      need country wiring.
///
///      Mint (`from == address(0)`) and burn (`to == address(0)`) skip the
///      zero-address side: only the real participant's country is checked.
contract CountryAllow is ComplianceModuleBase {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Bound `IdentityRegistry` — source of country data per account.
    IMuHavenIdentityRegistry public identityRegistry;

    /// @notice Per-token per-country allow flag. `_allowed[token][country]`.
    mapping(address token => mapping(uint16 country => bool)) public isAllowed;

    /// @notice Per-token count of allowed countries. Zero ⇒ permissive
    ///         (pre-config / dev-mode default).
    mapping(address token => uint256) public allowedCount;

    uint256[47] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event IdentityRegistryUpdated(address indexed newRegistry);
    event CountryAllowanceUpdated(address indexed token, uint16 indexed country, bool allowed);

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param _owner             Governance multisig.
    /// @param _compliance        Bound `ModularCompliance` coordinator (may
    ///                           be zero at deploy; wire later via
    ///                           `setCompliance`).
    /// @param _identityRegistry  `IdentityRegistry` pointer — country source.
    function initialize(
        address _owner,
        address _compliance,
        address _identityRegistry
    ) external initializer {
        __ComplianceModuleBase_init(_owner, _compliance);
        if (_identityRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IMuHavenIdentityRegistry(_identityRegistry);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Toggle allowance for `country` on `token`. Owner-only.
    function setAllowed(address token, uint16 country, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        bool current = isAllowed[token][country];
        if (current == allowed) return; // no-op
        isAllowed[token][country] = allowed;
        if (allowed) {
            allowedCount[token] += 1;
        } else {
            allowedCount[token] -= 1;
        }
        emit CountryAllowanceUpdated(token, country, allowed);
    }

    /// @notice Batch setter for deploy-time ergonomics.
    function setAllowedBatch(
        address token,
        uint16[] calldata countries,
        bool allowed
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < countries.length; i++) {
            uint16 country = countries[i];
            bool current = isAllowed[token][country];
            if (current == allowed) continue;
            isAllowed[token][country] = allowed;
            if (allowed) {
                allowedCount[token] += 1;
            } else {
                allowedCount[token] -= 1;
            }
            emit CountryAllowanceUpdated(token, country, allowed);
        }
    }

    /// @notice Rotate the identity registry pointer.
    function setIdentityRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IMuHavenIdentityRegistry(newRegistry);
        emit IdentityRegistryUpdated(newRegistry);
    }

    // ── IComplianceModule ────────────────────────────────────────────────

    function canTransfer(
        address token,
        address from,
        address to,
        uint256 /* amount */
    ) external view returns (bool) {
        // Pre-config / dev-mode default: no allow-list entries = permissive.
        if (allowedCount[token] == 0) return true;

        // Check real participants only (skip zero-address on mint / burn).
        IMuHavenIdentityRegistry reg = identityRegistry;
        if (from != address(0)) {
            if (!isAllowed[token][reg.countryOf(from)]) return false;
        }
        if (to != address(0)) {
            if (!isAllowed[token][reg.countryOf(to)]) return false;
        }
        return true;
    }

    function transferred(address, address, address, uint256) external onlyCompliance {}
    function created(address, address, uint256) external onlyCompliance {}
    function destroyed(address, address, uint256) external onlyCompliance {}

    function name() external pure returns (bytes32) {
        return keccak256("CountryAllow");
    }
}
