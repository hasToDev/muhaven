// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IMuHavenSubscription
/// @notice Atomic buy/sell coordinator for Wave 3.5. Investors call
///         `purchase` to exchange PUSDC for fhERC-20 shares and `redeem` to
///         exchange shares for PUSDC. Both run in a single tx: NAV read →
///         `FHE.mul` → confidential PUSDC pull/pay → mint/burn, all
///         succeeding or silent-failing together.
///
/// @dev ADR-001 (atomic model) + ADR-021 (ephemeralEOA as trailing param).
///
///      The `ephemeralEOA` parameter is the session-scoped in-memory EOA
///      that signs Fhenix permits for the investor (per ADR-009). Every
///      handle that the investor is expected to decrypt is
///      `FHE.allow(handle, ephemeralEOA)`-granted at mutation time — calling
///      with `ephemeralEOA == address(0)` reverts with `InvalidEphemeralEOA()`
///      to surface a careless frontend call loudly rather than silently
///      breaking decrypt.
///
///      `maxSharesHint` is a **cleartext** upper bound the investor commits
///      to up-front. The encrypted amount is silent-failed to 0 via
///      `FHE.select(encShares <= hint, encShares, 0)`. The hint feeds the
///      cleartext per-epoch instant-redeem cap tracker (ADR-004) and the
///      `MaxBalance` compliance module (ADR-019).
interface IMuHavenSubscription {
    // ── Events ────────────────────────────────────────────────────────────

    event Purchased(address indexed token, address indexed investor, uint128 maxSharesHint);
    event Redeemed(address indexed token, address indexed investor, uint128 maxSharesHint, bool escalated);
    event EscalatedToQueue(address indexed token, address indexed investor, uint256 indexed requestId);

    event TokenRegistryUpdated(address indexed newRegistry);
    event IdentityRegistryUpdated(address indexed newRegistry);
    event ModularComplianceUpdated(address indexed newCompliance);
    event PUSDCUpdated(address indexed newPusdc);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error TokenNotRegistered();
    error TokenPaused();
    error NotEligible();
    error ComplianceBlocked();
    error StaleNAV();
    error OracleReturnedZero();
    error InvalidMaxSharesHint();
    error InvalidEphemeralEOA();

    // ── Investor hot path ────────────────────────────────────────────────

    /// @notice Atomically: pull PUSDC from `msg.sender`, mint shares to
    ///         `msg.sender` at the current oracle NAV.
    /// @param token           RWA token address (must be active in the registry).
    /// @param encShares       Client-encrypted share amount.
    /// @param maxSharesHint   Cleartext upper bound on `encShares`. Over-hint
    ///                        silent-fails via `FHE.select`.
    /// @param ephemeralEOA    Session ephemeral EOA that will decrypt the
    ///                        resulting balance handle (ADR-009 / ADR-021).
    function purchase(
        address token,
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external;

    /// @notice Atomically: burn shares from `msg.sender`, pay PUSDC to
    ///         `msg.sender` at the current oracle NAV. Silent-fails and
    ///         emits `EscalatedToQueue` when the per-epoch instant-redeem
    ///         cap (ADR-004) would be exceeded — caller should resubmit via
    ///         `RedemptionQueue.submit` in that case.
    function redeem(
        address token,
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Remaining instant-redeem capacity for `token` in the current
    ///         epoch, in PUSDC base units.
    function getInstantCapRemaining(address token) external view returns (uint256);

    /// @notice Current instant-redeem epoch index for `token`.
    function getCurrentEpoch(address token) external view returns (uint256);
}
