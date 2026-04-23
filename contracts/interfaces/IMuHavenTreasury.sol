// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IMuHavenTreasury
/// @notice Per-token PUSDC float custodian per ADR-002. Holds the confidential
///         USDC that backs redemptions for one RWA token. The bound
///         `MuHavenSubscription` and `RedemptionQueue` have operator rights
///         on the treasury's PUSDC balance, granted at `initialize` and
///         immutable thereafter.
///
/// @dev The issuer deposits/withdraws PUSDC directly; an explicit `deposit`
///      function exists purely for event emission + analytics. `withdraw`
///      honours the cleartext `minFloat` solvency floor.
///
///      There is no user-decryptable state produced by deposit/withdraw —
///      only the issuer sees their own PUSDC balance handle. Per Phase 7
///      audit checklist, this contract therefore does **not** take an
///      `ephemeralEOA` parameter: the issuer's kernel signs the PUSDC
///      permits against the PUSDC contract directly.
interface IMuHavenTreasury {
    // ── Events ────────────────────────────────────────────────────────────

    event TreasuryDeposited(address indexed issuer);
    event TreasuryWithdrawn(address indexed issuer);
    event MinFloatUpdated(uint256 newMin);
    event IssuerUpdated(address indexed oldIssuer, address indexed newIssuer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyIssuer();
    error OnlyOwner();
    error BelowMinFloat();
    error ZeroAddress();
    error AlreadyInitialized();

    // ── Issuer hot path ──────────────────────────────────────────────────

    /// @notice Deposit encrypted PUSDC into the treasury. Marker function —
    ///         in practice issuer calls `PUSDC.confidentialTransfer` directly;
    ///         this form exists for uniform event emission and analytics.
    function deposit(InEuint128 calldata encAmount) external;

    /// @notice Withdraw encrypted PUSDC from the treasury, subject to the
    ///         cleartext solvency floor. Reverts with `BelowMinFloat` if the
    ///         post-withdraw float would dip below `minFloat`.
    function withdraw(InEuint128 calldata encAmount) external;

    // ── Admin ─────────────────────────────────────────────────────────────

    function setMinFloat(uint256 newMin) external;
    function setIssuer(address newIssuer) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Current PUSDC float (cleartext aggregate). Permissioned read
    ///         for regulatory / operator visibility.
    function getFloat() external view returns (uint256);

    function getMinFloat() external view returns (uint256);

    /// @notice Bound RWA token — immutable after init.
    function token() external view returns (address);

    /// @notice Bound `MuHavenSubscription` — immutable after init.
    function subscription() external view returns (address);

    /// @notice Bound `RedemptionQueue` — immutable after init.
    function queue() external view returns (address);

    /// @notice Issuer address — rotatable via `setIssuer`.
    function issuer() external view returns (address);
}
