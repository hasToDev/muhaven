// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IYieldSnapshot
/// @notice Pull-based yield distribution per ADR-005. Replaces the Wave 3
///         push-based `YieldDistributor` + `MuHavenEscrow` pipeline.
///
/// @dev Lifecycle per epoch:
///      1. Issuer calls `openEpoch(token)` → new `epochId`.
///      2. Issuer calls `snapshotBatch(epochId, investors[])` in paginated
///         slices, capturing each investor's encrypted balance at the epoch
///         open time. Driven off `InvestorRegistry` (add-only per ADR-022).
///      3. Issuer calls `finalizeSnapshot(epochId)` to lock the snapshot and
///         read `encTotalSupply` from `MuHavenToken.encryptedTotalSupply`.
///      4. Issuer calls `fundEpoch(epochId, encTotalYield)` which pulls
///         PUSDC from the issuer (confidentialTransferFrom) and computes
///         `encRatio = FHE.div(encTotalYield, encTotalSupply)`.
///      5. Each investor calls `claimYield(epochId, ephemeralEOA)` — per-
///         investor payout is `FHE.mul(encBalance, encRatio)`. The handle is
///         `FHE.allow`-granted to `ephemeralEOA` (ADR-021).
///      6. After `claimExpiry`, issuer can `sweepExpired(epochId)` to reclaim
///         unclaimed PUSDC.
///
///      Conservation is guaranteed by the encrypted proportional math, not
///      by a runtime check. Double-claim reverts (not silent-fail) — double
///      claim is an operator/tooling bug, not a malicious side-channel.
interface IYieldSnapshot {
    // ── Types ─────────────────────────────────────────────────────────────

    struct Epoch {
        address  token;
        uint256  snapshotStartTs;
        uint256  snapshotEndTs;
        bool     finalized;
        bool     funded;
        euint128 encTotalYield;
        euint128 encTotalSupply;
        euint128 encRatio;          // = encTotalYield / encTotalSupply
        uint256  claimExpiry;
        uint256  holderCount;
    }

    // ── Events ────────────────────────────────────────────────────────────

    event EpochOpened(address indexed token, uint256 indexed epochId);
    event SnapshotBatchApplied(uint256 indexed epochId, uint256 batchSize);
    event SnapshotFinalized(address indexed token, uint256 indexed epochId, uint256 holderCount);
    event EpochFunded(address indexed token, uint256 indexed epochId);
    event YieldClaimed(address indexed token, address indexed investor, uint256 indexed epochId);
    event EpochExpired(address indexed token, uint256 indexed epochId);
    event IssuerUpdated(address indexed token, address indexed oldIssuer, address indexed newIssuer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyIssuer();
    error ZeroAddress();
    error InvalidEpoch();
    error SnapshotNotFinalized();
    error SnapshotAlreadyFinalized();
    error EpochAlreadyFunded();
    error EpochNotFunded();
    error NotYetExpired();
    error AlreadyClaimed();
    error InvalidEphemeralEOA();

    // ── Issuer cold path ─────────────────────────────────────────────────

    /// @notice Open a new yield epoch for `token`. Issuer-only.
    /// @return epochId  Newly allocated epoch id.
    function openEpoch(address token) external returns (uint256 epochId);

    /// @notice Capture encrypted balances for a batch of investors into the
    ///         epoch's snapshot. Paginated — caller walks `InvestorRegistry`.
    function snapshotBatch(uint256 epochId, address[] calldata investors) external;

    /// @notice Finalize the snapshot: read and lock `encTotalSupply` from
    ///         `MuHavenToken`. Subsequent `snapshotBatch` calls revert.
    function finalizeSnapshot(uint256 epochId) external;

    /// @notice Pull `encTotalYield` PUSDC from the issuer and compute
    ///         `encRatio`. `claimExpiry` is set to
    ///         `block.timestamp + claimExpirySeconds` (implementation-level
    ///         per-token knob, not part of this interface).
    function fundEpoch(uint256 epochId, InEuint128 calldata encTotalYield) external;

    /// @notice Reclaim unclaimed PUSDC after `claimExpiry`. Issuer-only.
    function sweepExpired(uint256 epochId) external;

    // ── Investor hot path ────────────────────────────────────────────────

    /// @notice Claim the investor's proportional yield for a funded epoch.
    ///         Idempotent: re-calls revert with `AlreadyClaimed`.
    function claimYield(uint256 epochId, address ephemeralEOA) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Full epoch snapshot.
    function getEpoch(uint256 epochId) external view returns (Epoch memory);

    /// @notice Encrypted per-investor snapshot balance for an epoch.
    function getSnapshotBalance(uint256 epochId, address investor) external view returns (euint128);

    /// @notice Whether an investor has already claimed for an epoch.
    function hasClaimed(uint256 epochId, address investor) external view returns (bool);

    /// @notice Most recent epoch id opened for a token (0 if none).
    function currentEpoch(address token) external view returns (uint256);

    /// @notice Issuer address authorised to operate on `token`'s epochs.
    function issuer(address token) external view returns (address);
}
