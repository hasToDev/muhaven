// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IRedemptionQueue
/// @notice Per-token overflow redemption queue per ADR-004. When
///         `MuHavenSubscription.redeem` would exceed the per-epoch instant
///         cap, the Subscription silent-escalates via `submitFor`; investors
///         may also call `submit` directly for explicit queued redemptions.
///
/// @dev Two-phase settlement:
///      1. `submit(encShares, maxSharesHint, ephemeralEOA)` locks the
///         investor's shares in the queue (captures `ephemeralEOA` +
///         `maxSharesHint` in the request struct for later). The queue
///         records the **actually-pulled** share amount per ADR-036 so a
///         silent-fail transferFrom cannot detach payout from holdings.
///      2. Issuer calls `processEpoch(epochId, start, end)` in paginated
///         batches. A single oracle read per batch drives
///         `encProceeds = FHE.mul(encShares, navNow)` — NAV can drift
///         between submit and settle.
///      3. Investor calls `claim(requestId)` to pull settled PUSDC from the
///         bound `MuHavenTreasury`. Silent-fails on treasury insolvency.
///
///      Per ADR-021, `ephemeralEOA` is captured at submit time (stored in
///      the request struct) and used at `processEpoch` to grant decrypt
///      access on `encProceeds` + at `cancelOnKYCRevocation` to grant on
///      the returned balance handle.
///
///      Per ADR-035, `submit` carries a cleartext `maxSharesHint` for the
///      `CostOverflowsPUSDCWidth` guard at `processEpoch` narrowing time —
///      matching the `MuHavenSubscription.purchase` / `.redeem` guard
///      shape per ADR-031. `submitFor` is the trusted-caller variant that
///      `MuHavenSubscription.redeem` uses on cap-overflow escalation so the
///      request gets the investor's real address (not Subscription's).
interface IRedemptionQueue {
    // ── Types ─────────────────────────────────────────────────────────────

    struct Request {
        address  investor;
        euint128 encShares;         // actualPulled per ADR-036 (silent-fail bounded)
        euint128 encProceeds;       // populated at `processEpoch` settlement
        uint256  epochId;
        address  ephemeralEOA;      // captured at submit, used at settle + cancel (ADR-021)
        uint128  maxSharesHint;     // cleartext overflow-guard bound (ADR-035 / ADR-031)
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
    event SubscriptionUpdated(address indexed newSubscription);
    event IdentityRegistryUpdated(address indexed newRegistry);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyIssuer();
    error OnlyInvestor();
    error OnlySubscription();
    error NotSettled();
    error AlreadyClaimed();
    error AlreadyCancelled();
    error AlreadySettled();
    error WrongInvestor();
    error EpochNotReady();
    error InvalidRange();
    error InvalidEphemeralEOA();
    error InvalidMaxSharesHint();
    error ZeroAddress();
    error TokenNotRegistered();
    error TokenPaused();
    error NotEligible();
    error ComplianceBlocked();
    error StaleNAV();
    error OracleReturnedZero();
    error CostOverflowsPUSDCWidth();
    error InvestorStillVerified();
    error PaymentTransferFailed();
    error UnknownRequest();

    // ── Investor hot path ────────────────────────────────────────────────

    /// @notice Submit encrypted shares to the queue for settlement in the
    ///         current epoch. Shares are pulled from `msg.sender` via
    ///         `MuHavenToken.transferFrom`; the investor must have
    ///         pre-approved the queue as operator on the bound token.
    /// @param encShares       Client-encrypted shares to redeem.
    /// @param maxSharesHint   Cleartext upper bound on shares. Enforces the
    ///                        `CostOverflowsPUSDCWidth` guard at
    ///                        `processEpoch` narrowing time per ADR-035.
    /// @param ephemeralEOA    Session ephemeral EOA; captured for decrypt ACL
    ///                        grants at settlement + cancel time.
    /// @return requestId      The request's sequential id.
    function submit(
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external returns (uint256 requestId);

    /// @notice Trusted-caller variant of `submit` used by
    ///         `MuHavenSubscription.redeem` on cap-overflow escalation.
    ///         Callable only by the wired `subscription` address. Takes an
    ///         already-verified on-chain `euint128` handle (not an
    ///         `InEuint128`) because CoFHE's `verifyInput` scopes the
    ///         encrypted input to the original caller (Subscription) — the
    ///         queue would fail `verifyInput` on a fresh InEuint128. The
    ///         Subscription is responsible for having verified the input
    ///         via `FHE.asEuint128(InEuint128)` + bounding it against the
    ///         hint before passing the handle through.
    function submitFor(
        address investor,
        euint128 encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external returns (uint256 requestId);

    /// @notice Claim the settled PUSDC payout for a processed request.
    ///         Silent-fails if the treasury is insolvent at claim time.
    function claim(uint256 requestId) external;

    // ── Issuer cold path ─────────────────────────────────────────────────

    /// @notice Process a paginated slice of requests in an epoch: read NAV
    ///         once, compute `encProceeds` per request, grant decrypt ACL to
    ///         each request's captured `ephemeralEOA`, and mark settled.
    ///         `endIdx` is exclusive.
    function processEpoch(
        uint256 epochId,
        uint256 startIdx,
        uint256 endIdx
    ) external;

    /// @notice Cancel a request mid-queue on KYC revocation. Returns the
    ///         locked shares to the investor. Preconditions: request not
    ///         settled, not claimed, not cancelled, and the investor is
    ///         currently `!identityRegistry.isVerified`.
    function cancelOnKYCRevocation(uint256 requestId) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice RWA token this queue settles.
    function token() external view returns (address);

    /// @notice Treasury that pays out settled claims.
    function treasury() external view returns (address);

    /// @notice Issuer that processes epochs (sourced from TokenRegistry).
    function issuer() external view returns (address);

    /// @notice Current epoch id (time-based: `block.timestamp / epochDuration`).
    function currentEpoch() external view returns (uint256);

    /// @notice Next request id the queue will assign. Starts at 1.
    function nextRequestId() external view returns (uint256);

    /// @notice Full request snapshot.
    function getRequest(uint256 requestId) external view returns (Request memory);

    /// @notice Request ids belonging to a given epoch.
    function getEpochRequests(uint256 epochId) external view returns (uint256[] memory);
}
