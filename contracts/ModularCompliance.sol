// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IModularCompliance} from "./interfaces/IModularCompliance.sol";
import {IComplianceModule} from "./interfaces/IComplianceModule.sol";

/// @title ModularCompliance
/// @notice Per-token pluggable-module compliance coordinator. Every RWA token
///         points at one `ModularCompliance` instance that holds an ordered
///         list of `IComplianceModule` contracts. `canTransfer` iterates the
///         list; the transfer is blocked unless every bound module approves.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Wave 3.5 ships this in dev-mode per ADR-011: most tokens launch with
///      **zero modules bound**, making `canTransfer` a permissive no-op.
///      Issuers bind modules progressively as production-mode readiness
///      requires them.
///
///      Gas-bomb protection:
///        `MAX_MODULES_PER_TOKEN` caps the module list so an adversarial
///        issuer (or an operator misfire) can't bind hundreds of modules
///        and brick every transfer. `canTransfer` iteration is the hot path;
///        keeping it bounded is load-bearing.
contract ModularCompliance is Initializable, IModularCompliance {

    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Hard cap on modules per token. Matches the short-list the
    ///         Wave 3.5 plan enumerates (`CountryAllow`, `CountryRestrict`,
    ///         `MaxHolders`, `Lockup`, `MaxBalance`) with headroom for future
    ///         additions. Tunable by redeploying the coordinator (proxy
    ///         upgrade preserves bindings).
    uint256 public constant MAX_MODULES_PER_TOKEN = 16;

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;

    /// @notice Ordered module list per token.
    mapping(address token => address[]) private _modules;
    /// @notice 1-based index into `_modules[token]` for swap-and-pop removal.
    mapping(address token => mapping(address module => uint256 oneBased)) private _moduleIndex;

    /// @notice Per-token allowlist for callers of the state-update hooks
    ///         (`created` / `transferred` / `destroyed`). Gates tracker
    ///         mutations to the RWA token contract + subscription contract
    ///         bound to that token. Without this gate, any EOA could fan
    ///         bogus events out to stateful modules (`MaxHolders` counters,
    ///         `MaxBalance` trackers, `Lockup` extensions) and pollute them.
    mapping(address token => mapping(address caller => bool)) public authorizedCaller;

    uint256[46] private __gap;

    // ── Additional errors / events ───────────────────────────────────────

    error NotAuthorizedCaller();

    event AuthorizedCallerUpdated(address indexed token, address indexed caller, bool authorized);

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

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @inheritdoc IModularCompliance
    function bindModule(address token, address module) external onlyOwner {
        if (token == address(0) || module == address(0)) revert ZeroAddress();
        if (_moduleIndex[token][module] != 0) revert ModuleAlreadyBound();
        if (_modules[token].length >= MAX_MODULES_PER_TOKEN) revert TooManyModules();

        _modules[token].push(module);
        _moduleIndex[token][module] = _modules[token].length;

        emit ModuleBound(token, module);
    }

    /// @inheritdoc IModularCompliance
    function unbindModule(address token, address module) external onlyOwner {
        uint256 oneBased = _moduleIndex[token][module];
        if (oneBased == 0) revert ModuleNotBound();

        address[] storage list = _modules[token];
        uint256 lastIndex = list.length - 1;
        uint256 removeIndex = oneBased - 1;
        if (removeIndex != lastIndex) {
            address last = list[lastIndex];
            list[removeIndex] = last;
            _moduleIndex[token][last] = oneBased;
        }
        list.pop();
        delete _moduleIndex[token][module];

        emit ModuleUnbound(token, module);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /// @notice Grant or revoke `caller`'s authorization to fire state-update
    ///         hooks for `token`. Canonical callers are the token contract
    ///         (P2P transfers) and the subscription contract (purchase /
    ///         redeem). Owner-only.
    function setAuthorizedCaller(address token, address caller, bool authorized)
        external
        onlyOwner
    {
        if (token == address(0) || caller == address(0)) revert ZeroAddress();
        authorizedCaller[token][caller] = authorized;
        emit AuthorizedCallerUpdated(token, caller, authorized);
    }

    // ── Modifier ─────────────────────────────────────────────────────────

    modifier onlyAuthorized(address token) {
        if (!authorizedCaller[token][msg.sender]) revert NotAuthorizedCaller();
        _;
    }

    // ── Transfer gate (hot path) ─────────────────────────────────────────

    /// @inheritdoc IModularCompliance
    /// @dev Short-circuits on the first module that rejects — cheaper in the
    ///      common-case reject path. Empty module list is the permissive
    ///      default (returns `true`), matching ADR-011's dev-mode intent.
    function canTransfer(
        address token,
        address from,
        address to,
        uint256 amount
    ) external view returns (bool) {
        address[] storage list = _modules[token];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            if (!IComplianceModule(list[i]).canTransfer(token, from, to, amount)) {
                return false;
            }
        }
        return true;
    }

    // ── State-update hooks ───────────────────────────────────────────────

    /// @inheritdoc IModularCompliance
    function transferred(address token, address from, address to, uint256 amount)
        external
        onlyAuthorized(token)
    {
        address[] storage list = _modules[token];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            IComplianceModule(list[i]).transferred(token, from, to, amount);
        }
    }

    /// @inheritdoc IModularCompliance
    function created(address token, address to, uint256 amount)
        external
        onlyAuthorized(token)
    {
        address[] storage list = _modules[token];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            IComplianceModule(list[i]).created(token, to, amount);
        }
    }

    /// @inheritdoc IModularCompliance
    function destroyed(address token, address from, uint256 amount)
        external
        onlyAuthorized(token)
    {
        address[] storage list = _modules[token];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            IComplianceModule(list[i]).destroyed(token, from, amount);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IModularCompliance
    function getBoundModules(address token) external view returns (address[] memory) {
        return _modules[token];
    }

    /// @inheritdoc IModularCompliance
    function moduleCount(address token) external view returns (uint256) {
        return _modules[token].length;
    }

    /// @inheritdoc IModularCompliance
    function isModuleBound(address token, address module) external view returns (bool) {
        return _moduleIndex[token][module] != 0;
    }
}
