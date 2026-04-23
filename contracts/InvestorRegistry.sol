// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";

/// @title InvestorRegistry
/// @notice Standalone upgradeable registry tracking investor addresses and
///         per-token holder sets. Queried by MuHavenToken (on mint / transfer),
///         MuHavenSubscription (on purchase), MuHavenVault (on wrap),
///         YieldDistributor (Wave 3, deprecated), and YieldSnapshot (Wave 3.5).
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Wave 3.5 additively extends the Wave 3 global API with a per-token
///      holder API per ADR-022 / ADR-026. The registry is **add-only**: holders
///      are never removed, so `holderCount(token)` is a conservative upper bound
///      on current holders (zero-balance wallets remain in the list — see
///      ADR-022 for rationale: removal on burn would require async decrypt on
///      the hot path, which breaks gas predictability).
///
///      Storage layout is additive and proxy-safe: new per-token mappings slot
///      into previously-reserved `__gap` slots, pushing the gap reservation down.
contract InvestorRegistry is Initializable, IInvestorRegistry {

    // ── Storage ──────────────────────────────────────────────────────────

    // Wave 3 — global investor set
    address[] private _investors;
    mapping(address => bool) private _registered;
    mapping(address => bool) public authorizedCallers;
    address public owner;

    // Wave 3.5 — per-token holder sets (ADR-022 / ADR-026)
    mapping(address => address[]) private _tokenHolders;
    mapping(address => mapping(address => bool)) private _isTokenHolder;

    /// @dev Reserved storage for future upgrades. Decremented by 2 slots to
    ///      accommodate the Wave 3.5 per-token mappings above, preserving the
    ///      total storage footprint (proxy-safe).
    uint256[48] private __gap;

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyAuthorized();
    error ZeroAddress();

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) revert OnlyAuthorized();
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

    // ── Global investor API (Wave 3) ────────────────────────────────────

    /// @notice Register an investor address in the global set. Skips if already
    ///         registered. Only callable by authorized contracts. Preserved for
    ///         Wave 3 back-compat; Wave 3.5 contracts prefer `addHolder`.
    function register(address investor) external onlyAuthorized {
        _registerInternal(investor);
    }

    /// @dev Shared internal path for both `register` and `addHolder` — always
    ///      flips the global `_registered` flag so `isInvestor` stays accurate
    ///      regardless of which API was the entry point.
    function _registerInternal(address investor) internal {
        if (_registered[investor]) return;

        _registered[investor] = true;
        _investors.push(investor);

        emit InvestorRegistered(investor);
    }

    function isInvestor(address account) external view returns (bool) {
        return _registered[account];
    }

    function getInvestorsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory result)
    {
        return _paginate(_investors, offset, limit);
    }

    function investorCount() external view returns (uint256) {
        return _investors.length;
    }

    // ── Per-token holder API (Wave 3.5, ADR-022 / ADR-026) ──────────────

    /// @notice Record `investor` as a holder of `token`. Idempotent — if the
    ///         pair is already recorded, the call is a no-op.
    ///
    ///         Also ensures the investor is recorded in the global set so
    ///         Wave 3 consumers (`isInvestor` / `investorCount`) see the same
    ///         investor universe.
    ///
    /// @dev Only callable by an authorised caller. In Wave 3.5 the caller is
    ///      typically a MuHavenToken instance (for transfer-in registrations),
    ///      MuHavenSubscription (for purchase registrations), or MuHavenVault
    ///      (for wrap registrations).
    function addHolder(address token, address investor) external onlyAuthorized {
        if (token == address(0) || investor == address(0)) revert ZeroAddress();

        // Global-set bookkeeping first so `isInvestor` stays accurate even if
        // the caller never registers the investor globally anywhere else.
        _registerInternal(investor);

        if (_isTokenHolder[token][investor]) return;

        _isTokenHolder[token][investor] = true;
        _tokenHolders[token].push(investor);

        emit HolderAdded(token, investor);
    }

    function isHolder(address token, address investor) external view returns (bool) {
        return _isTokenHolder[token][investor];
    }

    function getHoldersPaginated(address token, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory result)
    {
        return _paginate(_tokenHolders[token], offset, limit);
    }

    function holderCount(address token) external view returns (uint256) {
        return _tokenHolders[token].length;
    }

    // ── Pagination helper ───────────────────────────────────────────────

    function _paginate(address[] storage list, uint256 offset, uint256 limit)
        internal
        view
        returns (address[] memory result)
    {
        uint256 total = list.length;

        if (offset >= total) {
            return new address[](0);
        }

        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;

        result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = list[offset + i];
        }
    }

    // ── Admin ───────────────────────────────────────────────────────────

    /// @notice Grant or revoke authorization for a caller to register investors
    ///         or add holders. Shared authorization surface for both the global
    ///         and per-token APIs.
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;

        emit AuthorizedCallerUpdated(caller, authorized);
    }

    /// @notice Transfer ownership of the registry.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
