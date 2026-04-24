// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IMuHavenIdentityRegistry} from "./interfaces/IMuHavenIdentityRegistry.sol";
import {IClaimTopicsRegistry} from "./interfaces/IClaimTopicsRegistry.sol";
import {ITrustedIssuersRegistry} from "./interfaces/ITrustedIssuersRegistry.sol";

/// @title MuHavenIdentityRegistry
/// @notice ERC-3643-shaped identity registry replacing the Wave 3
///         `ERC3643KYCAdapter` whitelist per ADR-011 / ADR-023.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Verification semantics (see `IMuHavenIdentityRegistry` natspec):
///        1. `devMode == true`        → every address verified (hackathon /
///           demo bypass). The frontend surfaces a visible banner when this
///           is on; latch `disableDevModeForever()` is the production flip.
///        2. `whitelisted[account]`   → verified (Wave 3 bulk-import path,
///           MIGRATION.md). Does NOT require any claim data — preserves the
///           Wave 3 "already KYC'd" UX for returning investors.
///        3. Otherwise               → account must hold every required claim
///           topic from `claimTopicsRegistry`, each signed by an issuer that
///           is trusted for that specific topic via `trustedIssuersRegistry`,
///           with `validUntil >= block.timestamp`.
///
///      Claim storage:
///        Claims are stored directly in this contract (one `Claim` struct per
///        (account, topic) pair) rather than via external ONCHAINID identity
///        contracts. Keeps Wave 3.5 self-contained while preserving the
///        ERC-3643 topology — ONCHAINID integration becomes a drop-in
///        replacement once the Wave 3.5 → production migration lands.
///
///      Country / accreditation:
///        Additional per-account fields (`country`, `accredited`) extend the
///        interface surface. Compliance modules (`CountryAllow`,
///        `CountryRestrict`, `MaxHolders` accredited-counter) read these
///        directly. Country uses ISO-3166 numeric codes (uint16).
contract MuHavenIdentityRegistry is Initializable, IMuHavenIdentityRegistry {

    // ── Types ────────────────────────────────────────────────────────────

    struct Claim {
        address issuer;
        uint64  validUntil;
    }

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;
    bool    public devMode;
    bool    public devModeDisabled;

    /// @notice Registered ONCHAINID-style identity address (informational;
    ///         verification logic keys off claims, not this pointer).
    mapping(address account => address identity) private _identities;

    /// @notice Wave 3 bulk-import shortcut — accounts flagged here are
    ///         considered verified regardless of claim topics.
    mapping(address account => bool) public isWhitelisted;

    /// @notice Per-account per-topic claim storage.
    mapping(address account => mapping(uint256 topic => Claim)) private _claims;

    /// @notice Per-account ISO-3166 numeric country code (0 = unset).
    mapping(address account => uint16 country) public countryOf;

    /// @notice Accredited-investor flag. Tier 2 ERC-3643 semantics.
    mapping(address account => bool) public isAccredited;

    IClaimTopicsRegistry   public claimTopicsRegistryContract;
    ITrustedIssuersRegistry public trustedIssuersRegistryContract;

    uint256[40] private __gap;

    // ── Additional errors ────────────────────────────────────────────────

    error InvalidIssuer();
    error InvalidValidUntil();
    error ClaimNotFound();
    error ArrayLengthMismatch();
    /// @notice Caller is neither the registry owner nor the trusted issuer
    ///         (for the specific topic being attested / revoked).
    error NotOwnerOrTrustedIssuer();

    // ── Additional events ────────────────────────────────────────────────

    event IdentityRegistryInitialized(address indexed owner, bool devMode);
    event ClaimAdded(address indexed account, uint256 indexed topic, address indexed issuer, uint64 validUntil);
    event ClaimRemoved(address indexed account, uint256 indexed topic);
    event CountryUpdated(address indexed account, uint16 country);
    event AccreditedUpdated(address indexed account, bool accredited);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param _owner             Governance multisig (rotatable).
    /// @param _claimTopicsReg    `ClaimTopicsRegistry` pointer (may be zero;
    ///                           required only once dev-mode is disabled).
    /// @param _trustedIssuersReg `TrustedIssuersRegistry` pointer (same).
    /// @param _devMode           Initial dev-mode state. Typically `true` for
    ///                           Wave 3.5 demo deploys per ADR-011.
    function initialize(
        address _owner,
        address _claimTopicsReg,
        address _trustedIssuersReg,
        bool    _devMode
    ) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        devMode = _devMode;

        // Registries may legitimately be zero at deploy time — production
        // flip wires them before `disableDevModeForever`.
        if (_claimTopicsReg != address(0)) {
            claimTopicsRegistryContract = IClaimTopicsRegistry(_claimTopicsReg);
        }
        if (_trustedIssuersReg != address(0)) {
            trustedIssuersRegistryContract = ITrustedIssuersRegistry(_trustedIssuersReg);
        }

        emit IdentityRegistryInitialized(_owner, _devMode);
    }

    // ── Verification (hot path) ──────────────────────────────────────────

    /// @inheritdoc IMuHavenIdentityRegistry
    /// @dev Order: dev-mode → whitelist → full claim verification. Dev-mode
    ///      and whitelist both short-circuit without touching the registries,
    ///      so `isVerified` is O(1) on the common-case paths.
    function isVerified(address account) external view returns (bool) {
        if (devMode) return true;
        if (isWhitelisted[account]) return true;

        // Production-mode claim verification. Both registries must be wired.
        IClaimTopicsRegistry topicsReg = claimTopicsRegistryContract;
        ITrustedIssuersRegistry issuersReg = trustedIssuersRegistryContract;
        if (address(topicsReg) == address(0) || address(issuersReg) == address(0)) {
            return false;
        }

        uint256[] memory topics = topicsReg.getClaimTopics();
        // No required topics ⇒ nothing to prove; production-mode-with-empty-
        // topics behaves identically to "only whitelisted accounts pass".
        if (topics.length == 0) return false;

        for (uint256 i = 0; i < topics.length; i++) {
            uint256 topic = topics[i];
            Claim memory c = _claims[account][topic];

            // Claim must exist (issuer non-zero), not be expired, and come
            // from an issuer currently trusted for this specific topic.
            if (c.issuer == address(0)) return false;
            if (c.validUntil < block.timestamp) return false;
            if (!issuersReg.hasClaimTopic(c.issuer, topic)) return false;
        }

        return true;
    }

    // ── Identity management ──────────────────────────────────────────────

    /// @notice Register an ONCHAINID-style identity address for `account`.
    ///         Informational — `isVerified` does not read this value; it's
    ///         here for forward compatibility with real ONCHAINID adapters.
    function registerIdentity(address account, address identity) external onlyOwner {
        if (account == address(0) || identity == address(0)) revert ZeroAddress();
        if (_identities[account] != address(0)) revert AlreadyRegistered();

        _identities[account] = identity;
        emit IdentityRegistered(account, identity);
    }

    /// @notice Remove a previously-registered identity.
    function removeIdentity(address account) external onlyOwner {
        if (_identities[account] == address(0)) revert NotRegistered();
        delete _identities[account];
        emit IdentityRemoved(account);
    }

    /// @notice Return the registered identity pointer for `account`.
    function identityOf(address account) external view returns (address) {
        return _identities[account];
    }

    // ── Wave 3 whitelist bulk-import (MIGRATION.md) ──────────────────────

    /// @inheritdoc IMuHavenIdentityRegistry
    function addWhitelisted(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (!isWhitelisted[account]) {
                isWhitelisted[account] = true;
                emit WhitelistAdded(account);
            }
        }
    }

    /// @inheritdoc IMuHavenIdentityRegistry
    function removeWhitelisted(address account) external onlyOwner {
        if (!isWhitelisted[account]) return;
        isWhitelisted[account] = false;
        emit WhitelistRemoved(account);
    }

    // ── Claim management ────────────────────────────────────────────────

    /// @notice Store a claim for `account` on `topic`. Callable by the owner
    ///         (operator path) OR an issuer currently trusted for `topic` in
    ///         `trustedIssuersRegistry`.
    /// @dev The owner path lets the Wave 3.5 operator pre-seed claims for
    ///      demo flows without standing up external issuer keys.
    function addClaim(
        address account,
        uint256 topic,
        address issuer,
        uint64  validUntil
    ) external {
        if (account == address(0) || issuer == address(0)) revert ZeroAddress();
        if (validUntil <= block.timestamp) revert InvalidValidUntil();

        if (msg.sender != owner) {
            ITrustedIssuersRegistry reg = trustedIssuersRegistryContract;
            if (address(reg) == address(0)) revert NotOwnerOrTrustedIssuer();
            if (!reg.hasClaimTopic(msg.sender, topic)) revert NotOwnerOrTrustedIssuer();
            // Issuer-path callers must self-attest.
            if (issuer != msg.sender) revert InvalidIssuer();
        }

        _claims[account][topic] = Claim({issuer: issuer, validUntil: validUntil});
        emit ClaimAdded(account, topic, issuer, validUntil);
    }

    /// @notice Remove a stored claim. Callable by the owner OR the original
    ///         claim issuer.
    function removeClaim(address account, uint256 topic) external {
        Claim memory existing = _claims[account][topic];
        if (existing.issuer == address(0)) revert ClaimNotFound();

        if (msg.sender != owner && msg.sender != existing.issuer) {
            revert NotOwnerOrTrustedIssuer();
        }

        delete _claims[account][topic];
        emit ClaimRemoved(account, topic);
    }

    /// @notice Return the stored claim for (`account`, `topic`). Zero-issuer
    ///         indicates no claim present.
    function getClaim(address account, uint256 topic)
        external
        view
        returns (address issuer, uint64 validUntil)
    {
        Claim memory c = _claims[account][topic];
        return (c.issuer, c.validUntil);
    }

    // ── Country + accredited (compliance-module inputs) ──────────────────

    /// @notice Set the ISO-3166 numeric country code for `account`.
    function setCountry(address account, uint16 country) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        countryOf[account] = country;
        emit CountryUpdated(account, country);
    }

    /// @notice Batch country setter — deploy-time + bulk-import ergonomics.
    function setCountryBatch(address[] calldata accounts, uint16[] calldata countries)
        external
        onlyOwner
    {
        if (accounts.length != countries.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            if (a == address(0)) revert ZeroAddress();
            countryOf[a] = countries[i];
            emit CountryUpdated(a, countries[i]);
        }
    }

    /// @notice Toggle accredited-investor flag.
    function setAccredited(address account, bool accredited) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isAccredited[account] = accredited;
        emit AccreditedUpdated(account, accredited);
    }

    // ── Dev-mode lifecycle (ADR-023) ─────────────────────────────────────

    /// @inheritdoc IMuHavenIdentityRegistry
    function setDevMode(bool enabled) external onlyOwner {
        if (devModeDisabled) revert DevModeIrreversiblyDisabled();
        devMode = enabled;
        emit DevModeToggled(enabled, block.timestamp);
    }

    /// @inheritdoc IMuHavenIdentityRegistry
    function disableDevModeForever() external onlyOwner {
        devMode = false;
        devModeDisabled = true;
        emit DevModeDisabledForever(block.timestamp);
    }

    // ── Registry pointers ────────────────────────────────────────────────

    /// @inheritdoc IMuHavenIdentityRegistry
    function claimTopicsRegistry() external view returns (address) {
        return address(claimTopicsRegistryContract);
    }

    /// @inheritdoc IMuHavenIdentityRegistry
    function trustedIssuersRegistry() external view returns (address) {
        return address(trustedIssuersRegistryContract);
    }

    /// @inheritdoc IMuHavenIdentityRegistry
    function setClaimTopicsRegistry(address newRegistry) external onlyOwner {
        claimTopicsRegistryContract = IClaimTopicsRegistry(newRegistry);
        emit ClaimTopicsRegistryUpdated(newRegistry);
    }

    /// @inheritdoc IMuHavenIdentityRegistry
    function setTrustedIssuersRegistry(address newRegistry) external onlyOwner {
        trustedIssuersRegistryContract = ITrustedIssuersRegistry(newRegistry);
        emit TrustedIssuersRegistryUpdated(newRegistry);
    }

    // ── Ownership ────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
