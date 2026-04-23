// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IRedemptionQueue
/// @notice Per-token overflow redemption queue per ADR-004. When
///         `MuHavenSubscription.redeem` would exceed the per-epoch instant
///         cap, it silent-fails and emits `EscalatedToQueue` — the caller
///         then resubmits via `submit` on this contract.
///
/// @dev Two-phase settlement:
///      1. `submit(token, encShares, ephemeralEOA)` locks shares in the
///         queue (captures `ephemeralEOA` in the request struct for later).
///      2. Issuer calls `processEpoch(epochId, start, end)` in paginated
///         batches, computing `encProceeds = FHE.mul(encShares, navNow)`
///         from a single oracle read at processing time (NAV can drift
///         between submit and settle).
///      3. Investor calls `claim(requestId)` to pull PUSDC from the bound
///         `MuHavenTreasury`. Silent-fails on treasury insolvency.
///
///      Per ADR-021, `ephemeralEOA` is captured at `submit` time (stored in
///      the request struct) and used at `processEpoch` to grant decrypt
///      access on `encProceeds`.
interface IRedemptionQueue {
    // ── Types ─────────────────────────────────────────────────────────────

    struct Request {
        address  investor;
        euint128 encShares;
        euint128 encProceeds;    // populated at `processEpoch` settlement time
        uint256  epochId;
        address  ephemeralEOA;   // captured at `submit`, used at settlement (ADR-021)
        bool     settled;
        bool     claimed;
        bool     cancelled;
    }

    // ── Events ────────────────────────────────────────────────────────────

    event QueueSubmitted(address indexed investor, uint256 indexed requestId, uint256 indexed epochId);
    event EpochProcessed(uint256 indexed epochId, uint256 requestCount);
    event QueueClaimed(address indexed investor, uint256 indexed requestId);
    event QueueCancelled(address indexed investor, uint256 indexed requestId);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyIssuer();
    error OnlyInvestor();
    error NotSettled();
    error AlreadyClaimed();
    error AlreadyCancelled();
    error WrongInvestor();
    error EpochNotReady();
    error InvalidRange();
    error InvalidEphemeralEOA();
    error ZeroAddress();

    // ── Investor hot path ────────────────────────────────────────────────

    /// @notice Submit encrypted shares to the queue for settlement in the
    ///         current epoch. Shares are locked via the bound
    ///         `MuHavenToken.transferFrom(msg.sender, address(this), encShares)`.
    /// @param encShares     Client-encrypted shares to redeem.
    /// @param ephemeralEOA  Session ephemeral EOA; captured for decrypt ACL
    ///                      grant at `processEpoch` settlement time.
    /// @return requestId    The request's sequential id.
    function submit(
        InEuint128 calldata encShares,
        address ephemeralEOA
    ) external returns (uint256 requestId);

    /// @notice Claim the settled PUSDC payout for a processed request.
    ///         Silent-fails if the treasury is insolvent at claim time.
    function claim(uint256 requestId) external;

    // ── Issuer cold path ─────────────────────────────────────────────────

    /// @notice Process a paginated slice of requests in an epoch: read NAV
    ///         once, compute `encProceeds` per request, grant decrypt ACL to
    ///         each request's captured `ephemeralEOA`, and mark settled.
    function processEpoch(
        uint256 epochId,
        uint256 startIdx,
        uint256 endIdx
    ) external;

    /// @notice Cancel a request mid-queue (e.g. on KYC revocation). Returns
    ///         locked shares to the investor. Silent-fails if the request is
    ///         already settled or claimed.
    function cancelOnKYCRevocation(uint256 requestId) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice RWA token this queue settles.
    function token() external view returns (address);

    /// @notice Treasury that pays out settled claims.
    function treasury() external view returns (address);

    /// @notice Issuer that processes epochs.
    function issuer() external view returns (address);

    function currentEpoch() external view returns (uint256);
    function nextRequestId() external view returns (uint256);

    /// @notice Full request snapshot.
    function getRequest(uint256 requestId) external view returns (Request memory);

    /// @notice Request ids belonging to a given epoch.
    function getEpochRequests(uint256 epochId) external view returns (uint256[] memory);
}
