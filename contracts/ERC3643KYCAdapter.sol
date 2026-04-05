// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title ERC3643KYCAdapter
/// @notice Whitelist-based KYC gate implementing IKYCGate.
///         Non-proxied — swap pattern: deploy a new adapter and call `MuHavenToken.setKYCGate()`.
///
/// @dev Swap path to production ONCHAINID:
///      1. Deploy new adapter implementing IKYCGate with full ONCHAINID logic
///      2. Call `MuHavenToken.setKYCGate(newAdapterAddress)` (onlyOwner)
///      3. All future transfers use the new adapter — zero changes to MuHavenToken
contract ERC3643KYCAdapter is IKYCGate {

    // ── Claim topic constants (ERC-3643 / ONCHAINID) ─────────────────────
    // PRODUCTION: These are the exact claim topic IDs queried via
    //             IIdentity.getClaimIdsByTopic() + IClaimIssuer.isClaimValid()
    uint256 public constant CLAIM_TOPIC_KYC        = 1;
    uint256 public constant CLAIM_TOPIC_ACCREDITED = 7;

    // ── Storage ──────────────────────────────────────────────────────────

    /// @dev Tier 1 (retail KYC) whitelist
    mapping(address => bool) private _whitelist;

    /// @dev Tier 2 (accredited investor) whitelist — requires tier 1 as well
    mapping(address => bool) private _accreditedList;

    address public admin;

    // ── Events ───────────────────────────────────────────────────────────

    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event AccreditedAdded(address indexed account);
    event AccreditedRemoved(address indexed account);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyAdmin();
    error ZeroAddress();

    // ── Modifier ─────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();
        admin = _admin;
    }

    // ── IKYCGate ─────────────────────────────────────────────────────────

    /// @notice Returns true if `account` has passed retail KYC (tier 1).
    function isEligible(address account) external view override returns (bool) {
        // HACKATHON: Simple whitelist check
        // PRODUCTION: Replace with IIdentity(account).getClaimIdsByTopic(CLAIM_TOPIC_KYC)
        //             then verify each claim via IClaimIssuer.isClaimValid()
        return _whitelist[account];
    }

    /// @notice Returns true if `account` meets the requirements for the given `tier`.
    /// @dev Tier 1 = retail KYC only. Tier 2 = KYC + accredited investor status.
    ///      Any other tier returns false.
    function isEligibleForTier(address account, uint256 tier) external view override returns (bool) {
        if (tier == 1) {
            // HACKATHON: Whitelist check for KYC claim
            // PRODUCTION: Verify CLAIM_TOPIC_KYC claim via ONCHAINID
            return _whitelist[account];
        }
        if (tier == 2) {
            // HACKATHON: Both whitelists must be set
            // PRODUCTION: Verify CLAIM_TOPIC_KYC + CLAIM_TOPIC_ACCREDITED claims via ONCHAINID
            return _whitelist[account] && _accreditedList[account];
        }
        return false;
    }

    /// @notice Human-readable name of this KYC provider.
    function providerName() external pure override returns (string memory) {
        return "ERC-3643 ONCHAINID (whitelist mock)";
    }

    // ── Admin: whitelist ─────────────────────────────────────────────────

    /// @notice Add `account` to the tier 1 (retail KYC) whitelist.
    function addToWhitelist(address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        _whitelist[account] = true;
        emit WhitelistAdded(account);
    }

    /// @notice Remove `account` from the tier 1 whitelist.
    ///         Also clears accredited status — tier 2 requires tier 1.
    function removeFromWhitelist(address account) external onlyAdmin {
        _whitelist[account] = false;
        if (_accreditedList[account]) {
            _accreditedList[account] = false;
            emit AccreditedRemoved(account);
        }
        emit WhitelistRemoved(account);
    }

    /// @notice Add multiple accounts to the tier 1 whitelist in one call.
    function batchAddToWhitelist(address[] calldata accounts) external onlyAdmin {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            _whitelist[accounts[i]] = true;
            emit WhitelistAdded(accounts[i]);
        }
    }

    // ── Admin: accredited list ────────────────────────────────────────────

    /// @notice Add `account` to the tier 2 (accredited investor) list.
    ///         Account must already be on the tier 1 whitelist.
    function addToAccreditedList(address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        _accreditedList[account] = true;
        emit AccreditedAdded(account);
    }

    /// @notice Remove `account` from the tier 2 accredited list.
    function removeFromAccreditedList(address account) external onlyAdmin {
        _accreditedList[account] = false;
        emit AccreditedRemoved(account);
    }

    // ── Admin: ownership ─────────────────────────────────────────────────

    /// @notice Transfer admin role to `newAdmin`.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ── View helpers ─────────────────────────────────────────────────────

    /// @notice Returns true if `account` is on the tier 1 whitelist.
    function isWhitelisted(address account) external view returns (bool) {
        return _whitelist[account];
    }

    /// @notice Returns true if `account` is on the tier 2 accredited list.
    function isAccredited(address account) external view returns (bool) {
        return _accreditedList[account];
    }
}
