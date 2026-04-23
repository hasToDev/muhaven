// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";

/// @title TokenRegistry
/// @notice Per-token configuration registry. `MuHavenSubscription` reads
///         `TokenConfig` on every `purchase` / `redeem` to discover the
///         treasury, queue, oracle, issuer, and per-token parameters.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Resolves PRODUCTION_DESIGN §8 Q1 per ADR-024: TokenRegistry is a
///      **separate contract** from Subscription so config rotations do not
///      require Subscription upgrades, and so a single audit surface enumerates
///      every listed RWA token.
///
///      Write authorization model (matches `CONTRACTS.md §7`):
///      - `owner` (deployer / governance multi-sig): registerToken, setIssuer,
///        setOracle, setTreasury, setQueue, setPaused.
///      - `issuer` (per-token): setPaused, setMinInvestment,
///        setInstantRedeemCap, setEpochDuration.
///      `setPaused` overlaps — both owner and issuer can flip it (emergency
///      circuit breaker accessible from either role).
contract TokenRegistry is Initializable, ITokenRegistry {

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;
    mapping(address => TokenConfig) private _configs;
    address[] private _registeredTokens;

    /// @dev Reserved storage for future upgrades. Two mappings + one array
    ///      already consume the top of the natural layout; keep 47 reserved
    ///      for additive config fields / module bindings.
    uint256[47] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyIssuer(address token) {
        TokenConfig storage cfg = _configs[token];
        if (!cfg.active) revert TokenNotRegistered();
        if (msg.sender != cfg.issuer) revert OnlyIssuer();
        _;
    }

    modifier onlyIssuerOrOwner(address token) {
        TokenConfig storage cfg = _configs[token];
        if (!cfg.active) revert TokenNotRegistered();
        if (msg.sender != cfg.issuer && msg.sender != owner) revert OnlyIssuerOrOwner();
        _;
    }

    modifier onlyRegistered(address token) {
        if (!_configs[token].active) revert TokenNotRegistered();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Registration ─────────────────────────────────────────────────────

    /// @notice Register a new RWA token with its bound contracts + config.
    /// @dev Owner-only. The `config.paused` flag in the input is honoured —
    ///      issuers can list a token paused (e.g. for preparation) and unpause
    ///      when ready to open for investors.
    function registerToken(address token, TokenConfig calldata config) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_configs[token].active) revert TokenAlreadyRegistered();
        if (
            config.treasury == address(0) ||
            config.queue == address(0) ||
            config.oracle == address(0) ||
            config.issuer == address(0)
        ) revert ZeroAddress();
        if (config.epochDuration == 0) revert ZeroEpochDuration();

        _configs[token] = TokenConfig({
            active: true,
            treasury: config.treasury,
            queue: config.queue,
            oracle: config.oracle,
            issuer: config.issuer,
            minInvestment: config.minInvestment,
            instantRedeemCap: config.instantRedeemCap,
            epochDuration: config.epochDuration,
            paused: config.paused
        });

        _registeredTokens.push(token);

        emit TokenRegistered(token, config.issuer);
    }

    // ── Setters ──────────────────────────────────────────────────────────

    function setIssuer(address token, address newIssuer)
        external
        onlyOwner
        onlyRegistered(token)
    {
        if (newIssuer == address(0)) revert ZeroAddress();

        TokenConfig storage cfg = _configs[token];
        address oldIssuer = cfg.issuer;
        cfg.issuer = newIssuer;

        emit IssuerUpdated(token, oldIssuer, newIssuer);
    }

    function setPaused(address token, bool paused) external onlyIssuerOrOwner(token) {
        _configs[token].paused = paused;
        emit PausedUpdated(token, paused);
    }

    function setMinInvestment(address token, uint128 min) external onlyIssuer(token) {
        _configs[token].minInvestment = min;
        emit MinInvestmentUpdated(token, min);
    }

    function setInstantRedeemCap(address token, uint128 cap) external onlyIssuer(token) {
        _configs[token].instantRedeemCap = cap;
        emit InstantRedeemCapUpdated(token, cap);
    }

    function setOracle(address token, address newOracle)
        external
        onlyOwner
        onlyRegistered(token)
    {
        if (newOracle == address(0)) revert ZeroAddress();
        _configs[token].oracle = newOracle;
        emit OracleUpdated(token, newOracle);
    }

    function setTreasury(address token, address newTreasury)
        external
        onlyOwner
        onlyRegistered(token)
    {
        if (newTreasury == address(0)) revert ZeroAddress();
        _configs[token].treasury = newTreasury;
        emit TreasuryUpdated(token, newTreasury);
    }

    function setQueue(address token, address newQueue)
        external
        onlyOwner
        onlyRegistered(token)
    {
        if (newQueue == address(0)) revert ZeroAddress();
        _configs[token].queue = newQueue;
        emit QueueUpdated(token, newQueue);
    }

    function setEpochDuration(address token, uint32 newDuration)
        external
        onlyIssuer(token)
    {
        if (newDuration == 0) revert ZeroEpochDuration();
        _configs[token].epochDuration = newDuration;
        emit EpochDurationUpdated(token, newDuration);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice Whether `token` is registered AND not paused. "Open for
    ///         business" predicate used by Subscription hot paths.
    function isActive(address token) external view returns (bool) {
        TokenConfig storage cfg = _configs[token];
        return cfg.active && !cfg.paused;
    }

    function getConfig(address token) external view returns (TokenConfig memory) {
        return _configs[token];
    }

    function getRegisteredTokens(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory result)
    {
        uint256 total = _registeredTokens.length;

        if (offset >= total) {
            return new address[](0);
        }

        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;

        result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = _registeredTokens[offset + i];
        }
    }

    function registeredTokenCount() external view returns (uint256) {
        return _registeredTokens.length;
    }
}
