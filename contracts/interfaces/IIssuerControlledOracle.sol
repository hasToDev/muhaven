// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceOracle} from "./IPriceOracle.sol";

/// @title IIssuerControlledOracle
/// @notice Reference NAV oracle interface: issuer (or a rotatable hot
///         "NAV writer" key) publishes cleartext NAV quotes per MuHaven RWA
///         token. Wave 3.5's IssuerControlledOracle implements this as the
///         MVP oracle; a `ChainlinkFunctionsOracle` with the same shape ships
///         in a later Phase 2 sub-phase (see `WAVE_3_5_REVISED.md`).
///
/// @dev Extensions beyond `IPriceOracle`:
///        - Per-token `maxDeviationBps` gate: a new NAV whose absolute
///          deviation from the current NAV exceeds the threshold does not
///          commit. Instead it is parked in `pendingNAV`, pending explicit
///          owner accept/reject. See ADR-014 + BUSINESS §9.
///        - Sequencer uptime check: on Arbitrum (and any L2 that exposes a
///          Chainlink-style uptime feed) the oracle refuses to report
///          `isFresh() == true` while the sequencer is degraded or still
///          inside the post-recovery grace window. See ADR-014.
interface IIssuerControlledOracle is IPriceOracle {
    // ── Events ────────────────────────────────────────────────────────────

    event NAVUpdated(address indexed token, uint256 nav, uint256 updatedAt);
    event NAVPending(
        address indexed token,
        uint256 pendingNAV,
        uint256 pendingUpdatedAt,
        uint256 deviationBps
    );
    event PendingNAVAccepted(address indexed token, uint256 nav, uint256 updatedAt);
    event PendingNAVRejected(address indexed token, uint256 pendingNAV);
    event NavWriterRotated(
        address indexed token,
        address indexed oldWriter,
        address indexed newWriter
    );
    event MaxStalenessUpdated(address indexed token, uint256 newMaxStaleness);
    event MaxDeviationBpsUpdated(address indexed token, uint256 newMaxDeviationBps);
    event SequencerUptimeFeedUpdated(address indexed newFeed);
    event SequencerGracePeriodUpdated(uint256 newGracePeriod);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyNavWriter();
    error ZeroNAV();
    error ZeroAddress();
    error NoPendingNAV();
    error DeviationBpsTooHigh();
    error GracePeriodTooLong();

    // ── Writes: issuer / NAV writer ───────────────────────────────────────

    /// @notice Publish a new NAV for `token`. Routes to `pendingNAV` if the
    ///         deviation against the current NAV exceeds `maxDeviationBps`.
    function setNAV(address token, uint256 newNAV) external;

    // ── Writes: owner / governance ────────────────────────────────────────

    function setMaxStaleness(address token, uint256 newMaxStaleness) external;

    function setMaxDeviationBps(address token, uint256 newMaxDeviationBps) external;

    function setNavWriter(address token, address newWriter) external;

    function acceptPendingNAV(address token) external;

    function rejectPendingNAV(address token) external;

    function setSequencerUptimeFeed(address newFeed) external;

    function setSequencerGracePeriod(uint256 newGracePeriod) external;

    // ── Views ─────────────────────────────────────────────────────────────

    function getPendingNAV(address token)
        external
        view
        returns (uint256 pendingNAV, uint256 pendingUpdatedAt);

    function getMaxDeviationBps(address token) external view returns (uint256);

    function getNavWriter(address token) external view returns (address);

    /// @notice Current sequencer uptime status. Returns `true` if no feed is
    ///         configured (local / hardhat), or if the feed reports up and the
    ///         grace window has elapsed since last status change.
    function isSequencerUp() external view returns (bool);
}
