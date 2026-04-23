// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IChainlinkFunctionsOracle} from "./interfaces/IChainlinkFunctionsOracle.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IFunctionsRouter} from "./interfaces/IFunctionsRouter.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title ChainlinkFunctionsOracle
/// @notice Wave 3.5 NAV oracle that sources values through Chainlink Functions
///         (ADR-014). The oracle is DON-written and owner-triggered: an owner
///         (or NAV-cron) calls `requestNAV(token)`, the router routes the job
///         to the DON, the DON returns a uint256 NAV in its fulfillment
///         payload, and the contract commits or parks the new value through
///         the same deviation/staleness/sequencer gates used by
///         `IssuerControlledOracle`.
///
/// @dev Target data rails (per ADR-014 + ADR-015):
///        - TBILL1 NAV: FRED series `DGS3MO` (3-month Treasury).
///        - GOLD1  NAV: FRED series `GOLDPMGBD228NLBM` (London PM gold fix).
///        - GOLD1 fallback: metals-api.com free tier (documented in DEV_LOG).
///
///      Request bodies are pre-built off-chain as CBOR blobs (see the
///      `FunctionsRequest` SDK helpers) and stored per token via
///      `setTokenConfig`. On-chain the contract is a pass-through to the
///      router's `sendRequest` — no on-chain CBOR encoding is done here,
///      keeping the dep footprint flat (matching `AggregatorV3Interface`).
///
///      No encrypted state. NAV is cleartext — `IPriceOracle` contract.
///      Deployed behind an OZ Transparent Proxy.
///
///      Write authority:
///        - `owner`           → token config, router rotation, pending-NAV
///                              accept/reject, sequencer feed + grace setter,
///                              `navRequester` rotation. Owner may also
///                              trigger NAV requests directly.
///        - `navRequester`    → rotatable per-token hot key allowed to call
///                              `requestNAV(token)`. Mirrors
///                              `IssuerControlledOracle.navWriter` — the
///                              Phase 6 NAV cron holds this key so triggers
///                              don't require the owner multisig.
///        - `router`          → sole caller for `handleOracleFulfillment`.
///
///      Gas + fail-closed patterns mirror `IssuerControlledOracle`:
///        1. Deviation gate: over-threshold fulfillments park as pending;
///           first-ever fulfillment seeds unconditionally.
///        2. Sequencer uptime: `isFresh(token)` returns `false` whenever the
///           L2 sequencer feed is down or inside the grace window. A
///           mis-configured (EOA) feed also lands in the "down" branch via
///           explicit low-level `staticcall` (matches the hardened shape in
///           `IssuerControlledOracle`).
///        3. Fulfillment errors: DON-side err payloads, wrong-length
///           responses, and zero NAVs emit `NAVRequestFailed` and skip the
///           update — we never revert from the fulfillment callback because
///           the router cannot recover.
contract ChainlinkFunctionsOracle is Initializable, IChainlinkFunctionsOracle {
    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Default NAV staleness window when a per-token override is not
    ///         set. 36h accommodates weekends + holidays; tighten per token
    ///         for daily-priced assets (25h for TBILL1 / GOLD1 at launch).
    uint256 public constant DEFAULT_MAX_STALENESS = 36 hours;

    /// @notice Default sequencer grace period after an uptime feed signals
    ///         recovery. 1 hour is the Chainlink-recommended default.
    uint256 public constant DEFAULT_SEQUENCER_GRACE_PERIOD = 1 hours;

    /// @notice Hard upper bound on `maxDeviationBps` — 50% in basis points.
    uint256 public constant MAX_DEVIATION_BPS_CAP = 5_000;

    /// @notice Hard upper bound on `sequencerGracePeriod`.
    uint256 public constant MAX_SEQUENCER_GRACE_PERIOD = 24 hours;

    /// @notice Basis-points scale.
    uint256 public constant BPS = 10_000;

    /// @notice Chainlink Functions request schema version — v1 today.
    uint16 public constant REQUEST_DATA_VERSION = 1;

    // ── Types ────────────────────────────────────────────────────────────

    struct TokenOracleData {
        uint256 nav;
        uint256 updatedAt;
        uint256 maxStaleness;
        uint256 maxDeviationBps;
        uint256 pendingNAV;
        uint256 pendingUpdatedAt;
    }

    struct TokenFunctionsConfig {
        // Slot 0 — fully packed: 8 + 4 + 20 = 32 bytes.
        uint64 subscriptionId;
        uint32 callbackGasLimit;
        address navRequester;
        // Slot 1
        bytes32 donId;
        // Slot 2 — dynamic bytes (length + pointer)
        bytes requestCBOR;
    }

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;

    IFunctionsRouter public router;

    /// @notice L2 sequencer uptime feed — address(0) short-circuits to "up".
    ///         See `IssuerControlledOracle` for the Arb Sepolia vs Arb One
    ///         operating model.
    address public sequencerUptimeFeed;

    uint256 public sequencerGracePeriod;

    mapping(address => TokenOracleData) private _data;

    mapping(address => TokenFunctionsConfig) private _fn;

    /// @notice Outstanding requests routed back to their owning token on
    ///         fulfillment. Cleared on fulfillment or explicit cancellation.
    mapping(bytes32 => address) private _requestToken;

    /// @dev Reserved storage for future upgrades (fresh deploy per ADR-007).
    uint256[43] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != address(router)) revert OnlyRouter();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param _owner                 Governance multi-sig address.
    /// @param _router                Chainlink Functions router for the chain.
    /// @param _sequencerUptimeFeed   L2 sequencer uptime feed; pass
    ///                               `address(0)` on chains that do not
    ///                               publish one (Arb Sepolia today).
    function initialize(
        address _owner,
        address _router,
        address _sequencerUptimeFeed
    ) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        if (_router == address(0)) revert ZeroAddress();
        owner = _owner;
        router = IFunctionsRouter(_router);
        sequencerUptimeFeed = _sequencerUptimeFeed;
        sequencerGracePeriod = DEFAULT_SEQUENCER_GRACE_PERIOD;
    }

    // ── Token config ─────────────────────────────────────────────────────

    /// @inheritdoc IChainlinkFunctionsOracle
    function setTokenConfig(
        address token,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        bytes32 donId,
        bytes calldata requestCBOR
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (subscriptionId == 0) revert InvalidConfig();
        if (callbackGasLimit == 0) revert InvalidConfig();
        if (donId == bytes32(0)) revert InvalidConfig();
        if (requestCBOR.length == 0) revert InvalidConfig();

        TokenFunctionsConfig storage fn = _fn[token];
        fn.subscriptionId = subscriptionId;
        fn.callbackGasLimit = callbackGasLimit;
        fn.donId = donId;
        fn.requestCBOR = requestCBOR;
        // `navRequester` is intentionally preserved across config rotations —
        // it's a separate hot-key rotation via `setNavRequester`.

        emit TokenConfigured(token, subscriptionId, callbackGasLimit, donId);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setNavRequester(address token, address newRequester) external onlyOwner {
        if (newRequester == address(0)) revert ZeroAddress();
        TokenFunctionsConfig storage fn = _fn[token];
        address old = fn.navRequester;
        fn.navRequester = newRequester;
        emit NavRequesterRotated(token, old, newRequester);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        router = IFunctionsRouter(newRouter);
        emit RouterUpdated(newRouter);
    }

    // ── NAV request / fulfillment ────────────────────────────────────────

    /// @inheritdoc IChainlinkFunctionsOracle
    function requestNAV(address token)
        external
        returns (bytes32 requestId)
    {
        TokenFunctionsConfig storage fn = _fn[token];
        if (fn.requestCBOR.length == 0) revert TokenNotConfigured();
        if (msg.sender != owner && msg.sender != fn.navRequester) {
            revert OnlyOwnerOrNavRequester();
        }

        requestId = router.sendRequest(
            fn.subscriptionId,
            fn.requestCBOR,
            REQUEST_DATA_VERSION,
            fn.callbackGasLimit,
            fn.donId
        );
        _requestToken[requestId] = token;

        emit NAVRequested(token, requestId);
    }

    /// @notice Chainlink Functions fulfillment callback (see `IFunctionsClient`).
    /// @dev Called by the Chainlink Functions router after the DON completes
    ///      off-chain execution. MUST NOT revert on malformed payloads — the
    ///      router cannot recover — so bad fulfillments emit
    ///      `NAVRequestFailed` and return. Only a mis-routed caller
    ///      (`!= router`) or an unknown request ID trigger reverts.
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external onlyRouter {
        address token = _requestToken[requestId];
        if (token == address(0)) revert UnknownRequestId();
        delete _requestToken[requestId];

        // DON-side failure: the DON signals a scripting / HTTP error via the
        // `err` bytes. Skip the update and surface for off-chain monitoring.
        if (err.length > 0) {
            emit NAVRequestFailed(token, requestId, err);
            return;
        }

        // Strict shape: we expect `abi.encode(uint256)` exactly. Extra bytes
        // would silently decode, which hides drift in the DON script's
        // response format — fail closed instead.
        if (response.length != 32) {
            emit NAVRequestFailed(token, requestId, bytes("invalid response length"));
            return;
        }

        uint256 newNAV = abi.decode(response, (uint256));
        if (newNAV == 0) {
            emit NAVRequestFailed(token, requestId, bytes("zero nav"));
            return;
        }

        _submitNAV(token, newNAV);
        emit NAVFulfilled(token, requestId, newNAV);
    }

    // ── Owner / governance writes ────────────────────────────────────────

    /// @inheritdoc IChainlinkFunctionsOracle
    function acceptPendingNAV(address token) external onlyOwner {
        TokenOracleData storage d = _data[token];
        if (d.pendingNAV == 0) revert NoPendingNAV();

        uint256 nav = d.pendingNAV;
        uint256 ts = d.pendingUpdatedAt;
        d.nav = nav;
        d.updatedAt = ts;
        d.pendingNAV = 0;
        d.pendingUpdatedAt = 0;

        emit PendingNAVAccepted(token, nav, ts);
        emit NAVUpdated(token, nav, ts);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function rejectPendingNAV(address token) external onlyOwner {
        TokenOracleData storage d = _data[token];
        uint256 pending = d.pendingNAV;
        if (pending == 0) revert NoPendingNAV();

        d.pendingNAV = 0;
        d.pendingUpdatedAt = 0;

        emit PendingNAVRejected(token, pending);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setMaxStaleness(address token, uint256 newMaxStaleness) external onlyOwner {
        _data[token].maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(token, newMaxStaleness);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setMaxDeviationBps(address token, uint256 newMaxDeviationBps) external onlyOwner {
        if (newMaxDeviationBps > MAX_DEVIATION_BPS_CAP) revert DeviationBpsTooHigh();
        _data[token].maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationBpsUpdated(token, newMaxDeviationBps);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setSequencerUptimeFeed(address newFeed) external onlyOwner {
        sequencerUptimeFeed = newFeed;
        emit SequencerUptimeFeedUpdated(newFeed);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function setSequencerGracePeriod(uint256 newGracePeriod) external onlyOwner {
        if (newGracePeriod > MAX_SEQUENCER_GRACE_PERIOD) revert GracePeriodTooLong();
        sequencerGracePeriod = newGracePeriod;
        emit SequencerGracePeriodUpdated(newGracePeriod);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IPriceOracle
    function getNAV(address token) external view returns (uint256 nav, uint256 updatedAt) {
        TokenOracleData storage d = _data[token];
        return (d.nav, d.updatedAt);
    }

    /// @inheritdoc IPriceOracle
    function getMaxStaleness(address token) external view returns (uint256) {
        uint256 custom = _data[token].maxStaleness;
        return custom == 0 ? DEFAULT_MAX_STALENESS : custom;
    }

    /// @inheritdoc IPriceOracle
    function isFresh(address token) external view returns (bool) {
        if (!_isSequencerUp()) return false;

        TokenOracleData storage d = _data[token];
        if (d.nav == 0 || d.updatedAt == 0) return false;

        uint256 window = d.maxStaleness == 0 ? DEFAULT_MAX_STALENESS : d.maxStaleness;
        // Belt-and-suspenders for the `acceptPendingNAV` path where an old
        // `pendingUpdatedAt` can be committed post-hoc.
        if (block.timestamp < d.updatedAt) return false;
        return block.timestamp - d.updatedAt <= window;
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function getPendingNAV(address token)
        external
        view
        returns (uint256 pendingNAV, uint256 pendingUpdatedAt)
    {
        TokenOracleData storage d = _data[token];
        return (d.pendingNAV, d.pendingUpdatedAt);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function getMaxDeviationBps(address token) external view returns (uint256) {
        return _data[token].maxDeviationBps;
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function getTokenConfig(address token)
        external
        view
        returns (
            uint64 subscriptionId,
            uint32 callbackGasLimit,
            bytes32 donId,
            bytes memory requestCBOR
        )
    {
        TokenFunctionsConfig storage fn = _fn[token];
        return (fn.subscriptionId, fn.callbackGasLimit, fn.donId, fn.requestCBOR);
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function getNavRequester(address token) external view returns (address) {
        return _fn[token].navRequester;
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function isSequencerUp() external view returns (bool) {
        return _isSequencerUp();
    }

    /// @inheritdoc IChainlinkFunctionsOracle
    function getPendingRequestToken(bytes32 requestId) external view returns (address) {
        return _requestToken[requestId];
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _submitNAV(address token, uint256 newNAV) internal {
        TokenOracleData storage d = _data[token];

        // First-ever fulfillment seeds the oracle — there's no prior NAV to
        // deviate from. Matches `IssuerControlledOracle.setNAV`.
        if (d.nav == 0) {
            d.nav = newNAV;
            d.updatedAt = block.timestamp;
            emit NAVUpdated(token, newNAV, block.timestamp);
            return;
        }

        uint256 maxDev = d.maxDeviationBps;
        if (maxDev == 0) {
            _commit(token, d, newNAV);
            return;
        }

        uint256 deviationBps = _absDeviationBps(d.nav, newNAV);
        if (deviationBps > maxDev) {
            d.pendingNAV = newNAV;
            d.pendingUpdatedAt = block.timestamp;
            emit NAVPending(token, newNAV, block.timestamp, deviationBps);
        } else {
            _commit(token, d, newNAV);
        }
    }

    function _commit(address token, TokenOracleData storage d, uint256 newNAV) internal {
        d.nav = newNAV;
        d.updatedAt = block.timestamp;
        // A successful in-band commit supersedes any parked value.
        if (d.pendingNAV != 0) {
            d.pendingNAV = 0;
            d.pendingUpdatedAt = 0;
        }
        emit NAVUpdated(token, newNAV, block.timestamp);
    }

    function _absDeviationBps(uint256 current, uint256 next) internal pure returns (uint256) {
        uint256 diff = current > next ? current - next : next - current;
        return (diff * BPS) / current;
    }

    function _isSequencerUp() internal view returns (bool) {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return true;

        // Fail closed on non-contract feeds. See `IssuerControlledOracle`
        // for the rationale — an EOA feed otherwise bricks reads with an
        // auto-inserted `EXTCODESIZE` revert that escapes the try/catch
        // frame.
        if (feed.code.length == 0) return false;

        (bool success, bytes memory data) = feed.staticcall(
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector)
        );
        if (!success || data.length < 5 * 32) return false;

        (, int256 answer, uint256 startedAt, , ) = abi.decode(
            data,
            (uint80, int256, uint256, uint256, uint80)
        );

        if (answer != 0) return false;
        if (startedAt == 0) return false;
        if (block.timestamp < startedAt) return false;
        if (block.timestamp - startedAt < sequencerGracePeriod) return false;
        return true;
    }
}
