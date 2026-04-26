// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    ebool,
    InEuint64,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenStable} from "./interfaces/IMuHavenStable.sol";

/// @title MuHavenStable
/// @notice 1:1 confidential-USDC wrapper over the legacy pre-v0.1.0
///         ReineiraOS PUSDC. Implements `IMuHavenStable` per Phase 7.5
///         (`MHUSD_WRAPPER_PLAN.md`). Deployed behind an OZ Transparent
///         Proxy, owned by the MuHaven governance multi-sig.
///
/// @dev Key invariants:
///   - For every successful `wrap`, mhUSDC `_encryptedTotalSupply` increments
///     by the same FHE handle the wrapper's legacy-PUSDC balance moved.
///     Tested in the integration round-trip case.
///   - `unwrap` silent-fails to zero on insufficient mhUSDC balance per
///     Rule 5 — observers can't infer the user's actual balance from gas
///     usage. The follow-up legacy-PUSDC transfer uses the silent-fail-bounded
///     `actual` amount so the wrapper's PUSDC outflow always matches the
///     mhUSDC burn.
///   - Operator model mirrors PUSDC verbatim — `_operators[holder][spender]
///     > block.timestamp` for the cleartext check. Caller-set, time-bounded.
///   - Encrypted ACLs follow `FHE_ACL_CONVENTIONS.md` rules 1–5 throughout.
///
///   Drop-in compatibility:
///   - The contract additionally exposes the legacy
///     `confidentialTransfer(address,uint256)` /
///     `confidentialTransferFrom(address,address,uint256)` selectors.
///     Existing Wave 3.5 contracts (Subscription/Treasury/Queue/YieldSnapshot)
///     call PUSDC via the ADR-008 low-level path with those selectors —
///     when their `pusdc` pointer rotates to MuHavenStable, those calls
///     resolve to the shims here without touching the calling contracts.
///   - The legacy-selector shims do NOT take an `ephemeralEOA` and therefore
///     leave a kernel-only grant on the recipient's new balance handle (same
///     gap MuHavenToken faces on P2P-recipient grants). Recipients call
///     `refreshDecryptGrant(eph)` on the wrapper to bind their session.
///     Same UX absorption pattern as ADR-042 on MuHavenToken.
///
///   Ephemeral-EOA semantics:
///   - Every modern-surface mutation accepts a trailing `ephemeralEOA` param
///     per ADR-021. Non-zero grants `FHE.allow(newBalance, ephemeralEOA)` on
///     both legs of a transfer (sender + recipient) so the active session can
///     decrypt without a refresh.
///   - `wrapHandle` (contract-mode) accepts `address(0)` as `ephemeralEOA`
///     because the typical caller (e.g. `MuHavenTreasury.migrateToWrapper`)
///     is a contract with no decrypt path. EOA-flavour `wrap` requires a
///     non-zero ephemeralEOA to keep the frontend from accidentally orphaning
///     a balance.
///
///   Storage layout: see `__gap[43]` accounting at end of storage block.
contract MuHavenStable is
    Initializable,
    ERC165Upgradeable,
    ReentrancyGuardTransient,
    IMuHavenStable
{

    // ── Storage ──────────────────────────────────────────────────────────

    mapping(address => euint64) private _balances;
    mapping(address => mapping(address => uint48)) private _operators;
    euint64 private _encryptedTotalSupply;

    string public name;
    string public symbol;

    /// @inheritdoc IMuHavenStable
    address public owner;
    /// @inheritdoc IMuHavenStable
    address public legacyPusdc;
    /// @inheritdoc IMuHavenStable
    bool public paused;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Eight
    ///      named slots above (3 mappings/euint, 2 strings, 2 addresses, 1
    ///      bool) → reserve 42 to land at 50 own slots, matching the
    ///      `MuHavenSubscription` / `TokenRegistry` convention.
    uint256[42] private __gap;

    // ── Constants ────────────────────────────────────────────────────────

    /// @dev Selector for `confidentialTransferFrom(address,address,uint256)`
    ///      — legacy pre-v0.1.0 PUSDC ABI per ADR-008. Used to pull from
    ///      caller's legacy PUSDC balance during `wrap` / `wrapHandle`.
    bytes4 private constant _LEGACY_TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    /// @dev Selector for `confidentialTransfer(address,uint256)` — legacy
    ///      pre-v0.1.0 PUSDC ABI per ADR-008. Used to push back to caller
    ///      during `unwrap`.
    bytes4 private constant _LEGACY_TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedSurface();
        _;
    }

    // ── Additive errors (not in interface) ───────────────────────────────

    /// @dev Pause-state revert. Loud signal: surface is frozen.
    error PausedSurface();

    /// @dev Pause-state already matches requested target.
    error PauseStateAlreadySet();

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @param name_         Display name (e.g. "MuHaven Confidential USD").
    /// @param symbol_       Display symbol (e.g. "mhUSDC").
    /// @param owner_        Initial governance address (rotatable).
    /// @param legacyPusdc_  Underlying ConfidentialUSDC pointer.
    function initialize(
        string memory name_,
        string memory symbol_,
        address owner_,
        address legacyPusdc_
    ) external initializer {
        if (owner_ == address(0) || legacyPusdc_ == address(0)) revert ZeroAddress();

        __ERC165_init();

        name = name_;
        symbol = symbol_;
        owner = owner_;
        legacyPusdc = legacyPusdc_;

        emit StableInitialized(owner_, legacyPusdc_);
    }

    function decimals() external pure returns (uint8) {
        // Mirrors USDC: 6-decimal stablecoin convention.
        return 6;
    }

    // ── Wrap / unwrap ────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenStable
    /// @dev EOA path. Verifies the client-encrypted input proof against
    ///      `msg.sender`. Loud-reverts on legacy PUSDC failure (operator
    ///      not set, paused, etc.) — there's no silent-fail on the wrap
    ///      leg because the caller actively initiated the action.
    function wrap(InEuint64 calldata encAmount, address ephemeralEOA)
        external
        whenNotPaused
        nonReentrant
    {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();

        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);

        _doWrap(msg.sender, amount, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Contract path. Caller (e.g. Treasury) holds an existing
    ///      `euint64` handle that they have ACL on (typically read from
    ///      `legacyPusdc.confidentialBalanceOf(this)`). The caller is
    ///      both the source of legacy PUSDC and the recipient of mhUSDC
    ///      — we don't expose a separate `to` param because that would
    ///      let any operator drain a holder's balance into someone else's
    ///      mhUSDC.
    function wrapHandle(euint64 amount, address ephemeralEOA)
        external
        whenNotPaused
        nonReentrant
    {
        // Caller must already hold ACL on `amount` so we can re-grant it
        // to legacy PUSDC. The `FHE.allow` call below would revert
        // ACL-denied otherwise — that's the only access gate we need.
        FHE.allowThis(amount);

        _doWrap(msg.sender, amount, ephemeralEOA);
    }

    function _doWrap(address from, euint64 amount, address ephemeralEOA) internal {
        // Grant legacy PUSDC ACL on the amount handle so it can run its
        // internal FHE.sub/FHE.add on the transfer.
        FHE.allow(amount, legacyPusdc);

        // Pull from `from` via legacy PUSDC. `from` must have already
        // called `legacyPusdc.setOperator(this, until)`. The wrapper
        // itself is the caller (operator). Reverts loudly if PUSDC
        // refuses the call — operator missing, paused, etc.
        (bool ok, ) = legacyPusdc.call(
            abi.encodeWithSelector(
                _LEGACY_TRANSFER_FROM_UINT256,
                from,
                address(this),
                uint256(euint64.unwrap(amount))
            )
        );
        if (!ok) revert WrapFailed();

        _mintInternal(from, amount, ephemeralEOA);
        emit Wrap(from, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Silent-fails to zero on insufficient mhUSDC balance per Rule 5.
    ///      The legacy PUSDC push uses the silent-fail-bounded `actual`
    ///      amount so the wrapper's PUSDC outflow exactly matches the
    ///      mhUSDC burn (1:1 invariant preserved on every leg).
    function unwrap(InEuint64 calldata encAmount, address ephemeralEOA)
        external
        whenNotPaused
        nonReentrant
    {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();

        euint64 requested = FHE.asEuint64(encAmount);
        FHE.allowThis(requested);

        // Silent-fail to zero if requested > balance (Rule 5).
        euint64 actual = _silentFailBound(_balances[msg.sender], requested);

        // Burn first, then push legacy PUSDC. Burn is internal-only state;
        // the legacy PUSDC call is the external call. CEI ordering.
        _burnInternal(msg.sender, actual, ephemeralEOA);

        // Push legacy PUSDC back to caller. Grant PUSDC ACL on `actual`.
        FHE.allow(actual, legacyPusdc);

        (bool ok, ) = legacyPusdc.call(
            abi.encodeWithSelector(
                _LEGACY_TRANSFER_UINT256,
                msg.sender,
                uint256(euint64.unwrap(actual))
            )
        );
        if (!ok) revert UnwrapFailed();

        emit Unwrap(msg.sender, ephemeralEOA);
    }

    // ── Confidential transfers (modern surface) ─────────────────────────

    /// @inheritdoc IMuHavenStable
    function transfer(
        address to,
        InEuint64 calldata encAmount,
        address ephemeralEOA
    ) external whenNotPaused returns (euint64 actualTransferred) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (to == address(0)) revert ZeroAddress();

        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);

        return _doTransfer(msg.sender, to, amount, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    function transfer(
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external whenNotPaused returns (euint64 actualTransferred) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (to == address(0)) revert ZeroAddress();

        FHE.allowThis(encAmount);

        return _doTransfer(msg.sender, to, encAmount, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    function transferFrom(
        address from,
        address to,
        InEuint64 calldata encAmount,
        address ephemeralEOA
    ) external whenNotPaused returns (euint64 actualTransferred) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);

        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);

        return _doTransfer(from, to, amount, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    function transferFrom(
        address from,
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external whenNotPaused returns (euint64 actualTransferred) {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);

        FHE.allowThis(encAmount);

        return _doTransfer(from, to, encAmount, ephemeralEOA);
    }

    // ── Legacy IFHERC20 shim selectors (for ADR-008 callers) ────────────

    /// @notice Legacy `confidentialTransfer(address,InEuint64)` shim — for
    ///         IFHERC20-shaped callers. No ephemeralEOA grant on recipient
    ///         (kernel-only); recipient calls `refreshDecryptGrant` to bind.
    function confidentialTransfer(
        address to,
        InEuint64 calldata inValue
    ) external whenNotPaused returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        euint64 amount = FHE.asEuint64(inValue);
        FHE.allowThis(amount);
        return _doTransfer(msg.sender, to, amount, address(0));
    }

    /// @notice Legacy `confidentialTransfer(address,euint64)` shim.
    function confidentialTransfer(
        address to,
        euint64 value
    ) external whenNotPaused returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        FHE.allowThis(value);
        return _doTransfer(msg.sender, to, value, address(0));
    }

    /// @notice Legacy `confidentialTransfer(address,uint256)` shim — the
    ///         actual selector used by Wave 3.5 contracts via low-level
    ///         call (ADR-008). Receives the ciphertext hash as uint256;
    ///         re-wraps as `euint64` and delegates.
    function confidentialTransfer(
        address to,
        uint256 value
    ) external whenNotPaused returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        euint64 amount = euint64.wrap(bytes32(value));
        FHE.allowThis(amount);
        euint64 result = _doTransfer(msg.sender, to, amount, address(0));
        return uint256(euint64.unwrap(result));
    }

    /// @notice Legacy `confidentialTransferFrom(address,address,InEuint64)` shim.
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 calldata inValues
    ) external whenNotPaused returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);
        euint64 amount = FHE.asEuint64(inValues);
        FHE.allowThis(amount);
        return _doTransfer(from, to, amount, address(0));
    }

    /// @notice Legacy `confidentialTransferFrom(address,address,euint64)` shim.
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) external whenNotPaused returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);
        FHE.allowThis(value);
        return _doTransfer(from, to, value, address(0));
    }

    /// @notice Legacy `confidentialTransferFrom(address,address,uint256)` —
    ///         the selector Wave 3.5 contracts encode via low-level call.
    function confidentialTransferFrom(
        address from,
        address to,
        uint256 value
    ) external whenNotPaused returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);
        euint64 amount = euint64.wrap(bytes32(value));
        FHE.allowThis(amount);
        euint64 result = _doTransfer(from, to, amount, address(0));
        return uint256(euint64.unwrap(result));
    }

    // ── Operator model ───────────────────────────────────────────────────

    /// @inheritdoc IMuHavenStable
    function setOperator(address operator, uint48 until) external {
        if (operator == address(0)) revert ZeroAddress();
        _operators[msg.sender][operator] = until;
        emit OperatorSet(msg.sender, operator, until);
    }

    /// @inheritdoc IMuHavenStable
    function isOperator(address holder, address spender) external view returns (bool) {
        return _operators[holder][spender] > block.timestamp;
    }

    function _requireOperator(address holder, address spender) internal view {
        // Holder is implicitly always operator over their own balance.
        if (holder == spender) return;
        if (_operators[holder][spender] <= block.timestamp) revert NotOperator();
    }

    // ── Encrypted views ──────────────────────────────────────────────────

    /// @inheritdoc IMuHavenStable
    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @inheritdoc IMuHavenStable
    function confidentialTotalSupply() external view returns (euint64) {
        return _encryptedTotalSupply;
    }

    // ── Self-service ACL refresh (ADR-042 mirror) ────────────────────────

    /// @inheritdoc IMuHavenStable
    /// @dev Mirrors `MuHavenToken.refreshDecryptGrant`. Zero-balance caller
    ///      is a no-op + event so the frontend can fire unconditionally on
    ///      first decrypt attempt without a balance pre-check.
    function refreshDecryptGrant(address ephemeralEOA) external {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (Common.isInitialized(_balances[msg.sender])) {
            FHE.allow(_balances[msg.sender], ephemeralEOA);
        }
        emit DecryptGrantRefreshed(msg.sender, ephemeralEOA);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenStable
    function pause() external onlyOwner {
        if (paused) revert PauseStateAlreadySet();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @inheritdoc IMuHavenStable
    function unpause() external onlyOwner {
        if (!paused) revert PauseStateAlreadySet();
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @inheritdoc IMuHavenStable
    function setLegacyPusdc(address newPusdc) external onlyOwner {
        if (newPusdc == address(0)) revert ZeroAddress();
        legacyPusdc = newPusdc;
        emit LegacyPusdcUpdated(newPusdc);
    }

    /// @inheritdoc IMuHavenStable
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ──────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IMuHavenStable).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // ── Internal: balance mutations ──────────────────────────────────────

    /// @dev Silent-fail bound: `requested <= balance ? requested : 0`. Used
    ///      by `unwrap` and `_doTransfer` for Rule 5 enforcement.
    function _silentFailBound(
        euint64 balance,
        euint64 requested
    ) internal returns (euint64) {
        ebool hasEnough = FHE.lte(requested, balance);
        FHE.allowThis(hasEnough);

        euint64 zero = FHE.asEuint64(uint256(0));
        FHE.allowThis(zero);

        euint64 actual = FHE.select(hasEnough, requested, zero);
        FHE.allowThis(actual);
        return actual;
    }

    /// @dev Mint `amount` mhUSDC to `to`. Grants `to`'s kernel + (if
    ///      non-zero) `ephemeralEOA` decrypt access on the resulting
    ///      balance handle per Rule 2.
    function _mintInternal(address to, euint64 amount, address ephemeralEOA) internal {
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], amount);
        } else {
            _balances[to] = amount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[to], ephemeralEOA);
        }

        if (Common.isInitialized(_encryptedTotalSupply)) {
            _encryptedTotalSupply = FHE.add(_encryptedTotalSupply, amount);
        } else {
            _encryptedTotalSupply = amount;
        }
        FHE.allowThis(_encryptedTotalSupply);

        emit Transfer(address(0), to);
    }

    /// @dev Burn `amount` mhUSDC from `from`. Caller must have already
    ///      validated `_balances[from]` is initialised.
    function _burnInternal(address from, euint64 amount, address ephemeralEOA) internal {
        _balances[from] = FHE.sub(_balances[from], amount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[from], ephemeralEOA);
        }

        _encryptedTotalSupply = FHE.sub(_encryptedTotalSupply, amount);
        FHE.allowThis(_encryptedTotalSupply);

        emit Transfer(from, address(0));
    }

    /// @dev Internal transfer with silent-fail bound on sender balance
    ///      per Rule 5. `ephemeralEOA == address(0)` is the legacy-shim
    ///      path: only kernel grants on both legs.
    function _doTransfer(
        address from,
        address to,
        euint64 amount,
        address ephemeralEOA
    ) internal returns (euint64 transferAmount) {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        // Silent-fail bound to sender balance (Rule 5).
        transferAmount = _silentFailBound(_balances[from], amount);

        // Update sender. Kernel grant always; ephemeralEOA grant if non-zero.
        _balances[from] = FHE.sub(_balances[from], transferAmount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[from], ephemeralEOA);
        }

        // Update recipient. Kernel grant always; ephemeralEOA grant if non-zero.
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], transferAmount);
        } else {
            _balances[to] = transferAmount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        if (ephemeralEOA != address(0)) {
            FHE.allow(_balances[to], ephemeralEOA);
        }

        // Grant the caller ACL on the silent-fail-bounded `transferAmount`
        // so downstream FHE ops (e.g. `FHE.eq(actualPaid, encCost)` for the
        // Phase 7.6 / ADR-NEW-1 share/cash silent-fail mirror in
        // `MuHavenSubscription` + `RedemptionQueue`) can read the handle.
        // Without this grant, contract callers of `transfer` / `transferFrom`
        // could not consume the silent-fail-bounded return at all.
        FHE.allow(transferAmount, msg.sender);

        emit Transfer(from, to);
    }
}
