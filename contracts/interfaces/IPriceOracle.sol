// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPriceOracle
/// @notice Pluggable NAV oracle interface for MuHaven RWA tokens.
///         Each RWA category (T-bill, gold, private credit, ...) wires its own
///         implementation; `MuHavenSubscription` and `RedemptionQueue` stay
///         oracle-agnostic per ADR-003.
///
/// @dev The NAV and `updatedAt` are **cleartext** — they are regulatorily
///      public for a security token. Oracles never see encrypted state.
///
///      Callers (e.g. `MuHavenSubscription.purchase`) must revert on stale
///      data: `block.timestamp - updatedAt > getMaxStaleness(token)`. Stale
///      NAV is a hard revert (not silent-fail) per ADR-003 rationale — a
///      stale-NAV silent-fail would be indistinguishable from insufficient
///      balance to the investor, masking an operator failure.
interface IPriceOracle {
    /// @notice Return the latest NAV for a token along with its publish time.
    /// @param token  MuHaven RWA token address.
    /// @return nav         NAV in PUSDC base units per share (1e18 fixed point).
    /// @return updatedAt   Unix timestamp the NAV was published.
    function getNAV(address token) external view returns (uint256 nav, uint256 updatedAt);

    /// @notice Maximum acceptable age of a NAV quote, per token, in seconds.
    ///         Callers revert if `block.timestamp - updatedAt > getMaxStaleness(token)`.
    function getMaxStaleness(address token) external view returns (uint256);
}
