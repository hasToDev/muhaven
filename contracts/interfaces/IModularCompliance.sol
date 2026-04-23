// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IModularCompliance
/// @notice ERC-3643-shaped pluggable compliance coordinator. Each RWA token
///         points at one `IModularCompliance` instance that holds an ordered
///         list of `IComplianceModule`s. `canTransfer` iterates the list and
///         returns `true` iff every bound module approves (empty list ⇒ true).
///
/// @dev Wave 3.5 deploys the full topology in dev-mode per ADR-011:
///      - `canTransfer` is called from `MuHavenSubscription.purchase/redeem`,
///        `MuHavenToken.transfer/transferFrom`, `RedemptionQueue.submit`.
///      - With no modules bound, every call returns `true` (permissive
///        default); production flip is `bindModule` + `disableDevModeForever`
///        on the identity registry.
interface IModularCompliance {
    // ── Events ────────────────────────────────────────────────────────────

    event ModuleBound(address indexed token, address indexed module);
    event ModuleUnbound(address indexed token, address indexed module);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error ModuleAlreadyBound();
    error ModuleNotBound();
    error TooManyModules();

    // ── Transfer gate ─────────────────────────────────────────────────────

    /// @notice True iff every bound module for `token` approves the transfer.
    ///         Empty module list ⇒ `true`.
    ///         `from == address(0)` denotes mint; `to == address(0)` denotes burn.
    function canTransfer(
        address token,
        address from,
        address to,
        uint256 amount
    ) external view returns (bool);

    // ── State-update hooks (called by Token + Subscription) ──────────────

    /// @notice Notify every bound module of a successful transfer so stateful
    ///         modules (balance trackers, holder counters, lockup timers) can
    ///         update. Never reverts — treat module-side reverts as fatal
    ///         operator bugs to surface loudly.
    function transferred(
        address token,
        address from,
        address to,
        uint256 amount
    ) external;

    /// @notice Notify modules of a successful mint.
    function created(address token, address to, uint256 amount) external;

    /// @notice Notify modules of a successful burn.
    function destroyed(address token, address from, uint256 amount) external;

    // ── Admin ─────────────────────────────────────────────────────────────

    /// @notice Bind a new module to a token.
    function bindModule(address token, address module) external;

    /// @notice Unbind an existing module from a token.
    function unbindModule(address token, address module) external;

    /// @notice Ordered list of modules bound to a token.
    function getBoundModules(address token) external view returns (address[] memory);

    /// @notice Count of modules bound to a token.
    function moduleCount(address token) external view returns (uint256);

    /// @notice Whether `module` is bound to `token`.
    function isModuleBound(address token, address module) external view returns (bool);
}
