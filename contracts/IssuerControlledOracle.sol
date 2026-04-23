// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IIssuerControlledOracle} from "./interfaces/IIssuerControlledOracle.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title IssuerControlledOracle
/// @notice MuHaven's Wave 3.5 reference NAV oracle. Issuers (or a rotatable
///         hot "NAV writer" key per token) publish cleartext NAV values in
///         PUSDC base units per share. `MuHavenSubscription` reads NAV via
///         the `IPriceOracle` interface and enforces per-token staleness
///         (see `FHE_ACL_CONVENTIONS.md` Rule 4 — cleartext gates before any
///         FHE op). Deployed behind an OZ Transparent Proxy.
///
/// @dev Hardened Wave 3.5 additions on top of the plain setter-oracle
///      (PRODUCTION_DESIGN §4):
///
///      1. **Deviation gate** (per token). A new NAV whose absolute deviation
///         from the current NAV exceeds `maxDeviationBps` is **not committed**.
///         Instead, it is parked as `pendingNAV` / `pendingUpdatedAt`. The
///         owner can `acceptPendingNAV(token)` to commit, or
///         `rejectPendingNAV(token)` to drop it. BUSINESS §9 recommends 25 bps
///         for TBILL1 and 50 bps for GOLD1 (tuned per-token at registration).
///         A hard cap of 50% (5000 bps) prevents a misconfigured deviation
///         limit from silently permitting gross-move commits.
///
///         The first NAV write for a token seeds directly — there's no
///         reference to deviate from — regardless of any configured cap.
///
///      2. **Sequencer uptime check**. On L2s that publish a Chainlink-style
///         sequencer uptime feed, `isFresh(token)` reports `false` whenever
///         the sequencer is down (`answer == 1`) or still inside the
///         `sequencerGracePeriod` window after recovery. Arb Sepolia in
///         Wave 3.5 does not expose this feed — the oracle supports both a
///         configured-feed production path and an unconfigured `address(0)`
///         path for staging / local / hardhat. Arb One mainnet deploys will
///         wire the canonical feed via `setSequencerUptimeFeed`.
///
///      Both extensions are transparent to callers that only consume
///      `(nav, updatedAt) + getMaxStaleness`; they bite only when callers
///      prefer `isFresh(token)` as a one-stop freshness predicate.
///
///      No encrypted state. All storage is cleartext — NAV for a publicly
///      regulated security is intentionally transparent (ADR-003).
contract IssuerControlledOracle is Initializable, IIssuerControlledOracle {
    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Default NAV staleness window when a per-token override is
    ///         not set. 36h accommodates weekends + holidays; tighten per
    ///         token for daily-priced assets.
    uint256 public constant DEFAULT_MAX_STALENESS = 36 hours;

    /// @notice Default sequencer grace period after an uptime feed signals
    ///         recovery — oracles stay `!isFresh` during this window so
    ///         price action that occurred during downtime is ignored.
    ///         1 hour is the Chainlink-recommended default.
    uint256 public constant DEFAULT_SEQUENCER_GRACE_PERIOD = 1 hours;

    /// @notice Hard upper bound on `maxDeviationBps` — 50% in basis points.
    ///         Prevents a misconfigured deviation limit from silently
    ///         permitting gross moves (e.g. "99%" typo) to commit.
    uint256 public constant MAX_DEVIATION_BPS_CAP = 5_000;

    /// @notice Hard upper bound on `sequencerGracePeriod`. 24h is the
    ///         maximum delay we'd accept before ignoring the sequencer
    ///         freshness gate — beyond this the operator should switch to
    ///         a backup oracle entirely.
    uint256 public constant MAX_SEQUENCER_GRACE_PERIOD = 24 hours;

    /// @notice Basis-points scale.
    uint256 public constant BPS = 10_000;

    // ── Types ────────────────────────────────────────────────────────────

    struct TokenOracleData {
        uint256 nav;
        uint256 updatedAt;
        uint256 maxStaleness;
        uint256 maxDeviationBps;
        uint256 pendingNAV;
        uint256 pendingUpdatedAt;
        address navWriter;
    }

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;

    mapping(address => TokenOracleData) private _data;

    /// @notice L2 sequencer uptime feed (Chainlink-compatible). Address(0)
    ///         is a valid "unconfigured" state — the sequencer leg of
    ///         `isFresh` short-circuits to `true` in that case. See the
    ///         contract-level natspec for Arb Sepolia vs Arb One behaviour.
    address public sequencerUptimeFeed;

    /// @notice Grace window after a sequencer recovery, in seconds. See the
    ///         contract-level natspec.
    uint256 public sequencerGracePeriod;

    /// @dev Reserved storage for future upgrades. Wave 3.5 is a fresh
    ///      deploy (ADR-007) so the layout is unconstrained today.
    uint256[46] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyNavWriter(address token) {
        if (msg.sender != _data[token].navWriter) revert OnlyNavWriter();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param _owner                 Governance multi-sig address.
    /// @param _sequencerUptimeFeed   L2 sequencer uptime feed address; pass
    ///                               `address(0)` on chains that do not
    ///                               publish one (Arb Sepolia today).
    function initialize(address _owner, address _sequencerUptimeFeed) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        sequencerUptimeFeed = _sequencerUptimeFeed;
        sequencerGracePeriod = DEFAULT_SEQUENCER_GRACE_PERIOD;
    }

    // ── NAV writer flow ──────────────────────────────────────────────────

    /// @inheritdoc IIssuerControlledOracle
    function setNAV(address token, uint256 newNAV) external onlyNavWriter(token) {
        if (newNAV == 0) revert ZeroNAV();

        TokenOracleData storage d = _data[token];

        // First-ever write seeds the oracle — there is no prior NAV to
        // deviate from, so the gate is bypassed by construction.
        if (d.nav == 0) {
            d.nav = newNAV;
            d.updatedAt = block.timestamp;
            emit NAVUpdated(token, newNAV, block.timestamp);
            return;
        }

        uint256 maxDev = d.maxDeviationBps;
        // maxDev == 0 disables the gate (e.g. for permissive dev tokens);
        // committing also clears any existing pending state so a legitimate
        // small update does not leave a stale parked value.
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

    // ── Owner / governance writes ────────────────────────────────────────

    /// @inheritdoc IIssuerControlledOracle
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

    /// @inheritdoc IIssuerControlledOracle
    function rejectPendingNAV(address token) external onlyOwner {
        TokenOracleData storage d = _data[token];
        uint256 pending = d.pendingNAV;
        if (pending == 0) revert NoPendingNAV();

        d.pendingNAV = 0;
        d.pendingUpdatedAt = 0;

        emit PendingNAVRejected(token, pending);
    }

    /// @inheritdoc IIssuerControlledOracle
    function setMaxStaleness(address token, uint256 newMaxStaleness) external onlyOwner {
        _data[token].maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(token, newMaxStaleness);
    }

    /// @inheritdoc IIssuerControlledOracle
    function setMaxDeviationBps(address token, uint256 newMaxDeviationBps) external onlyOwner {
        if (newMaxDeviationBps > MAX_DEVIATION_BPS_CAP) revert DeviationBpsTooHigh();
        _data[token].maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationBpsUpdated(token, newMaxDeviationBps);
    }

    /// @inheritdoc IIssuerControlledOracle
    function setNavWriter(address token, address newWriter) external onlyOwner {
        if (newWriter == address(0)) revert ZeroAddress();
        TokenOracleData storage d = _data[token];
        address old = d.navWriter;
        d.navWriter = newWriter;
        emit NavWriterRotated(token, old, newWriter);
    }

    /// @inheritdoc IIssuerControlledOracle
    function setSequencerUptimeFeed(address newFeed) external onlyOwner {
        sequencerUptimeFeed = newFeed;
        emit SequencerUptimeFeedUpdated(newFeed);
    }

    /// @inheritdoc IIssuerControlledOracle
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
        // Handle `block.timestamp < updatedAt` defensively — an NTP-skewed
        // chain or a NAV-writer that accidentally sends a future timestamp
        // (not possible here since we stamp with `block.timestamp`, but
        // belt-and-suspenders for pendingNAV accepts against historical ts)
        // is not considered fresh.
        if (block.timestamp < d.updatedAt) return false;
        return block.timestamp - d.updatedAt <= window;
    }

    /// @inheritdoc IIssuerControlledOracle
    function getPendingNAV(address token)
        external
        view
        returns (uint256 pendingNAV, uint256 pendingUpdatedAt)
    {
        TokenOracleData storage d = _data[token];
        return (d.pendingNAV, d.pendingUpdatedAt);
    }

    /// @inheritdoc IIssuerControlledOracle
    function getMaxDeviationBps(address token) external view returns (uint256) {
        return _data[token].maxDeviationBps;
    }

    /// @inheritdoc IIssuerControlledOracle
    function getNavWriter(address token) external view returns (address) {
        return _data[token].navWriter;
    }

    /// @inheritdoc IIssuerControlledOracle
    function isSequencerUp() external view returns (bool) {
        return _isSequencerUp();
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _commit(address token, TokenOracleData storage d, uint256 newNAV) internal {
        d.nav = newNAV;
        d.updatedAt = block.timestamp;
        // A successful direct commit supersedes any parked value. Emitting
        // `PendingNAVRejected` would be misleading (the governance did not
        // explicitly reject it — a newer in-band quote just made it moot).
        if (d.pendingNAV != 0) {
            d.pendingNAV = 0;
            d.pendingUpdatedAt = 0;
        }
        emit NAVUpdated(token, newNAV, block.timestamp);
    }

    /// @notice Absolute deviation in basis points between `current` and
    ///         `next`. Assumes `current > 0` (callers guarantee this).
    function _absDeviationBps(uint256 current, uint256 next) internal pure returns (uint256) {
        uint256 diff = current > next ? current - next : next - current;
        return (diff * BPS) / current;
    }

    function _isSequencerUp() internal view returns (bool) {
        address feed = sequencerUptimeFeed;
        if (feed == address(0)) return true;

        // A mis-configured non-contract address (e.g. EOA) must not brick
        // oracle reads. We do an explicit low-level `staticcall` so any
        // failure path — no code, non-matching return size, or explicit
        // revert — lands in the same "sequencer down, fail closed" branch.
        if (feed.code.length == 0) return false;

        (bool success, bytes memory data) = feed.staticcall(
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector)
        );
        // latestRoundData returns 5 slots (uint80, int256, uint256, uint256, uint80).
        if (!success || data.length < 5 * 32) return false;

        (, int256 answer, uint256 startedAt, , ) = abi.decode(
            data,
            (uint80, int256, uint256, uint256, uint80)
        );

        if (answer != 0) return false; // 1 == down, any non-zero → fail closed
        if (startedAt == 0) return false; // round not yet started
        if (block.timestamp < startedAt) return false; // defensive clock skew
        if (block.timestamp - startedAt < sequencerGracePeriod) return false;
        return true;
    }
}
