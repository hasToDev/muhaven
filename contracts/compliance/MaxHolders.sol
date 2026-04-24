// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComplianceModuleBase} from "./ComplianceModuleBase.sol";
import {IMuHavenIdentityRegistry} from "../interfaces/IMuHavenIdentityRegistry.sol";
import {IInvestorRegistry} from "../interfaces/IInvestorRegistry.sol";

/// @title MaxHolders
/// @notice Per-token holder-count ceiling, enforced against the add-only
///         `InvestorRegistry.holderCount(token)` per ADR-022.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev ADR-022 semantics: `InvestorRegistry` is add-only, so
///      `holderCount(token)` is a **conservative upper bound** on current
///      holders. This module enforces against that upper bound — strictly
///      safe (may false-negative a technically-allowed transfer, never
///      false-positive an over-cap one).
///
///      Separate accredited / non-accredited caps:
///        Two caps per token, checked based on recipient's accreditation
///        status at the time of the call. Skipped for burn (`to == address(0)`)
///        since burn cannot increase holder count.
///
///      Default caps = `type(uint256).max` (permissive). Issuers shrink the
///      cap explicitly when required (e.g. Reg D 99-holder limit).
///
///      `from` side not checked: transfer out never adds a holder, so it
///      never trips the cap.
contract MaxHolders is ComplianceModuleBase {

    // ── Storage ──────────────────────────────────────────────────────────

    IMuHavenIdentityRegistry public identityRegistry;
    IInvestorRegistry        public investorRegistry;

    /// @notice Per-token holder-count cap. Applies to non-accredited holders.
    mapping(address token => uint256) public maxNonAccredited;

    /// @notice Per-token accredited-holder cap. Applies only to accredited
    ///         holders.
    mapping(address token => uint256) public maxAccredited;

    /// @notice Per-token non-accredited holder counter (stateful — updated
    ///         on `created` / `transferred` hook events when an unseen
    ///         recipient enters).
    mapping(address token => uint256) public nonAccreditedHolders;

    /// @notice Per-token accredited holder counter.
    mapping(address token => uint256) public accreditedHolders;

    /// @notice Tracked per-(token, account) flag — whether we've already
    ///         counted `account` on `token`. Prevents double-counting when
    ///         the same investor shows up via both purchase and transfer-in.
    mapping(address token => mapping(address account => bool)) public counted;

    uint256[45] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event IdentityRegistryUpdated(address indexed newRegistry);
    event InvestorRegistryUpdated(address indexed newRegistry);
    event MaxNonAccreditedUpdated(address indexed token, uint256 newMax);
    event MaxAccreditedUpdated(address indexed token, uint256 newMax);

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address _compliance,
        address _identityRegistry,
        address _investorRegistry
    ) external initializer {
        __ComplianceModuleBase_init(_owner, _compliance);
        if (_identityRegistry == address(0) || _investorRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IMuHavenIdentityRegistry(_identityRegistry);
        investorRegistry = IInvestorRegistry(_investorRegistry);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function setMaxNonAccredited(address token, uint256 newMax) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        maxNonAccredited[token] = newMax;
        emit MaxNonAccreditedUpdated(token, newMax);
    }

    function setMaxAccredited(address token, uint256 newMax) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        maxAccredited[token] = newMax;
        emit MaxAccreditedUpdated(token, newMax);
    }

    function setIdentityRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IMuHavenIdentityRegistry(newRegistry);
        emit IdentityRegistryUpdated(newRegistry);
    }

    function setInvestorRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        investorRegistry = IInvestorRegistry(newRegistry);
        emit InvestorRegistryUpdated(newRegistry);
    }

    // ── IComplianceModule ────────────────────────────────────────────────

    /// @dev Pre-check: would admitting `to` push the relevant counter past
    ///      the cap? Skipped if `to` is already counted or if the cap is
    ///      set to `type(uint256).max` (permissive default).
    function canTransfer(
        address token,
        address /* from */,
        address to,
        uint256 /* amount */
    ) external view returns (bool) {
        if (to == address(0)) return true; // burn — cannot add a holder
        if (counted[token][to]) return true; // already within the count

        if (identityRegistry.isAccredited(to)) {
            uint256 cap = maxAccredited[token];
            if (cap == 0) return true; // uninitialised = permissive
            return accreditedHolders[token] + 1 <= cap;
        } else {
            uint256 cap = maxNonAccredited[token];
            if (cap == 0) return true; // uninitialised = permissive
            return nonAccreditedHolders[token] + 1 <= cap;
        }
    }

    function transferred(address token, address /* from */, address to, uint256 /* amount */)
        external
        onlyCompliance
    {
        _maybeCount(token, to);
    }

    function created(address token, address to, uint256 /* amount */) external onlyCompliance {
        _maybeCount(token, to);
    }

    function destroyed(address /* token */, address /* from */, uint256 /* amount */)
        external
        onlyCompliance
    {
        // No-op. Per ADR-022 the registry is add-only; zero-balance wallets
        // stay counted. Balance-aware decrement would require async-decrypt
        // on the hot path, which is the specific footgun ADR-022 avoids.
    }

    function name() external pure returns (bytes32) {
        return keccak256("MaxHolders");
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _maybeCount(address token, address account) internal {
        if (account == address(0)) return;
        if (counted[token][account]) return;
        counted[token][account] = true;
        if (identityRegistry.isAccredited(account)) {
            accreditedHolders[token] += 1;
        } else {
            nonAccreditedHolders[token] += 1;
        }
    }
}
