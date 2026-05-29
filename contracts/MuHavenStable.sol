// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    FHE,
    euint64,
    ebool,
    InEuint64,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenStable} from "./interfaces/IMuHavenStable.sol";

// Extension interface for the deployed cofhe TaskManager.
//
// The npm-bundled cofhe-contracts 0.1.3 is stale relative to the GitHub
// master + the Arb Sepolia coprocessor: the legacy
// `ITaskManager.createDecryptTask(uint256,address)` selector 0x08289827 was
// removed and replaced with `allowForDecryption(uint256)` selector
// 0xa307d21d, but the npm package's ICofhe.sol was never republished.
// Verified empirically on 2026-05-29: the live TM impl (proxy
// 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9 → impl
// 0x803adbf341545ce1480781007ff018c9faafe1da) contains
// `allowForDecryption` in its dispatch table but NOT `createDecryptTask`.
// Calling the legacy selector falls through to the proxy fallback and
// reverts empty `0x` — the symptom that blocked the first
// `withdrawToUsdc` on the W3 cutover impl. Declared locally so we can call
// the canonical prod entrypoint without waiting for an npm bump.
interface IExtendedTaskManager {
    function allowForDecryption(uint256 ctHash) external;
}

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

    /// @notice Trusted-payer registry — addresses allowed to call
    ///         `trustedPayout` (ADR-046, Phase 8 Option B). Owner-managed
    ///         via `setTrustedPayer`. Currently the only registered payer
    ///         is the `YieldSnapshot` proxy, registered post-upgrade
    ///         via `scripts/grant-trusted-payer.ts`.
    mapping(address => bool) private _trustedPayer;

    // ── Direct USDC-exit state (Wave 5 W3) ───────────────────────────────
    // Appended in the gap (no reordering of prior slots). See the gap
    // accounting note below.

    /// @notice USDC reserve token paid out by `claimUsdc`. Set post-upgrade
    ///         by the owner via `setUsdcReserveToken` (address(0) until then).
    address public usdc;

    /// @notice Settlement kill-switch — when true, `claimUsdc` reverts
    ///         `ClaimsPaused`. Owner-toggled, separate from `paused` so USDC
    ///         outflow can be frozen in a reserve emergency without re-freezing
    ///         deposits/transfers. Packs into the `usdc` slot (address + bool).
    bool public claimsPaused;

    /// @dev Monotonic withdrawal-claim id counter. 1-indexed (first claim is
    ///      id 1); 0 means "no claim". Claims are keyed by this id — NOT the
    ///      burned ciphertext handle, which is content-addressed/deterministic
    ///      (a pure function of operand handles + opcode) and can collide
    ///      across identical burns. A handle key would silently drop the second
    ///      burn → fund loss; the per-id key makes every request independent.
    uint256 private _nextWithdrawClaimId;

    /// @dev Pending/settled direct-withdrawal claims, keyed by `claimId`.
    mapping(uint256 => WithdrawClaim) private _withdrawClaims;

    /// @dev Per-account list of pending claim ids (settled ids are
    ///      swap-and-popped). Bounded by `MAX_PENDING_WITHDRAWALS`. Powers
    ///      `getUserWithdrawClaims` so a returning frontend can re-discover
    ///      in-flight withdrawals.
    mapping(address => uint256[]) private _userWithdrawClaims;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Named slots:
    ///      9 pre-W3 + W3's 4 new slots ([usdc|claimsPaused] packed into one
    ///      slot, _nextWithdrawClaimId, _withdrawClaims, _userWithdrawClaims) →
    ///      reserve 37 to keep ~50 own slots, matching the `MuHavenSubscription`
    ///      / `TokenRegistry` convention. History: Phase 8 Option B (ADR-046)
    ///      added `_trustedPayer` (42→41). Wave 5 W3 added the 4 direct-USDC
    ///      slots (41→37). Every prior slot's index is preserved (validated via
    ///      OZ `validateUpgrade` against the deployed impl).
    uint256[37] private __gap;

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

    /// @dev Wave 5 W3 Phase 9 — `unwrap(address to, uint64 amount)` selector
    ///      on the legacy PUSDC (the confidential→public exit's request leg).
    ///      Used by `recoverStrandedPusdcStart` to redeem this contract's own
    ///      stranded PUSDC back into USDC. The exact selector of the deployed
    ///      legacy contract MUST be probed on-chain before the prod recovery
    ///      broadcast — see `W3_PHASE_9_RECOVERY_RUNBOOK.md` (the recovery
    ///      script's VERIFY_ONLY mode does this). A wrong selector loud-fails
    ///      `RecoverFailed`; it never silently mis-pays.
    bytes4 private constant _LEGACY_UNWRAP_ADDRESS_UINT64 =
        bytes4(keccak256("unwrap(address,uint64)"));

    /// @dev Wave 5 W3 Phase 9 — `claimUnwrapped(uint256)` selector on the
    ///      legacy PUSDC (the confidential→public exit's claim leg). Used by
    ///      `recoverStrandedPusdcClaim`.
    bytes4 private constant _LEGACY_CLAIM_UNWRAPPED =
        bytes4(keccak256("claimUnwrapped(uint256)"));

    /// @notice Wave 5 W3 — max simultaneously-pending withdrawal claims per
    ///         account. Bounds `_userWithdrawClaims` growth + the
    ///         `_removeUserClaim` linear scan (anti-griefing / gas-DoS).
    uint256 public constant MAX_PENDING_WITHDRAWALS = 64;

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

        // Phase 9.A · Option Z — grant decrypt ACL on the amount handle to
        // the caller's kernel + active session. The handle is emitted in
        // the `Wrap` event below for off-chain audit indexing; without
        // these grants it would be unreadable to its rightful owner.
        FHE.allow(amount, msg.sender);
        FHE.allow(amount, ephemeralEOA);

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

        // Phase 9.A · Option Z — symmetric ACL grants with the EOA `wrap`
        // path. The msg.sender grant is a no-op for contract callers that
        // already hold ACL, but it keeps the audit-event handle decryptable
        // when the caller is itself a user-facing surface. Skip the
        // ephemeral grant when callers pass `address(0)` (e.g. Treasury
        // contract callers without a decrypt path).
        FHE.allow(amount, msg.sender);
        if (ephemeralEOA != address(0)) {
            FHE.allow(amount, ephemeralEOA);
        }

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
        emit Wrap(from, ephemeralEOA, amount);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Wave 5 W3 Phase 9 — direct USDC → mhUSDC. Pulls cleartext USDC
    ///      into this contract (auto-counts as `usdcReserveBalance()`) and
    ///      mints `amount` of trivially-encrypted mhUSDC. Makes the reserve
    ///      circular: wraps grow it, withdraws drain it, no legacy PUSDC
    ///      accumulates for new deposits. CEI: `safeTransferFrom` is the only
    ///      external call (USDC = canonical, non-reentrant token);
    ///      `nonReentrant` is belt-and-suspenders.
    function wrapUsdc(uint256 amount, address ephemeralEOA)
        external
        whenNotPaused
        nonReentrant
    {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (usdc == address(0)) revert UsdcReserveNotSet();
        if (amount == 0) revert ZeroAmount();
        // mhUSDC `_balances` is euint64; a USDC inflow above type(uint64).max
        // can't be represented — loud-revert rather than silently truncate
        // (a truncation would mint less mhUSDC than the USDC pulled).
        if (amount > type(uint64).max) revert AmountOverflowsUint64();

        // Pull USDC from caller → this contract's reserve.
        SafeERC20.safeTransferFrom(IERC20(usdc), msg.sender, address(this), amount);

        // Trivially-encrypt the public amount as euint64 and mint mhUSDC.
        // `FHE.asEuint64(uint256)` returns a trivially-encrypted handle: the
        // value is public (already exposed by the SafeERC20 Transfer event)
        // but the handle is FHE-compatible so downstream balance arithmetic
        // (FHE.add / FHE.sub / FHE.allow) works. `amount` is bounded to
        // uint64 above, so no truncation occurs.
        euint64 amountEnc = FHE.asEuint64(amount);
        FHE.allowThis(amountEnc);
        FHE.allow(amountEnc, msg.sender);
        FHE.allow(amountEnc, ephemeralEOA);

        _mintInternal(msg.sender, amountEnc, ephemeralEOA);
        emit WrapUsdc(msg.sender, ephemeralEOA, amount, amountEnc);
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

        // Phase 9.A · Option Z — grant decrypt ACL on the silent-fail-
        // bounded `actual` handle to the caller's kernel + active session
        // so the amount carried in the `Unwrap` event below is auditable.
        FHE.allow(actual, msg.sender);
        FHE.allow(actual, ephemeralEOA);

        (bool ok, ) = legacyPusdc.call(
            abi.encodeWithSelector(
                _LEGACY_TRANSFER_UINT256,
                msg.sender,
                uint256(euint64.unwrap(actual))
            )
        );
        if (!ok) revert UnwrapFailed();

        emit Unwrap(msg.sender, ephemeralEOA, actual);
    }

    // ── Direct USDC exit (Wave 5 W3 — two-phase async, no PUSDC) ─────────
    //
    // mhUSDC balances are encrypted, so releasing a PUBLIC USDC amount can't
    // be synchronous — we must decrypt the burned amount first (CoFHE async).
    // Phase 1 (`withdrawToUsdc`): burn + request decrypt + record claim.
    // Phase 2 (`claimUsdc`): once the coprocessor result is ready, pay USDC
    // from the contract's reserve. PUSDC never enters the user's path; the
    // PUSDC that backed the burned mhUSDC stays in the contract (the reserve
    // is funded separately by the owner — see the W3 reserve-model ADR).

    /// @inheritdoc IMuHavenStable
    /// @dev Clamp-to-balance via `FHE.min` (NOT `unwrap`'s select-to-zero), so
    ///      an over-request withdraws the FULL balance and "withdraw all" works
    ///      with a deliberately-large amount. No external call on this leg (the
    ///      USDC transfer is in `claimUsdc`), so the request is reentrancy-free
    ///      by construction; `nonReentrant` is belt-and-suspenders.
    ///
    ///      Claims are keyed by a monotonic `claimId`, NOT the burned ciphertext
    ///      handle: CoFHE handles are content-addressed/deterministic, so two
    ///      identical burns share a handle. Each still gets a distinct claimId
    ///      backed by its own burn, so each settles exactly once (total burned ==
    ///      total paid). The stored `handle` is what `claimUsdc` decrypts.
    function withdrawToUsdc(InEuint64 calldata encAmount, address ephemeralEOA)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 claimId)
    {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (usdc == address(0)) revert UsdcReserveNotSet();
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();
        if (_userWithdrawClaims[msg.sender].length >= MAX_PENDING_WITHDRAWALS) {
            revert TooManyPendingWithdrawals();
        }

        euint64 requested = FHE.asEuint64(encAmount);
        FHE.allowThis(requested);

        // Clamp to available balance (sell-what-you-have).
        euint64 burnAmount = FHE.min(_balances[msg.sender], requested);
        FHE.allowThis(burnAmount);

        // Burn from caller — decrements balance + _encryptedTotalSupply, grants
        // caller + eph decrypt on the new balance handle, emits Transfer→0.
        _burnInternal(msg.sender, burnAmount, ephemeralEOA);

        // Make the burned amount decryptable (audit) + request async decrypt.
        FHE.allow(burnAmount, msg.sender);
        FHE.allow(burnAmount, ephemeralEOA);
        bytes32 handle = euint64.unwrap(burnAmount);

        // Request asynchronous decryption.
        //
        // Production cofhe TaskManager on Arb Sepolia exposes only
        // `allowForDecryption(uint256)` (selector 0xa307d21d). The legacy
        // `createDecryptTask(uint256,address)` selector (0x08289827) is no
        // longer in the deployed TM dispatch table — npm
        // `@fhenixprotocol/cofhe-contracts@0.1.3`'s `ITaskManager` still
        // declares it (stale relative to the GitHub master + the on-chain
        // coprocessor), so a direct call from this contract reverts empty
        // `0x` on prod.
        //
        // Local `@cofhe/mock-contracts@0.5.1` ships BOTH selectors. Only
        // `createDecryptTask` auto-publishes a deterministic mock decrypt
        // result (set `_decryptResultReadyTimestamp[ctHash] = now + 1..10s`),
        // which is what test helpers' `waitForDecrypt() → time.increase(11)`
        // depends on. `allowForDecryption` on the mock only grants ACL.
        //
        // Call both:
        //   - `createDecryptTask` first, wrapped in try/catch. Mock: succeeds
        //     + auto-publishes; tests keep working unchanged. Prod: reverts
        //     `0x` (selector absent), caught + ignored.
        //   - `allowForDecryption` always. Mock: redundant ACL grant.
        //     Prod: the canonical entrypoint that signals the cofhe decrypt
        //     network to pick up `handle` and `publishDecryptResult` it.
        try ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(uint256(handle), msg.sender) {
            // mock path: auto-publishes a decrypt result.
        } catch {
            // prod path: `createDecryptTask` selector not on the deployed TM.
            // Real decrypt request flows through `allowForDecryption` below.
        }
        IExtendedTaskManager(TASK_MANAGER_ADDRESS).allowForDecryption(uint256(handle));

        // Record the pending claim under a fresh monotonic id (1-indexed).
        claimId = ++_nextWithdrawClaimId;
        _withdrawClaims[claimId] = WithdrawClaim({
            to: msg.sender,
            handle: handle,
            amount: 0,
            claimed: false
        });
        _userWithdrawClaims[msg.sender].push(claimId);

        emit WithdrawRequested(msg.sender, ephemeralEOA, claimId, handle);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Permissionless settle (pays the recorded recipient, not the
    ///      caller). CEI: the reserve check + state effects run before the
    ///      external `safeTransfer`. A short reserve reverts WITHOUT marking
    ///      the claim settled, so it stays pending and is retriable after the
    ///      owner tops up the reserve. The settled struct is retained (only
    ///      pruned from the user list) so a replayed claimId always hits the
    ///      `claimed` guard.
    function claimUsdc(uint256 claimId) external nonReentrant {
        if (claimsPaused) revert ClaimsPaused();
        WithdrawClaim memory c = _withdrawClaims[claimId];
        if (c.to == address(0)) revert WithdrawClaimNotFound();
        if (c.claimed) revert WithdrawClaimAlreadyClaimed();

        (uint64 amount, bool ready) = FHE.getDecryptResultSafe(euint64.wrap(c.handle));
        if (!ready) revert WithdrawClaimNotReady();

        // Reserve sufficiency BEFORE effects so a shortfall leaves the claim
        // pending (retriable) rather than consuming it.
        if (amount > 0 && IERC20(usdc).balanceOf(address(this)) < amount) {
            revert ReserveInsufficient();
        }

        // Effects: settle + prune from the user list.
        _withdrawClaims[claimId].claimed = true;
        _withdrawClaims[claimId].amount = amount;
        _removeUserClaim(c.to, claimId);

        // Interaction: 1:1 mhUSDC→USDC (both 6-dp). A zero-amount claim (e.g.
        // a clamp on a zero balance) settles as a state-only no-op.
        if (amount > 0) {
            SafeERC20.safeTransfer(IERC20(usdc), c.to, amount);
        }

        emit WithdrawClaimed(c.to, claimId, amount);
    }

    /// @dev Swap-and-pop `claimId` out of `account`'s pending-claim list.
    ///      No-op if absent (already pruned). Bounded by MAX_PENDING_WITHDRAWALS.
    function _removeUserClaim(address account, uint256 claimId) internal {
        uint256[] storage list = _userWithdrawClaims[account];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == claimId) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
    }

    // ── Direct USDC exit — reserve admin + views (Wave 5 W3) ─────────────

    /// @inheritdoc IMuHavenStable
    /// @dev Wave 5 W3 Phase 9 (SecEng M-01) — enforce `decimals() == 6` on the
    ///      reserve token. The 1:1 conversion (`wrapUsdc` mint + `claimUsdc`
    ///      payout) treats the raw integer amount as both USDC and mhUSDC base
    ///      units; a non-6-dp reserve token would mint/pay at the wrong scale.
    ///      Phase 9's `wrapUsdc` newly couples the MINT rate to this setter
    ///      (pre-Phase-9 the reserve only paid out), so the guard is on-chain
    ///      defense-in-depth above the seed script's off-chain canonical-USDC
    ///      allowlist. A token without `decimals()` (EOA / non-ERC20) also
    ///      reverts here.
    function setUsdcReserveToken(address usdc_) external onlyOwner {
        if (usdc_ == address(0)) revert ZeroAddress();
        // Low-level staticcall (not a high-level `try`) so the no-code / EOA /
        // non-ERC20 case ALSO yields the clean custom error: a high-level call
        // to a code-less address reverts via Solidity's pre-call extcodesize
        // check OUTSIDE try/catch, giving an opaque revert. The staticcall
        // returns ok=true with empty data for a code-less target, which
        // `data.length < 32` catches.
        (bool ok, bytes memory data) =
            usdc_.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (!ok || data.length < 32) revert ReserveTokenDecimalsMismatch();
        if (abi.decode(data, (uint8)) != 6) revert ReserveTokenDecimalsMismatch();
        usdc = usdc_;
        emit UsdcReserveTokenSet(usdc_);
    }

    /// @inheritdoc IMuHavenStable
    function fundUsdcReserve(uint256 amount) external onlyOwner {
        if (usdc == address(0)) revert UsdcReserveNotSet();
        SafeERC20.safeTransferFrom(IERC20(usdc), msg.sender, address(this), amount);
        emit UsdcReserveFunded(msg.sender, amount);
    }

    /// @inheritdoc IMuHavenStable
    function withdrawUsdcReserve(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (usdc == address(0)) revert UsdcReserveNotSet();
        SafeERC20.safeTransfer(IERC20(usdc), to, amount);
        emit UsdcReserveWithdrawn(to, amount);
    }

    /// @inheritdoc IMuHavenStable
    function setClaimsPaused(bool paused_) external onlyOwner {
        claimsPaused = paused_;
        emit ClaimsPausedSet(paused_);
    }

    /// @inheritdoc IMuHavenStable
    function usdcReserveBalance() external view returns (uint256) {
        return usdc == address(0) ? 0 : IERC20(usdc).balanceOf(address(this));
    }

    /// @inheritdoc IMuHavenStable
    function getWithdrawClaim(uint256 claimId) external view returns (WithdrawClaim memory) {
        return _withdrawClaims[claimId];
    }

    /// @inheritdoc IMuHavenStable
    function getUserWithdrawClaims(address account) external view returns (uint256[] memory) {
        return _userWithdrawClaims[account];
    }

    /// @inheritdoc IMuHavenStable
    function withdrawDecryptResult(uint256 claimId)
        external
        view
        returns (uint64 amount, bool ready)
    {
        bytes32 handle = _withdrawClaims[claimId].handle;
        if (_withdrawClaims[claimId].to == address(0)) return (0, false);
        return FHE.getDecryptResultSafe(euint64.wrap(handle));
    }

    // ── Stranded-PUSDC recovery (Wave 5 W3 Phase 9 — owner-only) ─────────
    //
    // Every W3 withdraw (`withdrawToUsdc` → `claimUsdc`) burns mhUSDC and pays
    // USDC from the reserve, but the legacy PUSDC that originally backed that
    // mhUSDC stays inside this contract forever ("stranded PUSDC"). These two
    // owner-only entrypoints let this contract redeem its own stranded PUSDC
    // back into USDC via the legacy PUSDC's two-phase async unwrap, replenishing
    // the reserve. Occasional operator op; no automation, no frontend surface.
    // Phase 9's `wrapUsdc` + this recovery together supersede the
    // ADR_W3_RESERVE_MODEL.md "one-way drain" + "stranded PUSDC" subsections.

    /// @inheritdoc IMuHavenStable
    /// @dev Owner-only. `whenNotPaused` (wrapper kill-switch) blocks it;
    ///      `claimsPaused` (W3 user-settlement kill-switch) does NOT — recovery
    ///      tops the reserve UP, the opposite of a user outflow. The legacy
    ///      PUSDC contract is the only external call; `nonReentrant` guards it.
    ///      A wrong/absent legacy selector loud-fails `RecoverFailed` — it
    ///      never silently mis-pays (no funds move on this leg; USDC arrives on
    ///      the claim leg).
    function recoverStrandedPusdcStart(uint64 amount)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
        returns (uint256 legacyClaimId)
    {
        if (usdc == address(0)) revert UsdcReserveNotSet();
        if (amount == 0) revert ZeroAmount();

        // Call legacyPusdc.unwrap(address(this), amount). The recovered USDC
        // lands here on the claim leg; the legacy contract returns a uint256
        // claim id we capture from the return data.
        (bool ok, bytes memory ret) = legacyPusdc.call(
            abi.encodeWithSelector(
                _LEGACY_UNWRAP_ADDRESS_UINT64,
                address(this),
                amount
            )
        );
        if (!ok || ret.length < 32) revert RecoverFailed();
        legacyClaimId = abi.decode(ret, (uint256));
        emit StrandedPusdcRecoveryStarted(amount, legacyClaimId);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Owner-only. Finalizes a started recovery via
    ///      `legacyPusdc.claimUnwrapped(legacyClaimId)`. The recovered USDC
    ///      lands in this contract and auto-counts as the reserve. Surfaces a
    ///      legacy revert (claim not ready / already claimed / wrong id) as
    ///      `RecoverClaimFailed`.
    function recoverStrandedPusdcClaim(uint256 legacyClaimId)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        (bool ok, ) = legacyPusdc.call(
            abi.encodeWithSelector(_LEGACY_CLAIM_UNWRAPPED, legacyClaimId)
        );
        if (!ok) revert RecoverClaimFailed();
        emit StrandedPusdcRecoveryClaimed(legacyClaimId);
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

        return _doTransfer(msg.sender, to, amount, ephemeralEOA, ephemeralEOA);
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

        return _doTransfer(msg.sender, to, encAmount, ephemeralEOA, ephemeralEOA);
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

        return _doTransfer(from, to, amount, ephemeralEOA, ephemeralEOA);
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

        return _doTransfer(from, to, encAmount, ephemeralEOA, ephemeralEOA);
    }

    /// @inheritdoc IMuHavenStable
    /// @dev Phase 7.6-E / ADR-044 split-grant variant. Either `fromEph` or
    ///      `toEph` may be `address(0)` to suppress that leg's grant; the
    ///      other side must be non-zero (rejecting `(0, 0)` blocks an
    ///      accidental call that would lose the session's decrypt access on
    ///      both legs). The 4-arg overload delegates here with `eph, eph`,
    ///      preserving the original Phase 7.5-A both-leg P2P behavior.
    function transferFrom(
        address from,
        address to,
        euint64 encAmount,
        address fromEph,
        address toEph
    ) external whenNotPaused returns (euint64 actualTransferred) {
        if (fromEph == address(0) && toEph == address(0)) revert InvalidEphemeralEOA();
        if (to == address(0)) revert ZeroAddress();
        _requireOperator(from, msg.sender);

        FHE.allowThis(encAmount);

        return _doTransfer(from, to, encAmount, fromEph, toEph);
    }

    // ── Trusted-payer payout (Phase 8 Option B / ADR-046) ──────────────

    /// @inheritdoc IMuHavenStable
    /// @dev Bypasses `_silentFailBound`. Total wrapper-side FHE op count:
    ///        - sender: `FHE.sub(_balances[from], encAmount)` — 1 op
    ///        - recipient: `FHE.add(_balances[to], encAmount)` — 1 op
    ///      vs `_doTransfer`'s 5 ops (lte + trivialEncrypt + select +
    ///      sub + add). Combined with `claimYield`'s pre-call ops
    ///      (mul + cast + sub on `_encRemaining` = 3 ops), the total
    ///      FHE chain in a yield-claim tx drops from 8 → 5.
    ///
    ///      Caller (`msg.sender`) must hold ACL on `encAmount` so the
    ///      wrapper can `FHE.allowThis` it (matches the requirement on
    ///      `transferFrom`'s on-chain-handle overload). Same kernel-only
    ///      ACL grant on the sender (caller's float — operationally
    ///      private) + kernel + ephemeralEOA grants on the recipient.
    ///
    ///      No silent-fail bound: `FHE.sub` on insufficient sender balance
    ///      underflows silently in legacy FHE u64 arithmetic, producing
    ///      a corrupt encrypted handle. The trusted caller is responsible
    ///      for not over-spending; per-epoch conservation in
    ///      `YieldSnapshot` guarantees this for the `claimYield` path.
    ///      A future Fix B contract change (`PHASE8_FIX_B_DRAFT.md`)
    ///      adds a loud-revert on `fundEpoch` shortfall to close the
    ///      conditional ("snapshot float is exactly enough" requires
    ///      "fundEpoch wasn't itself silent-failed").
    function trustedPayout(
        address to,
        euint64 encAmount,
        address ephemeralEOA
    ) external whenNotPaused returns (euint64) {
        if (!_trustedPayer[msg.sender]) revert NotTrustedPayer();
        if (to == address(0)) revert ZeroAddress();
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();

        FHE.allowThis(encAmount);

        // Sender (caller's float) — kernel-only ACL grant. No eph leak.
        _balances[msg.sender] = FHE.sub(_balances[msg.sender], encAmount);
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        // Recipient — kernel + ephemeralEOA grant (split-grant pattern).
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], encAmount);
        } else {
            _balances[to] = encAmount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        FHE.allow(_balances[to], ephemeralEOA);

        // Caller may consume `encAmount` for downstream FHE ops. Matches
        // `_doTransfer`'s caller-side grant on the silent-fail-bounded
        // return — kept for symmetry even though `claimYield` doesn't
        // currently consume the return value.
        FHE.allow(encAmount, msg.sender);

        emit Transfer(msg.sender, to);
        return encAmount;
    }

    /// @inheritdoc IMuHavenStable
    function setTrustedPayer(address payer, bool allowed) external onlyOwner {
        if (payer == address(0)) revert ZeroAddress();
        _trustedPayer[payer] = allowed;
        emit TrustedPayerSet(payer, allowed);
    }

    /// @inheritdoc IMuHavenStable
    function isTrustedPayer(address payer) external view returns (bool) {
        return _trustedPayer[payer];
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
        return _doTransfer(msg.sender, to, amount, address(0), address(0));
    }

    /// @notice Legacy `confidentialTransfer(address,euint64)` shim.
    function confidentialTransfer(
        address to,
        euint64 value
    ) external whenNotPaused returns (euint64) {
        if (to == address(0)) revert ZeroAddress();
        FHE.allowThis(value);
        return _doTransfer(msg.sender, to, value, address(0), address(0));
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
        euint64 result = _doTransfer(msg.sender, to, amount, address(0), address(0));
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
        return _doTransfer(from, to, amount, address(0), address(0));
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
        return _doTransfer(from, to, value, address(0), address(0));
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
        euint64 result = _doTransfer(from, to, amount, address(0), address(0));
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

    /// @inheritdoc IMuHavenStable
    /// @dev The contract-side ACL on `handle` was stamped via
    ///      `FHE.allowThis(amount)` at wrap/unwrap time and is durable —
    ///      so this contract can call `FHE.allow(handle, eph)` even though
    ///      the originating tx finished long ago. The auth gate is
    ///      `FHE.isAllowed(handle, msg.sender)`: only callers whose ACL
    ///      survives on-chain (i.e. the original kernel that the wrap
    ///      granted to via `FHE.allow(amount, msg.sender)`) can re-grant.
    ///      Strangers passing in someone else's audit handle bounce here.
    function refreshAuditGrant(euint64 handle, address ephemeralEOA) external {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!FHE.isAllowed(handle, msg.sender)) revert NotAuditHandleOwner();
        FHE.allow(handle, ephemeralEOA);
        emit AuditGrantRefreshed(msg.sender, ephemeralEOA, handle);
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
    ///      per Rule 5. Per-leg ephemeralEOA grants per Phase 7.6-E /
    ///      ADR-044:
    ///        - `fromEph != address(0)` → grant on sender's new balance
    ///        - `toEph   != address(0)` → grant on recipient's new balance
    ///      Both `address(0)` is the legacy-shim path: only kernel grants
    ///      on both legs (matches pre-Phase-7.6-E legacy PUSDC UX).
    ///
    ///      The 4-arg public surface delegates here with `eph, eph`,
    ///      preserving the original Phase 7.5-A both-leg P2P behavior. The
    ///      5-arg public surface (`transferFrom(from, to, amount, fromEph,
    ///      toEph)`) lets contract callers (`MuHavenSubscription`,
    ///      `RedemptionQueue`) suppress the counterparty's grant — the
    ///      audit-prep §A-9 fix.
    function _doTransfer(
        address from,
        address to,
        euint64 amount,
        address fromEph,
        address toEph
    ) internal returns (euint64 transferAmount) {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        // Silent-fail bound to sender balance (Rule 5).
        transferAmount = _silentFailBound(_balances[from], amount);

        // Update sender. Kernel grant always; fromEph grant if non-zero.
        _balances[from] = FHE.sub(_balances[from], transferAmount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        if (fromEph != address(0)) {
            FHE.allow(_balances[from], fromEph);
        }

        // Update recipient. Kernel grant always; toEph grant if non-zero.
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], transferAmount);
        } else {
            _balances[to] = transferAmount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        if (toEph != address(0)) {
            FHE.allow(_balances[to], toEph);
        }

        // Grant the caller ACL on the silent-fail-bounded `transferAmount`
        // so downstream FHE ops (e.g. `FHE.eq(actualPaid, encCost)` for the
        // Phase 7.6 / ADR-043 share/cash silent-fail mirror in
        // `MuHavenSubscription` + `RedemptionQueue`) can read the handle.
        // Without this grant, contract callers of `transfer` / `transferFrom`
        // could not consume the silent-fail-bounded return at all.
        FHE.allow(transferAmount, msg.sender);

        emit Transfer(from, to);
    }
}
