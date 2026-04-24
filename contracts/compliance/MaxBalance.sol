// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComplianceModuleBase} from "./ComplianceModuleBase.sol";

/// @title MaxBalance
/// @notice Per-wallet-per-token balance ceiling, enforced against a
///         cleartext tracker fed by `maxSharesHint` per ADR-019.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev ADR-019 scope: Wave 3.5 ships the **cleartext upper-bound** variant
///      only. A fully FHE-native `MaxBalance` (ebool return, FHE.select
///      mirroring at caller) is deferred as `X-D15` in
///      `DEFERRED_FEATURES.md`.
///
///      Known loose behaviour (ADR-019):
///        The tracker uses `maxSharesHint` as the size of the purchase /
///        transfer-in. When an FHE silent-fail zeroes a purchase (over-hint,
///        insufficient PUSDC, etc.), the tracker still increments by the
///        hint — so the upper bound is **strictly safe** (never lets a real
///        over-cap mint through) but **may false-positive** a future
///        over-cap rejection when the investor's real balance would still
///        fit. Acceptable for Wave 3.5 dev-mode demo; tightened when the
///        module flips to a load-bearing rule in production.
///
///      Defaults to `type(uint256).max` (permissive) when uninitialised.
///
///      `from == address(0)` denotes mint (purchase); `to == address(0)`
///      denotes burn. Burns decrement the recipient-tracker on the burn
///      side (i.e. the `from` wallet's tracker), freeing headroom for a
///      subsequent purchase.
contract MaxBalance is ComplianceModuleBase {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Per-token maximum hint-sum per wallet.
    mapping(address token => uint256) public maxBalance;

    /// @notice Per-(token, wallet) cleartext tracker. Increments on mint /
    ///         transfer-in by `amount`; decrements on burn by `amount`.
    mapping(address token => mapping(address wallet => uint256 tracker)) public trackerOf;

    uint256[48] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event MaxBalanceUpdated(address indexed token, uint256 newMax);
    event TrackerAdjusted(address indexed token, address indexed wallet, uint256 newTracker);

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner, address _compliance) external initializer {
        __ComplianceModuleBase_init(_owner, _compliance);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function setMaxBalance(address token, uint256 newMax) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        maxBalance[token] = newMax;
        emit MaxBalanceUpdated(token, newMax);
    }

    /// @notice Owner can reconcile per-wallet trackers (Wave 3.5 → Wave-4
    ///         when real-balance variant lands, or to patch over a
    ///         silent-fail over-count).
    function setTracker(address token, address wallet, uint256 newTracker) external onlyOwner {
        if (token == address(0) || wallet == address(0)) revert ZeroAddress();
        trackerOf[token][wallet] = newTracker;
        emit TrackerAdjusted(token, wallet, newTracker);
    }

    // ── IComplianceModule ────────────────────────────────────────────────

    /// @dev Pre-check: would admitting `amount` push `to`'s tracker past
    ///      the cap? Skipped for burn side. Uninitialised cap = permissive.
    function canTransfer(
        address token,
        address /* from */,
        address to,
        uint256 amount
    ) external view returns (bool) {
        if (to == address(0)) return true; // burn — never increases balance
        uint256 cap = maxBalance[token];
        if (cap == 0) return true; // uninitialised = permissive
        return trackerOf[token][to] + amount <= cap;
    }

    function transferred(address token, address from, address to, uint256 amount)
        external
        onlyCompliance
    {
        if (from != address(0) && trackerOf[token][from] >= amount) {
            trackerOf[token][from] -= amount;
            emit TrackerAdjusted(token, from, trackerOf[token][from]);
        }
        if (to != address(0)) {
            trackerOf[token][to] += amount;
            emit TrackerAdjusted(token, to, trackerOf[token][to]);
        }
    }

    function created(address token, address to, uint256 amount) external onlyCompliance {
        if (to == address(0)) return;
        trackerOf[token][to] += amount;
        emit TrackerAdjusted(token, to, trackerOf[token][to]);
    }

    function destroyed(address token, address from, uint256 amount) external onlyCompliance {
        if (from == address(0)) return;
        uint256 current = trackerOf[token][from];
        uint256 newTracker = amount >= current ? 0 : current - amount;
        trackerOf[token][from] = newTracker;
        emit TrackerAdjusted(token, from, newTracker);
    }

    function name() external pure returns (bytes32) {
        return keccak256("MaxBalance");
    }
}
