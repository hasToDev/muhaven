// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMuHavenIdentityRegistry
/// @notice ERC-3643-shaped identity registry for the Wave 3.5 compliance layer.
///         Supersedes Wave 3's `ERC3643KYCAdapter` whitelist per ADR-011.
///
/// @dev Verification semantics:
///      1. `devMode == true` → every address is treated as verified (hackathon
///         / demo bypass; gated by the irreversible latch per ADR-023).
///      2. `devMode == false` → `isVerified(addr)` returns true iff the address
///         holds every required claim topic from `ClaimTopicsRegistry`, signed
///         by a `TrustedIssuersRegistry` issuer, and none of those claims have
///         expired (`validUntil >= block.timestamp`).
///
///      For Wave 3.5's dev-mode default, minimal claim/topic registry stubs
///      ship alongside this contract — they exist so the production flip is
///      a config change, not a contract redeploy.
interface IMuHavenIdentityRegistry {
    // ── Events ────────────────────────────────────────────────────────────

    event IdentityRegistered(address indexed account, address indexed identity);
    event IdentityRemoved(address indexed account);
    event DevModeToggled(bool enabled, uint256 timestamp);
    event DevModeDisabledForever(uint256 timestamp);
    event ClaimTopicsRegistryUpdated(address indexed newRegistry);
    event TrustedIssuersRegistryUpdated(address indexed newRegistry);
    event WhitelistAdded(address indexed account);
    event WhitelistRemoved(address indexed account);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error DevModeIrreversiblyDisabled();

    // ── Verification (the hot-path entry point) ──────────────────────────

    /// @notice True if the account is eligible to hold / transact MuHaven
    ///         RWA tokens.
    ///
    /// @dev Dev-mode returns `true` for every caller (ADR-011). Production
    ///      mode evaluates claims per `ClaimTopicsRegistry` +
    ///      `TrustedIssuersRegistry` + `validUntil` expiry.
    function isVerified(address account) external view returns (bool);

    /// @notice Current state of the dev-mode bypass.
    function devMode() external view returns (bool);

    /// @notice True once `disableDevModeForever()` has run. Subsequent calls
    ///         to `setDevMode(true)` revert with `DevModeIrreversiblyDisabled()`.
    function devModeDisabled() external view returns (bool);

    // ── Admin: dev-mode lifecycle (ADR-023) ──────────────────────────────

    /// @notice Toggle dev-mode. Reverts if `devModeDisabled` is set.
    function setDevMode(bool enabled) external;

    /// @notice Irreversibly disable dev-mode. One-way latch — no setter can
    ///         re-enable it afterwards. Emits `DevModeDisabledForever`.
    function disableDevModeForever() external;

    // ── Admin: identity management ───────────────────────────────────────

    /// @notice Whitelist-style shortcut used during Wave 3 bulk-import on
    ///         cutover (`MIGRATION.md`). Equivalent to "register identity
    ///         with the minimum claim set to satisfy `isVerified` in
    ///         dev-mode" so Wave 3 investors transition without a new KYC.
    function addWhitelisted(address[] calldata accounts) external;

    /// @notice Remove a previously whitelisted account.
    function removeWhitelisted(address account) external;

    /// @notice Registry pointers for production-mode claim verification.
    function claimTopicsRegistry() external view returns (address);
    function trustedIssuersRegistry() external view returns (address);

    function setClaimTopicsRegistry(address newRegistry) external;
    function setTrustedIssuersRegistry(address newRegistry) external;

    // ── Compliance-module data surface (Phase 3 extension) ──────────────

    /// @notice ISO-3166 numeric country code for `account` (0 = unset).
    ///         Consumed by `CountryAllow` / `CountryRestrict` modules.
    function countryOf(address account) external view returns (uint16);

    /// @notice Accredited-investor flag for `account` (ERC-735 topic 7
    ///         equivalent). Consumed by `MaxHolders` accredited counter.
    function isAccredited(address account) external view returns (bool);
}
