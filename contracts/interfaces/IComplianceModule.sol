// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IComplianceModule
/// @notice ERC-3643-shaped pluggable compliance module interface. Each module
///         enforces one rule (country allow/restrict, max holders, lockup,
///         max balance, ...). Modules are bound to a token via
///         `IModularCompliance` and queried on every transfer/mint/burn.
///
/// @dev Wave 3.5 keeps the classical ERC-3643 **cleartext** signature for
///      `canTransfer` so modules can ship without touching the FHE stack.
///      For amount-based rules that need to work against `euint128` balances
///      (e.g. `MaxBalance`), the Wave 3.5 implementation uses a cleartext
///      upper-bound tracker fed from `maxSharesHint` per ADR-019. A fully
///      FHE-native interface variant lands when that tradeoff becomes
///      load-bearing (deferred as X-D15 in `DEFERRED_FEATURES.md`).
interface IComplianceModule {
    /// @notice Return true if the transfer of `amount` tokens from `from`
    ///         to `to` on `token` is allowed under this module's rule.
    /// @dev `from == address(0)` denotes a mint; `to == address(0)` denotes
    ///      a burn. Modules must treat both cases explicitly.
    function canTransfer(
        address token,
        address from,
        address to,
        uint256 amount
    ) external view returns (bool);

    /// @notice Hook fired on every state-changing transfer so stateful
    ///         modules (balance tracker, holder counter, lockup timers) can
    ///         update. Called by `IModularCompliance.transferred`.
    function transferred(
        address token,
        address from,
        address to,
        uint256 amount
    ) external;

    /// @notice Hook fired on every mint so holder counters can update.
    function created(address token, address to, uint256 amount) external;

    /// @notice Hook fired on every burn so holder counters can update.
    function destroyed(address token, address from, uint256 amount) external;

    /// @notice Machine-readable module identifier (e.g. keccak256("MaxHolders")).
    function name() external view returns (bytes32);
}
