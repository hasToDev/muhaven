// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComplianceModuleBase} from "./ComplianceModuleBase.sol";
import {IMuHavenIdentityRegistry} from "../interfaces/IMuHavenIdentityRegistry.sol";

/// @title CountryRestrict
/// @notice Per-token block-list of ISO-3166 numeric country codes. Transfer /
///         mint / burn is blocked if any participating non-zero address
///         lives in a restricted country per the bound `IdentityRegistry`.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Complement to `CountryAllow` — pick whichever semantic fits the
///      token's compliance posture. `CountryRestrict` is permissive by
///      default (no entries ⇒ nothing blocked) so dev-mode demos work
///      without country wiring.
///
///      Zero-address participant (mint `from` / burn `to`) skipped.
contract CountryRestrict is ComplianceModuleBase {

    // ── Storage ──────────────────────────────────────────────────────────

    IMuHavenIdentityRegistry public identityRegistry;

    /// @notice Per-token per-country block flag.
    mapping(address token => mapping(uint16 country => bool)) public isRestricted;

    uint256[48] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event IdentityRegistryUpdated(address indexed newRegistry);
    event CountryRestrictionUpdated(address indexed token, uint16 indexed country, bool restricted);

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

    function setRestricted(address token, uint16 country, bool restricted) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (isRestricted[token][country] == restricted) return;
        isRestricted[token][country] = restricted;
        emit CountryRestrictionUpdated(token, country, restricted);
    }

    function setRestrictedBatch(
        address token,
        uint16[] calldata countries,
        bool restricted
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < countries.length; i++) {
            uint16 country = countries[i];
            if (isRestricted[token][country] == restricted) continue;
            isRestricted[token][country] = restricted;
            emit CountryRestrictionUpdated(token, country, restricted);
        }
    }

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
        IMuHavenIdentityRegistry reg = identityRegistry;
        if (from != address(0)) {
            if (isRestricted[token][reg.countryOf(from)]) return false;
        }
        if (to != address(0)) {
            if (isRestricted[token][reg.countryOf(to)]) return false;
        }
        return true;
    }

    function transferred(address, address, address, uint256) external onlyCompliance {}
    function created(address, address, uint256) external onlyCompliance {}
    function destroyed(address, address, uint256) external onlyCompliance {}

    function name() external pure returns (bytes32) {
        return keccak256("CountryRestrict");
    }
}
