// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComplianceModuleBase} from "./ComplianceModuleBase.sol";

/// @title Lockup
/// @notice Per-wallet-per-token transfer-out lockup. A holder cannot transfer
///         or redeem shares of a locked-up token until `unlockTime` has
///         passed. Mints (`from == address(0)`) are never blocked — lockup
///         starts *after* shares arrive.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Use case: Reg D / Reg S primary-sale holding periods, lockup
///      agreements for cornerstone investors. Default `unlockTime == 0`
///      means "no lockup".
///
///      On `created` (mint) the module sets `unlockTime` to
///      `block.timestamp + defaultLockupPeriod[token]` for the recipient.
///      Subsequent mints extend the existing lock only if the new unlock
///      time is later than the current one (no shortening).
contract Lockup is ComplianceModuleBase {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Per-token default lockup period applied on mint (seconds).
    mapping(address token => uint256 seconds_) public defaultLockupPeriod;

    /// @notice Per-(token, wallet) unlock timestamp. Blocking predicate:
    ///         `block.timestamp < unlockTime`.
    mapping(address token => mapping(address wallet => uint256 unlockTime)) public unlockTimeOf;

    uint256[48] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event DefaultLockupPeriodUpdated(address indexed token, uint256 secondsValue);
    event UnlockTimeUpdated(address indexed token, address indexed wallet, uint256 unlockTime);

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner, address _compliance) external initializer {
        __ComplianceModuleBase_init(_owner, _compliance);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function setDefaultLockupPeriod(address token, uint256 secondsValue) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        defaultLockupPeriod[token] = secondsValue;
        emit DefaultLockupPeriodUpdated(token, secondsValue);
    }

    /// @notice Owner can set an explicit per-wallet unlock time. Used to
    ///         backfill Wave 3 → Wave 3.5 migration when returning investors
    ///         should not be relocked.
    function setUnlockTime(address token, address wallet, uint256 unlockTime) external onlyOwner {
        if (token == address(0) || wallet == address(0)) revert ZeroAddress();
        unlockTimeOf[token][wallet] = unlockTime;
        emit UnlockTimeUpdated(token, wallet, unlockTime);
    }

    // ── IComplianceModule ────────────────────────────────────────────────

    function canTransfer(
        address token,
        address from,
        address /* to */,
        uint256 /* amount */
    ) external view returns (bool) {
        // Mints are never blocked; lockup applies only to transfers-out.
        if (from == address(0)) return true;
        return block.timestamp >= unlockTimeOf[token][from];
    }

    function transferred(address token, address /* from */, address to, uint256 /* amount */)
        external
        onlyCompliance
    {
        // Transfer-in also starts a lockup on the recipient side — otherwise
        // someone could sidestep lockup by receiving shares P2P and
        // immediately redeeming them.
        _maybeExtendLockup(token, to);
    }

    function created(address token, address to, uint256 /* amount */) external onlyCompliance {
        _maybeExtendLockup(token, to);
    }

    function destroyed(address, address, uint256) external onlyCompliance {}

    function name() external pure returns (bytes32) {
        return keccak256("Lockup");
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _maybeExtendLockup(address token, address wallet) internal {
        if (wallet == address(0)) return;
        uint256 period = defaultLockupPeriod[token];
        if (period == 0) return; // no-op if lockup not configured

        uint256 newUnlock = block.timestamp + period;
        uint256 existing = unlockTimeOf[token][wallet];
        if (newUnlock > existing) {
            unlockTimeOf[token][wallet] = newUnlock;
            emit UnlockTimeUpdated(token, wallet, newUnlock);
        }
    }
}
