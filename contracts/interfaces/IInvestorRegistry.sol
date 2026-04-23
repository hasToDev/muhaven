// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IInvestorRegistry
/// @notice Paginated roster of platform investors + per-token holder tracking.
///
/// @dev Wave 3 shipped the global `register / isInvestor / investorCount /
///      getInvestorsPaginated` API — preserved here for back-compat during the
///      6-month Wave 3 read-only deprecation window (`MIGRATION.md`).
///
///      Wave 3.5 adds the per-token API (`addHolder`, `isHolder`,
///      `holderCount`, `getHoldersPaginated`) per ADR-022 / ADR-026:
///      `YieldSnapshot.snapshotBatch` needs per-token pagination, and
///      `MaxHolders` needs a per-token conservative upper bound. The registry
///      is **add-only**: holders are never removed, so `holderCount` is a
///      strict upper bound on current holders (zero-balance wallets stay in
///      the list by design — see ADR-022 for rationale).
///
///      `addHolder(token, investor)` additionally flips the legacy global
///      `_registered[investor]` flag so Wave 3 consumers (`isInvestor`,
///      `investorCount`) stay coherent with the per-token state.
interface IInvestorRegistry {
    // ── Events ──────────────────────────────────────────────────────────
    event InvestorRegistered(address indexed investor);
    event HolderAdded(address indexed token, address indexed investor);
    event AuthorizedCallerUpdated(address indexed caller, bool authorized);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Global investor API (Wave 3, preserved) ─────────────────────────
    function register(address investor) external;
    function isInvestor(address account) external view returns (bool);
    function getInvestorsPaginated(uint256 offset, uint256 limit) external view returns (address[] memory);
    function investorCount() external view returns (uint256);

    // ── Per-token holder API (Wave 3.5, ADR-022 / ADR-026) ──────────────

    /// @notice Record `investor` as a holder of `token`. Idempotent —
    ///         subsequent calls for the same (token, investor) pair are
    ///         no-ops. Also flips the legacy global `_registered[investor]`
    ///         flag so `isInvestor` / `investorCount` stay coherent.
    /// @dev Only callable by a caller authorised via `setAuthorizedCaller`.
    function addHolder(address token, address investor) external;

    /// @notice Whether `investor` has ever been recorded as a holder of `token`.
    function isHolder(address token, address investor) external view returns (bool);

    /// @notice Paginated slice of holders for `token`.
    function getHoldersPaginated(
        address token,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory);

    /// @notice Number of recorded holders for `token` (add-only; upper bound
    ///         on current holders per ADR-022).
    function holderCount(address token) external view returns (uint256);

    // ── Admin ───────────────────────────────────────────────────────────
    function setAuthorizedCaller(address caller, bool authorized) external;
    function transferOwnership(address newOwner) external;
}
