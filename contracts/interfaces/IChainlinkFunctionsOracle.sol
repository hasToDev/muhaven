// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceOracle} from "./IPriceOracle.sol";
import {IFunctionsClient} from "./IFunctionsClient.sol";

/// @title IChainlinkFunctionsOracle
/// @notice Chainlink-Functions-backed NAV oracle. Same `IPriceOracle` read
///         shape as `IssuerControlledOracle`; the difference is the write
///         path — NAV values arrive via DON fulfillment callbacks rather
///         than a hot "NAV writer" key.
///
/// @dev Wave 3.5 target sources (ADR-014 + ADR-015):
///        - TBILL1 NAV derived from FRED series `DGS3MO` (3-month T-bill)
///        - GOLD1 NAV from FRED series `GOLDPMGBD228NLBM` (London PM gold fix),
///          with metals-api.com free tier as a documented fallback.
///
///      Per-token config (`setTokenConfig`) stores:
///        - subscription ID (pre-funded with testnet LINK)
///        - callback gas limit
///        - DON ID (chain-specific)
///        - CBOR-encoded request body built off-chain (source + args)
///
///      The oracle re-uses `IssuerControlledOracle`'s deviation gate and
///      sequencer-uptime check verbatim — fulfillment lands in `_submitNAV`,
///      where the same staleness / deviation rules apply (ADR-014).
interface IChainlinkFunctionsOracle is IPriceOracle, IFunctionsClient {
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
    event MaxStalenessUpdated(address indexed token, uint256 newMaxStaleness);
    event MaxDeviationBpsUpdated(address indexed token, uint256 newMaxDeviationBps);
    event SequencerUptimeFeedUpdated(address indexed newFeed);
    event SequencerGracePeriodUpdated(uint256 newGracePeriod);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event RouterUpdated(address indexed newRouter);
    event TokenConfigured(
        address indexed token,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        bytes32 donId
    );
    event NavRequesterRotated(
        address indexed token,
        address indexed oldRequester,
        address indexed newRequester
    );
    event NAVRequested(address indexed token, bytes32 indexed requestId);
    event NAVFulfilled(address indexed token, bytes32 indexed requestId, uint256 nav);
    event NAVRequestFailed(
        address indexed token,
        bytes32 indexed requestId,
        bytes reason
    );

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyRouter();
    error OnlyOwnerOrNavRequester();
    error ZeroAddress();
    error NoPendingNAV();
    error DeviationBpsTooHigh();
    error GracePeriodTooLong();
    error TokenNotConfigured();
    error InvalidConfig();
    error UnknownRequestId();

    // ── Writes: owner / governance ────────────────────────────────────────

    /// @notice Configure (or rotate) the Chainlink Functions request profile
    ///         for a token.
    function setTokenConfig(
        address token,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        bytes32 donId,
        bytes calldata requestCBOR
    ) external;

    /// @notice Rotate the Functions router address. Zero address is rejected.
    function setRouter(address newRouter) external;

    /// @notice Rotate the per-token NAV requester — the hot key permitted to
    ///         trigger `requestNAV(token)` alongside the owner. Mirrors
    ///         `IssuerControlledOracle.setNavWriter`: owner-only; zero address
    ///         is rejected.
    function setNavRequester(address token, address newRequester) external;

    function setMaxStaleness(address token, uint256 newMaxStaleness) external;

    function setMaxDeviationBps(address token, uint256 newMaxDeviationBps) external;

    function acceptPendingNAV(address token) external;

    function rejectPendingNAV(address token) external;

    function setSequencerUptimeFeed(address newFeed) external;

    function setSequencerGracePeriod(uint256 newGracePeriod) external;

    // ── Writes: owner-triggered request ───────────────────────────────────

    /// @notice Trigger a fresh NAV update via Chainlink Functions. The
    ///         fulfillment lands back on `handleOracleFulfillment` after the
    ///         DON computes the response.
    /// @param token  Token whose NAV to refresh. Must have a configured
    ///               request profile (`setTokenConfig`).
    /// @return requestId  Functions request ID returned by the router.
    function requestNAV(address token) external returns (bytes32 requestId);

    // ── Views ─────────────────────────────────────────────────────────────

    function getPendingNAV(address token)
        external
        view
        returns (uint256 pendingNAV, uint256 pendingUpdatedAt);

    function getMaxDeviationBps(address token) external view returns (uint256);

    function getTokenConfig(address token)
        external
        view
        returns (
            uint64 subscriptionId,
            uint32 callbackGasLimit,
            bytes32 donId,
            bytes memory requestCBOR
        );

    /// @notice Per-token NAV requester (hot key). `address(0)` means only the
    ///         owner may trigger `requestNAV(token)`.
    function getNavRequester(address token) external view returns (address);

    function isSequencerUp() external view returns (bool);

    /// @notice Return the token that was requested under `requestId`, or
    ///         `address(0)` if the ID is unknown or already fulfilled.
    function getPendingRequestToken(bytes32 requestId) external view returns (address);
}
