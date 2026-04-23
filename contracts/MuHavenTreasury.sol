// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    euint128,
    ebool,
    InEuint128,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "./interfaces/IFHERC20.sol";
import {IMuHavenTreasury} from "./interfaces/IMuHavenTreasury.sol";

/// @title MuHavenTreasury
/// @notice Per-token PUSDC float custodian per ADR-002. One treasury per
///         RWA token. Holds the confidential PUSDC backing redemptions and
///         grants operator rights to the bound `MuHavenSubscription` and
///         `RedemptionQueue` so they can pull PUSDC for investor pay-outs.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Wiring (locked at `initialize`, immutable thereafter):
///   - `token` / `subscription` / `queue` / `pusdc` — stored once.
///   - PUSDC operator rights for `subscription` and `queue` are granted
///     during `initialize` via `setOperator(*, type(uint48).max)` and never
///     revoked. Per ADR-002 this is the per-token solvency-isolation guarantee.
///   - `issuer` is rotatable via owner-only `setIssuer`.
///   - `owner` is rotatable via `transferOwnership`.
///
///   Hot-path semantics:
///   - `deposit(encAmount)` is a **pure event marker** per the interface
///     natspec ("issuer deposits PUSDC directly"). The issuer transfers PUSDC
///     to this treasury out-of-band via `pusdc.confidentialTransfer(treasury,
///     amount)`; calling `deposit()` here only emits `TreasuryDeposited` for
///     analytics. The `encAmount` calldata is intentionally not consumed —
///     skipping the proof-validation cost — because the event is unauthenticated
///     and the issuer is a trusted role.
///   - `withdraw(encAmount)` performs the actual PUSDC transfer back to the
///     issuer, bounded by the cleartext `minFloat` solvency floor. Per
///     `FHE_ACL_CONVENTIONS.md` Rule 5 the bounding is **silent-fail via
///     `FHE.select`** (not a `revert`): the comparison runs on the encrypted
///     PUSDC balance, and reverting on an encrypted condition would leak
///     the comparison outcome via gas. The interface still declares
///     `error BelowMinFloat()` for ABI stability — it is intentionally
///     never raised in Wave 3.5 (see ADR-029).
///
///   Visibility:
///   - `getFloat()` returns `0` as a Wave 3.5 placeholder. The authoritative
///     float lives in `pusdc.confidentialBalanceOf(this)` — an `euint64` that
///     cannot be projected to cleartext synchronously inside a `view`. A
///     follow-up async-decrypt cache will populate `getFloat()` once the
///     NAV writer cron supports it (ADR-029, deferred).
///   - `getMinFloat()` returns the cleartext floor — public.
///
///   PUSDC ABI handling per ADR-008: the deployed pre-v0.1.0
///   `ConfidentialUSDC` uses the `confidentialTransfer(address,uint256)`
///   selector (legacy `euint64 = uint256` ABI). We invoke it via low-level
///   `call` with the pre-computed selector, mirroring `MuHavenEscrow._pay`
///   and `YieldDistributor._forwardYieldToEscrow`. When PUSDC redeploys
///   against `cofhe-contracts ≥ v0.1.0` the constants here and in the other
///   PUSDC callers retire together (ADR-008 exit criteria).
contract MuHavenTreasury is Initializable, ReentrancyGuardTransient, IMuHavenTreasury {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Bound RWA token — immutable post-init.
    address public token;

    /// @notice Bound `MuHavenSubscription` — immutable post-init.
    address public subscription;

    /// @notice Bound `RedemptionQueue` — immutable post-init.
    address public queue;

    /// @notice PUSDC contract address — immutable post-init.
    address public pusdc;

    /// @notice Rotatable governance address (multi-sig). Holds rights to
    ///         rotate the issuer and transfer ownership.
    address public owner;

    /// @notice Rotatable issuer (deposit/withdraw + minFloat tuning).
    address public issuer;

    /// @notice Cleartext solvency floor in PUSDC base units.
    uint256 public minFloat;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Seven slots
    ///      consumed above; 43 reserved so the contract's own-storage footprint
    ///      totals 50, matching the convention used by `IssuerControlledOracle`
    ///      and `TokenRegistry`. Natural candidate for the reserve: the
    ///      cleartext-float async-decrypt cache deferred via ADR-029.
    uint256[43] private __gap;

    // ── Constants ────────────────────────────────────────────────────────

    /// @dev Selector for `confidentialTransfer(address,uint256)` — legacy
    ///      pre-v0.1.0 ConfidentialUSDC ABI per ADR-008. Pre-computed to
    ///      avoid runtime keccak256 on every withdraw.
    bytes4 private constant _TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    // ── Errors (additive to interface) ───────────────────────────────────

    error PaymentTransferFailed();

    // ── Events (additive to interface) ───────────────────────────────────

    event TreasuryInitialized(
        address indexed token,
        address indexed subscription,
        address indexed queue,
        address pusdc,
        address issuer,
        address owner,
        uint256 minFloat
    );

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @dev Grants immutable PUSDC operator rights to `subscription_` and
    ///      `queue_` per ADR-002; these are never revoked from this contract.
    /// @param token_         Bound RWA token address.
    /// @param subscription_  Bound `MuHavenSubscription`.
    /// @param queue_         Bound `RedemptionQueue`.
    /// @param issuer_        Initial issuer (rotatable later via `setIssuer`).
    /// @param pusdc_         PUSDC (ConfidentialUSDC) address.
    /// @param minFloat_      Initial cleartext solvency floor.
    /// @param owner_         Initial governance address (rotatable via
    ///                       `transferOwnership`).
    function initialize(
        address token_,
        address subscription_,
        address queue_,
        address issuer_,
        address pusdc_,
        uint256 minFloat_,
        address owner_
    ) external initializer {
        if (
            token_ == address(0) ||
            subscription_ == address(0) ||
            queue_ == address(0) ||
            issuer_ == address(0) ||
            pusdc_ == address(0) ||
            owner_ == address(0)
        ) revert ZeroAddress();

        token = token_;
        subscription = subscription_;
        queue = queue_;
        issuer = issuer_;
        pusdc = pusdc_;
        owner = owner_;
        minFloat = minFloat_;

        // Immutable operator grants for redemption pulls (ADR-002).
        IFHERC20(pusdc_).setOperator(subscription_, type(uint48).max);
        IFHERC20(pusdc_).setOperator(queue_, type(uint48).max);

        emit TreasuryInitialized(
            token_,
            subscription_,
            queue_,
            pusdc_,
            issuer_,
            owner_,
            minFloat_
        );
        emit MinFloatUpdated(minFloat_);
    }

    // ── Issuer hot path ──────────────────────────────────────────────────

    /// @inheritdoc IMuHavenTreasury
    /// @dev Pure event marker — see contract-level natspec. The `encAmount`
    ///      calldata is intentionally not validated (no `FHE.asEuint128` call)
    ///      because the issuer is trusted and validating costs gas with no
    ///      on-chain consumer.
    function deposit(InEuint128 calldata /* encAmount */) external onlyIssuer {
        emit TreasuryDeposited(msg.sender);
    }

    /// @inheritdoc IMuHavenTreasury
    /// @dev Silent-fail solvency floor per `FHE_ACL_CONVENTIONS.md` Rule 5
    ///      (and ADR-029 for the divergence from the natspec's
    ///      "Reverts with `BelowMinFloat`" wording). The actual amount paid
    ///      is bounded by `max(0, currentFloat - minFloat)`; observers cannot
    ///      distinguish a fully-funded withdraw from a silently-truncated one
    ///      via gas. Issuer monitors actual transfer via PUSDC events.
    function withdraw(InEuint128 calldata encAmount) external onlyIssuer nonReentrant {
        // Validate the proof + materialise the encrypted requested amount.
        euint128 enc128 = FHE.asEuint128(encAmount);
        FHE.allowThis(enc128);

        // Narrow to PUSDC's native width (`euint64`). PUSDC max balance is
        // ~1.8e19 base units (≪ 2^64-1) — truncation is unreachable in any
        // realistic float; documented as a Wave 3.5 invariant.
        euint64 requested = FHE.asEuint64(enc128);
        FHE.allowThis(requested);

        // Trivial encrypted zero — re-used as the silent-fail target and the
        // empty-treasury fallback float.
        euint64 zero = FHE.asEuint64(uint256(0));
        FHE.allowThis(zero);

        // Read the authoritative PUSDC float. PUSDC grants `FHE.allow` to
        // recipients on `_doTransfer`, so this contract has ACL access on its
        // own balance handle once any prior deposit has landed. If the float
        // is uninitialised (treasury never received PUSDC) the transfer leg
        // is short-circuited below — calling `confidentialTransfer` from an
        // uninitialised sender reverts in PUSDC's `_doTransfer` (`NoBalance`)
        // even with a zero amount, breaking silent-fail semantics. The
        // initialised/uninitialised status is already public on-chain (balance
        // handle existence is observable), so the cleartext branch here adds
        // no privacy leakage beyond that baseline.
        euint64 currentFloatRaw = IFHERC20(pusdc).confidentialBalanceOf(address(this));
        bool floatInitialized = Common.isInitialized(currentFloatRaw);
        euint64 currentFloat = floatInitialized ? currentFloatRaw : zero;
        FHE.allowThis(currentFloat);

        // Cleartext minFloat → encrypted handle for the bound check.
        euint64 minFloatEnc = FHE.asEuint64(minFloat);
        FHE.allowThis(minFloatEnc);

        // maxWithdraw = (currentFloat >= minFloat) ? currentFloat - minFloat : 0
        ebool floorOk = FHE.gte(currentFloat, minFloatEnc);
        FHE.allowThis(floorOk);
        euint64 spread = FHE.sub(currentFloat, minFloatEnc);
        FHE.allowThis(spread);
        euint64 maxWithdraw = FHE.select(floorOk, spread, zero);
        FHE.allowThis(maxWithdraw);

        // actual = (requested <= maxWithdraw) ? requested : 0
        ebool withinFloor = FHE.lte(requested, maxWithdraw);
        FHE.allowThis(withinFloor);
        euint64 actual = FHE.select(withinFloor, requested, zero);
        FHE.allowThis(actual);

        // Send via legacy uint256 selector per ADR-008. PUSDC needs ACL on
        // the handle to run its internal `FHE.sub`/`FHE.add` on balances.
        // Skip the transfer when the treasury float is uninitialised — the
        // PUSDC mock + production both revert on a zero-balance sender even
        // for a zero-amount transfer; silent-fail must short-circuit here.
        if (floatInitialized) {
            FHE.allow(actual, pusdc);
            (bool ok, ) = pusdc.call(
                abi.encodeWithSelector(
                    _TRANSFER_UINT256,
                    msg.sender,
                    uint256(euint64.unwrap(actual))
                )
            );
            if (!ok) revert PaymentTransferFailed();
        }

        emit TreasuryWithdrawn(msg.sender);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenTreasury
    function setMinFloat(uint256 newMin) external onlyIssuer {
        minFloat = newMin;
        emit MinFloatUpdated(newMin);
    }

    /// @inheritdoc IMuHavenTreasury
    function setIssuer(address newIssuer) external onlyOwner {
        if (newIssuer == address(0)) revert ZeroAddress();
        address oldIssuer = issuer;
        issuer = newIssuer;
        emit IssuerUpdated(oldIssuer, newIssuer);
    }

    /// @notice Rotate the governance owner. Owner-only.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenTreasury
    /// @dev Returns `0` in Wave 3.5 — the authoritative float is encrypted in
    ///      PUSDC and cannot be projected to cleartext from a `view`. See
    ///      ADR-029 for the deferred async-decrypt cache that will populate
    ///      this getter in a follow-up wave.
    function getFloat() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IMuHavenTreasury
    function getMinFloat() external view returns (uint256) {
        return minFloat;
    }
}
