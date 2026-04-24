// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    euint128,
    ebool,
    InEuint128
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenSubscription} from "./interfaces/IMuHavenSubscription.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMuHavenIdentityRegistry} from "./interfaces/IMuHavenIdentityRegistry.sol";
import {IModularCompliance} from "./interfaces/IModularCompliance.sol";

/// @title MuHavenSubscription
/// @notice Atomic buy/sell coordinator for Wave 3.5 per ADR-001. The single
///         entry point for investor-driven fhERC-20 minting/burning against
///         encrypted PUSDC payment. Deployed behind an OZ Transparent Proxy.
///
/// @dev Phase 2 (`WAVE_3_5_REVISED.md` sub-phase 7) ships the `purchase` path.
///      `redeem` lands in the next sub-phase; the `getInstantCapRemaining` /
///      `getCurrentEpoch` views compute purely from cleartext storage that is
///      not yet populated, so they return defaults in Phase 2. The interface
///      is wired end-to-end so Phase 3 compliance modules + Phase 4 queue
///      integration plug in without re-deploying.
///
///      Dataflow on `purchase` (mirrors `FHE_ACL_CONVENTIONS.md` combined example):
///        1. Cleartext gates — token registered / not paused / KYC /
///           compliance / NAV fresh / hint bounds / ephemeralEOA != 0.
///        2. Silent-fail hint gate — `encSharesBounded = FHE.select(encShares <=
///           hint, encShares, 0)`. An over-hint purchase mints zero and moves
///           zero PUSDC (both legs mirror).
///        3. Compute cost — `encCost128 = FHE.mul(encSharesBounded, encNav)`
///           then narrow to `euint64` for PUSDC's native width (ADR-008).
///        4. Pull PUSDC — low-level call on the legacy `confidentialTransferFrom
///           (address,address,uint256)` selector per ADR-008, moving `encCost`
///           from `msg.sender` to `cfg.treasury`. Reverts on operator-not-set /
///           sender-uninitialised / PUSDC-side failure; no silent-fail on the
///           PUSDC leg itself (the silent-fail is on the shares side via the
///           hint gate's mirrored zero-cost).
///        5. Mint — `MuHavenToken.mintFromSubscription(msg.sender,
///           encSharesBounded, ephemeralEOA)`. The token grants `ephemeralEOA`
///           decrypt on the resulting balance handle per ADR-021.
///
///      PUSDC unit convention: `FHE.mul(shares, nav)` produces cost in PUSDC
///      base units directly — i.e., `nav` is scaled to "PUSDC base units per
///      share unit" (see MockPriceOracle fixture comment). This matches the
///      `FHE_ACL_CONVENTIONS.md` combined-example form and keeps Phase 2
///      implementation in lockstep with tests.
///
///      Wiring (Phase 2 / Phase 3 transitions):
///        - `tokenRegistry` (ADR-024) provides per-token treasury/queue/oracle/
///          issuer + cleartext params.
///        - `kycGate` is the Phase 2 KYC source (Wave 3 carry-over). Phase 3
///          wires `identityRegistry`; when non-zero it supersedes `kycGate`.
///        - `modularCompliance` is zero in Phase 2 (no modules bound); Phase 3
///          wires an address and non-empty modules tighten gating.
///        - `pusdc` is the PUSDC (ConfidentialUSDC) address — rotatable via
///          `setPUSDC` in case PUSDC redeploys under `cofhe-contracts ≥ v0.1.0`
///          (ADR-008 exit).
contract MuHavenSubscription is Initializable, ReentrancyGuardTransient, IMuHavenSubscription {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Rotatable governance address (multi-sig). Owns all setters.
    address public owner;

    /// @notice Per-token config registry (ADR-024).
    ITokenRegistry public tokenRegistry;

    /// @notice Phase 2 KYC source (Wave 3 carry-over `ERC3643KYCAdapter`).
    ///         Superseded by `identityRegistry` when non-zero.
    IKYCGate public kycGate;

    /// @notice Phase 3 identity registry (ADR-011). Zero in Phase 2; when
    ///         non-zero, `isVerified` is the authoritative KYC check and
    ///         `kycGate` is ignored.
    address public identityRegistry;

    /// @notice Phase 3 modular compliance. Zero in Phase 2; when non-zero,
    ///         bound modules gate every purchase via `canTransfer`.
    address public modularCompliance;

    /// @notice PUSDC (ConfidentialUSDC) address.
    address public pusdc;

    /// @notice Per-token per-epoch instant-redeem tracker (PUSDC base units).
    ///         Purchase path does NOT mutate this; it is consumed by the
    ///         upcoming `redeem` sub-phase. Kept here so the storage layout
    ///         is locked at Phase 2 rather than needing a migration step.
    mapping(address token => mapping(uint256 epoch => uint256)) public instantRedeemedThisEpoch;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Six named
    ///      address slots + one mapping = 7 slots; 43 reserved so the own-
    ///      storage footprint totals 50 (matches `MuHavenTreasury` /
    ///      `TokenRegistry` / `IssuerControlledOracle`).
    uint256[43] private __gap;

    // ── Constants ────────────────────────────────────────────────────────

    /// @dev Selector for `confidentialTransferFrom(address,address,uint256)` —
    ///      legacy pre-v0.1.0 ConfidentialUSDC ABI per ADR-008. Pre-computed
    ///      to avoid runtime keccak256 on every purchase.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    // ── Errors (additive to interface) ───────────────────────────────────

    /// @notice PUSDC low-level call reverted (operator unset / balance
    ///         uninitialised / PUSDC-internal failure). Loud revert: the
    ///         whole purchase tx reverts so the investor retains their
    ///         shares state and can debug upstream.
    error PaymentTransferFailed();

    /// @notice `maxSharesHint` is below the token's cleartext `minInvestment`
    ///         floor (ADR-025 — cleartext lower-bound on the hint).
    error BelowMinInvestment();

    // ── Events (additive to interface) ───────────────────────────────────

    event SubscriptionInitialized(
        address indexed owner,
        address indexed tokenRegistry,
        address indexed kycGate,
        address pusdc
    );

    /// @notice Emitted when the Phase 2 `kycGate` pointer rotates. Additive to
    ///         the interface — the interface event `IdentityRegistryUpdated`
    ///         is reserved for the Phase 3 identity-registry setter.
    event KYCGateUpdated(address indexed newGate);

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

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @param _owner           Initial governance address (rotatable via
    ///                         `transferOwnership`).
    /// @param _tokenRegistry   `TokenRegistry` pointer (ADR-024).
    /// @param _kycGate         Phase 2 KYC source (`ERC3643KYCAdapter`).
    /// @param _pusdc           PUSDC (ConfidentialUSDC) address.
    function initialize(
        address _owner,
        address _tokenRegistry,
        address _kycGate,
        address _pusdc
    ) external initializer {
        if (
            _owner == address(0) ||
            _tokenRegistry == address(0) ||
            _kycGate == address(0) ||
            _pusdc == address(0)
        ) revert ZeroAddress();

        owner = _owner;
        tokenRegistry = ITokenRegistry(_tokenRegistry);
        kycGate = IKYCGate(_kycGate);
        pusdc = _pusdc;

        emit SubscriptionInitialized(_owner, _tokenRegistry, _kycGate, _pusdc);
    }

    // ── Investor hot path ────────────────────────────────────────────────

    /// @inheritdoc IMuHavenSubscription
    function purchase(
        address token,
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external nonReentrant {
        // ── Cleartext gates (Rule 4 — access control before any FHE op) ──
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (maxSharesHint == 0) revert InvalidMaxSharesHint();

        // Resolve config + gate. Block-scoped so `cfg` releases stack slots
        // before the FHE math runs (avoids stack-too-deep at 0.8.28 without
        // `viaIR`). Only `treasury` and `nav` outlive this block.
        address treasuryAddr;
        uint256 nav;
        {
            ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
            if (!cfg.active) revert TokenNotRegistered();
            if (cfg.paused) revert TokenPaused();

            // ADR-025 — cleartext min-investment lower-bound on the hint.
            if (maxSharesHint < cfg.minInvestment) revert BelowMinInvestment();

            _requireEligible(msg.sender);
            // Purchase = mint convention (`from == address(0)`).
            _requireCompliance(token, address(0), msg.sender, uint256(maxSharesHint));

            uint256 updatedAt;
            (nav, updatedAt) = IPriceOracle(cfg.oracle).getNAV(token);
            if (nav == 0) revert OracleReturnedZero();
            if (block.timestamp - updatedAt > IPriceOracle(cfg.oracle).getMaxStaleness(token)) {
                revert StaleNAV();
            }

            treasuryAddr = cfg.treasury;
        }

        // ── FHE path (Rule 5 — silent-fail via `FHE.select` on encrypted conds) ──
        // Scratch handles are block-scoped; only the two results that outlive
        // the FHE block are `encSharesBounded` + `encCost`.
        euint128 encSharesBounded;
        euint64 encCost;
        {
            euint128 encSharesIn = FHE.asEuint128(encShares);
            FHE.allowThis(encSharesIn);

            euint128 encHint = FHE.asEuint128(uint256(maxSharesHint));
            FHE.allowThis(encHint);

            ebool withinHint = FHE.lte(encSharesIn, encHint);
            FHE.allowThis(withinHint);

            euint128 zero128 = FHE.asEuint128(uint256(0));
            FHE.allowThis(zero128);

            encSharesBounded = FHE.select(withinHint, encSharesIn, zero128);
            FHE.allowThis(encSharesBounded);

            // Cost = bounded shares × NAV (PUSDC base units per share unit).
            // `nav` is cleartext but we lift it to a ciphertext for `FHE.mul`
            // to match the `euint128 × euint128` surface used elsewhere.
            euint128 encNav = FHE.asEuint128(nav);
            FHE.allowThis(encNav);

            euint128 encCost128 = FHE.mul(encSharesBounded, encNav);
            FHE.allowThis(encCost128);

            // Narrow to PUSDC's native width (`euint64`). A PUSDC balance
            // cannot exceed ~1.8e19 base units; a legitimate cost stays well
            // below that.
            encCost = FHE.asEuint64(encCost128);
            FHE.allowThis(encCost);
            FHE.allow(encCost, pusdc);
        }

        // ── PUSDC pull (ADR-008 legacy selector) ──
        {
            (bool ok, ) = pusdc.call(
                abi.encodeWithSelector(
                    _TRANSFER_FROM_UINT256,
                    msg.sender,
                    treasuryAddr,
                    uint256(euint64.unwrap(encCost))
                )
            );
            if (!ok) revert PaymentTransferFailed();
        }

        // ── Mint shares (ephemeralEOA grant handled inside the token) ──
        FHE.allow(encSharesBounded, token);
        IMuHavenToken(token).mintFromSubscription(msg.sender, encSharesBounded, ephemeralEOA);

        emit Purchased(token, msg.sender, maxSharesHint);
    }

    /// @inheritdoc IMuHavenSubscription
    /// @dev Mirrors `purchase` with PUSDC direction flipped + burn substituted
    ///      for mint + cleartext per-epoch instant cap accounting (ADR-004).
    ///
    ///      Cap-exceeded behaviour (Phase 2 instant-only):
    ///        - The cleartext check `used + maxSharesHint*nav > instantCap`
    ///          short-circuits the body and emits `Redeemed(escalated=true)`
    ///          with no state change. The investor's frontend / SDK should
    ///          re-submit via `RedemptionQueue.submit` (Phase 4 will wire the
    ///          escalation in-contract; until then the routing is client-side).
    ///        - `EscalatedToQueue` is intentionally **not** emitted here
    ///          because no real `requestId` exists yet; emitting with id=0
    ///          would index a fake request. Phase 4 fires it from the same
    ///          branch with the actual queue-assigned id.
    ///
    ///      Burn + payout mirroring (silent-fail per Rule 5):
    ///        1. Hint-bound the requested shares to `encSharesBounded`.
    ///        2. Token's `burnFromSubscription` returns `actualBurned`, which
    ///           is `encSharesBounded` if the investor has sufficient balance,
    ///           encrypted-zero otherwise. Subscription receives ACL on the
    ///           returned handle so it can run the proceeds compute downstream.
    ///        3. `encProceeds = FHE.mul(actualBurned, nav)` mirrors the burn
    ///           outcome — the investor only receives PUSDC for shares they
    ///           actually burned.
    ///        4. PUSDC pulled `treasury → investor` via the ADR-008 legacy
    ///           selector. Subscription holds operator rights on the treasury's
    ///           PUSDC balance (granted at `MuHavenTreasury.initialize`).
    ///
    ///      Cleartext counter consumes against `maxSharesHint * nav` per
    ///      ADR-004 — the user's cap commitment is the hint, not the actual
    ///      encrypted amount. Counter only increments on the instant-success
    ///      branch (cap-exceeded escalations don't consume cap).
    function redeem(
        address token,
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external nonReentrant {
        // ── Cleartext gates (Rule 4 — access control before any FHE op) ──
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (maxSharesHint == 0) revert InvalidMaxSharesHint();

        address treasuryAddr;
        uint256 nav;
        uint256 epoch;
        uint256 hintCost;
        {
            ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
            if (!cfg.active) revert TokenNotRegistered();
            if (cfg.paused) revert TokenPaused();

            // ADR-025 — cleartext min-investment lower-bound on the hint.
            if (maxSharesHint < cfg.minInvestment) revert BelowMinInvestment();

            _requireEligible(msg.sender);
            // Redeem = burn convention (`to == address(0)`).
            _requireCompliance(token, msg.sender, address(0), uint256(maxSharesHint));

            uint256 updatedAt;
            (nav, updatedAt) = IPriceOracle(cfg.oracle).getNAV(token);
            if (nav == 0) revert OracleReturnedZero();
            if (block.timestamp - updatedAt > IPriceOracle(cfg.oracle).getMaxStaleness(token)) {
                revert StaleNAV();
            }

            treasuryAddr = cfg.treasury;
            epoch = _epochFor(cfg.epochDuration);
            // `uint256(maxSharesHint) * nav` cannot realistically overflow: hint
            // ≤ 2^128 - 1, nav ≤ ~1e18 → product ≪ 2^256. Solidity 0.8 reverts
            // on the impossible case anyway.
            hintCost = uint256(maxSharesHint) * nav;

            // ── Cap accounting (ADR-004) ──
            // Cap-exceeded → silent escalate, no state change. Per ADR-004
            // the cap is in PUSDC base units; `instantRedeemCap == 0` means
            // "no instant redemption allowed" — every redeem escalates.
            uint256 used = instantRedeemedThisEpoch[token][epoch];
            if (used + hintCost > uint256(cfg.instantRedeemCap)) {
                emit Redeemed(token, msg.sender, maxSharesHint, true);
                return;
            }
        }

        // ── FHE path (Rule 5 — silent-fail via `FHE.select`) ──
        // Scratch handles are block-scoped; only `encSharesBounded` outlives
        // the FHE block (used by both the burn call and the proceeds compute).
        euint128 encSharesBounded;
        {
            euint128 encSharesIn = FHE.asEuint128(encShares);
            FHE.allowThis(encSharesIn);

            euint128 encHint = FHE.asEuint128(uint256(maxSharesHint));
            FHE.allowThis(encHint);

            ebool withinHint = FHE.lte(encSharesIn, encHint);
            FHE.allowThis(withinHint);

            euint128 zero128 = FHE.asEuint128(uint256(0));
            FHE.allowThis(zero128);

            encSharesBounded = FHE.select(withinHint, encSharesIn, zero128);
            FHE.allowThis(encSharesBounded);
        }

        // ── Burn → returns silent-fail-bounded actualBurned ──
        FHE.allow(encSharesBounded, token);
        euint128 actualBurned = IMuHavenToken(token).burnFromSubscription(
            msg.sender,
            encSharesBounded,
            ephemeralEOA
        );

        // ── Compute proceeds against actual burn (mirrors silent-fail) ──
        euint64 encProceeds;
        {
            // `actualBurned` already has ACL granted to this contract by
            // `burnFromSubscription` — re-grant explicitly for defence-in-depth
            // against future Token implementations that change that contract.
            FHE.allowThis(actualBurned);

            euint128 encNav = FHE.asEuint128(nav);
            FHE.allowThis(encNav);

            euint128 encProceeds128 = FHE.mul(actualBurned, encNav);
            FHE.allowThis(encProceeds128);

            // Narrow to PUSDC's native width (`euint64`) per ADR-008.
            encProceeds = FHE.asEuint64(encProceeds128);
            FHE.allowThis(encProceeds);
            FHE.allow(encProceeds, pusdc);
        }

        // ── PUSDC pull treasury → investor (subscription is operator) ──
        {
            (bool ok, ) = pusdc.call(
                abi.encodeWithSelector(
                    _TRANSFER_FROM_UINT256,
                    treasuryAddr,
                    msg.sender,
                    uint256(euint64.unwrap(encProceeds))
                )
            );
            if (!ok) revert PaymentTransferFailed();
        }

        // ── Cap consumption (cleartext, against hint per ADR-004) ──
        instantRedeemedThisEpoch[token][epoch] += hintCost;

        emit Redeemed(token, msg.sender, maxSharesHint, false);
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    /// @dev KYC check. Phase 2 consults `kycGate`; Phase 3 delegates to
    ///      `IdentityRegistry` when wired. A non-zero `identityRegistry`
    ///      supersedes `kycGate` entirely (i.e. `kycGate` isn't consulted
    ///      when both are set).
    function _requireEligible(address account) internal view {
        if (identityRegistry != address(0)) {
            if (!IMuHavenIdentityRegistry(identityRegistry).isVerified(account)) {
                revert NotEligible();
            }
        } else {
            if (!kycGate.isEligible(account)) revert NotEligible();
        }
    }

    /// @dev Modular compliance gate. Phase 2 skips when unwired; Phase 3
    ///      binds modules and this starts gating purchases / redeems.
    ///      `from == address(0)` signals **mint** (purchase) to compliance
    ///      modules and `to == address(0)` signals **burn** (redeem) per
    ///      `IModularCompliance.canTransfer` natspec — modules may apply
    ///      different rules to each direction (e.g. lockup blocks burn but
    ///      not mint, max-balance only triggers on mint).
    function _requireCompliance(
        address token,
        address from,
        address to,
        uint256 hintAmount
    ) internal view {
        if (modularCompliance == address(0)) return;
        if (!IModularCompliance(modularCompliance).canTransfer(
            token,
            from,
            to,
            hintAmount
        )) {
            revert ComplianceBlocked();
        }
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IMuHavenSubscription
    /// @dev Phase 2 returns the full cap (no consumption recorded yet — redeem
    ///      is where instant-cap accounting fires). Stays consistent after
    ///      redeem lands: the cap minus whatever the current epoch consumed.
    function getInstantCapRemaining(address token) external view returns (uint256) {
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
        if (!cfg.active) return 0;
        uint256 epoch = _epochFor(cfg.epochDuration);
        uint256 used = instantRedeemedThisEpoch[token][epoch];
        uint256 cap = uint256(cfg.instantRedeemCap);
        return used >= cap ? 0 : cap - used;
    }

    /// @inheritdoc IMuHavenSubscription
    function getCurrentEpoch(address token) external view returns (uint256) {
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
        if (!cfg.active || cfg.epochDuration == 0) return 0;
        return _epochFor(cfg.epochDuration);
    }

    function _epochFor(uint32 epochDuration) internal view returns (uint256) {
        if (epochDuration == 0) return 0;
        return block.timestamp / uint256(epochDuration);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Rotate the `TokenRegistry` pointer. Owner-only.
    function setTokenRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        tokenRegistry = ITokenRegistry(newRegistry);
        emit TokenRegistryUpdated(newRegistry);
    }

    /// @notice Rotate the KYC-gate pointer (Phase 2 source). Owner-only.
    ///         Zero address is rejected: even when `identityRegistry` is
    ///         wired and supersedes the gate, a live pointer is kept as a
    ///         safety net against an identity-registry misconfiguration that
    ///         would otherwise call `isEligible` on `address(0)` and brick
    ///         `purchase` silently.
    function setKYCGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        kycGate = IKYCGate(newGate);
        emit KYCGateUpdated(newGate);
    }

    /// @notice Wire the Phase 3 `IdentityRegistry`. Owner-only. Non-zero
    ///         supersedes `kycGate` for eligibility checks. Pass `address(0)`
    ///         to revert to legacy gating.
    function setIdentityRegistry(address newRegistry) external onlyOwner {
        identityRegistry = newRegistry;
        emit IdentityRegistryUpdated(newRegistry);
    }

    /// @notice Wire the Phase 3 `ModularCompliance`. Owner-only. Pass
    ///         `address(0)` to disable compliance gating.
    function setModularCompliance(address newCompliance) external onlyOwner {
        modularCompliance = newCompliance;
        emit ModularComplianceUpdated(newCompliance);
    }

    /// @notice Rotate the PUSDC pointer. Owner-only. Intended for the
    ///         ADR-008 exit when PUSDC redeploys under cofhe-contracts ≥ v0.1.0.
    function setPUSDC(address newPusdc) external onlyOwner {
        if (newPusdc == address(0)) revert ZeroAddress();
        pusdc = newPusdc;
        emit PUSDCUpdated(newPusdc);
    }

    /// @notice Rotate governance ownership. Owner-only.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
