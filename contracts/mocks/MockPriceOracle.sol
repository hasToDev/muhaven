// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title MockPriceOracle
/// @notice Minimal test stand-in for `IPriceOracle`. Exposes setters so tests
///         can pin NAV / staleness for predictable assertions. NOT production
///         code — the Wave 3.5 deployment uses `IssuerControlledOracle` or
///         `ChainlinkFunctionsOracle` per ADR-014.
contract MockPriceOracle is IPriceOracle {
    mapping(address => uint256) public nav;
    mapping(address => uint256) public updatedAt;
    mapping(address => uint256) public maxStalenessPerToken;

    /// @notice Default staleness used when a token has no per-token override.
    ///         Set high (36h) to avoid false-positive stale reverts in tests.
    uint256 public constant DEFAULT_MAX_STALENESS = 36 hours;

    event NAVSet(address indexed token, uint256 nav, uint256 updatedAt);
    event MaxStalenessSet(address indexed token, uint256 newMaxStaleness);

    /// @notice Pin the NAV + publish timestamp for a token.
    /// @dev Tests typically call this with `block.timestamp` to simulate a
    ///      fresh publish; pass a stale timestamp to force staleness reverts.
    function setNAV(address token, uint256 newNAV, uint256 newUpdatedAt) external {
        nav[token] = newNAV;
        updatedAt[token] = newUpdatedAt;
        emit NAVSet(token, newNAV, newUpdatedAt);
    }

    function setMaxStaleness(address token, uint256 newMaxStaleness) external {
        maxStalenessPerToken[token] = newMaxStaleness;
        emit MaxStalenessSet(token, newMaxStaleness);
    }

    // ── IPriceOracle ──────────────────────────────────────────────────────

    function getNAV(address token) external view returns (uint256, uint256) {
        return (nav[token], updatedAt[token]);
    }

    function getMaxStaleness(address token) external view returns (uint256) {
        uint256 custom = maxStalenessPerToken[token];
        return custom == 0 ? DEFAULT_MAX_STALENESS : custom;
    }

    /// @notice Mock has no sequencer integration — freshness is purely a
    ///         function of the pinned `updatedAt` vs the per-token staleness
    ///         window. A token with `updatedAt == 0` (never pinned) or
    ///         `nav == 0` (explicitly wiped) is reported as not fresh —
    ///         matches `IssuerControlledOracle.isFresh` so callers that
    ///         rely on the consolidated predicate behave identically against
    ///         mock and production oracles.
    function isFresh(address token) external view returns (bool) {
        uint256 updated = updatedAt[token];
        if (updated == 0) return false;
        if (nav[token] == 0) return false;
        uint256 custom = maxStalenessPerToken[token];
        uint256 window = custom == 0 ? DEFAULT_MAX_STALENESS : custom;
        if (block.timestamp < updated) return false;
        return block.timestamp - updated <= window;
    }
}
