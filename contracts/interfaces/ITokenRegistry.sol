// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITokenRegistry
/// @notice Per-token configuration registry for the Wave 3.5 RWA platform.
///         `MuHavenSubscription` reads `TokenConfig` to discover the treasury,
///         queue, oracle, issuer, and per-token parameters for a given RWA
///         token. Decoupling config from Subscription keeps Subscription
///         stateless w.r.t. token-specific tuning.
///
/// @dev Phase 1 interface; implementation lands in Phase 2 per
///      `development/DEV_WAVE_3_5/WAVE_3_5_REVISED.md`.
///
///      Resolves PRODUCTION_DESIGN §8 Q1: the registry is a **separate
///      contract** rather than a storage mapping inside Subscription.
///      Rationale: (a) decouples config updates from Subscription upgrades,
///      (b) gives multi-token operators a single audit surface, (c) isolates
///      issuer-scoped writes (pause, min investment, cap) from the
///      owner-scoped registration path.
interface ITokenRegistry {
    // ── Types ─────────────────────────────────────────────────────────────

    /// @notice Per-token platform configuration.
    /// @param active              Token is registered and accepts purchase/redeem.
    /// @param treasury            `MuHavenTreasury` bound to this token.
    /// @param queue               `RedemptionQueue` bound to this token.
    /// @param oracle              `IPriceOracle` implementation for this token.
    /// @param issuer              Address with issuer-scoped rights (pause,
    ///                            deposit/withdraw, process queue, fund epoch).
    /// @param minInvestment       Cleartext lower-bound on shares per purchase
    ///                            (see ADR-Q2-resolution in `ADR_LOG.md`).
    /// @param instantRedeemCap    Cleartext per-epoch instant-redeem ceiling
    ///                            in PUSDC base units (see ADR-004).
    /// @param epochDuration       Seconds per instant-redeem epoch.
    /// @param paused              Token-scoped circuit breaker.
    struct TokenConfig {
        bool    active;
        address treasury;
        address queue;
        address oracle;
        address issuer;
        uint128 minInvestment;
        uint128 instantRedeemCap;
        uint32  epochDuration;
        bool    paused;
    }

    // ── Events ────────────────────────────────────────────────────────────

    event TokenRegistered(address indexed token, address indexed issuer);
    event IssuerUpdated(address indexed token, address indexed oldIssuer, address indexed newIssuer);
    event PausedUpdated(address indexed token, bool paused);
    event MinInvestmentUpdated(address indexed token, uint128 newMin);
    event InstantRedeemCapUpdated(address indexed token, uint128 newCap);
    event OracleUpdated(address indexed token, address indexed newOracle);
    event TreasuryUpdated(address indexed token, address indexed newTreasury);
    event QueueUpdated(address indexed token, address indexed newQueue);
    event EpochDurationUpdated(address indexed token, uint32 newDuration);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error TokenAlreadyRegistered();
    error TokenNotRegistered();
    error OnlyOwner();
    error OnlyIssuer();
    error OnlyIssuerOrOwner();
    error ZeroAddress();
    error ZeroEpochDuration();

    // ── Registration ──────────────────────────────────────────────────────

    /// @notice Register a new RWA token + its surrounding contracts.
    /// @dev Owner-only. Reverts if `token` is already registered.
    function registerToken(address token, TokenConfig calldata config) external;

    /// @notice Rotate the issuer address for a token. Owner-only (issuer
    ///         rotation is a governance action, not an issuer self-service).
    function setIssuer(address token, address newIssuer) external;

    /// @notice Pause/unpause a token. Callable by owner OR token issuer.
    function setPaused(address token, bool paused) external;

    /// @notice Update the minimum investment. Issuer-only.
    function setMinInvestment(address token, uint128 min) external;

    /// @notice Update the per-epoch instant-redeem cap. Issuer-only.
    function setInstantRedeemCap(address token, uint128 cap) external;

    /// @notice Swap the oracle implementation. Owner-only (infrequent, governance action).
    function setOracle(address token, address newOracle) external;

    /// @notice Rotate the `MuHavenTreasury` pointer. Owner-only.
    function setTreasury(address token, address newTreasury) external;

    /// @notice Rotate the `RedemptionQueue` pointer. Owner-only.
    function setQueue(address token, address newQueue) external;

    /// @notice Update the epoch duration (seconds). Issuer-only.
    function setEpochDuration(address token, uint32 newDuration) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Whether `token` is registered AND not paused.
    function isActive(address token) external view returns (bool);

    /// @notice Full config snapshot for a token.
    function getConfig(address token) external view returns (TokenConfig memory);

    /// @notice List of all registered tokens (paginated).
    function getRegisteredTokens(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory tokens);

    /// @notice Total number of registered tokens.
    function registeredTokenCount() external view returns (uint256);
}
