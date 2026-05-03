// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    FHE,
    euint64,
    euint128,
    InEuint128,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IYieldSnapshot} from "./interfaces/IYieldSnapshot.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IMuHavenStable} from "./interfaces/IMuHavenStable.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";

/// @title YieldSnapshot
/// @notice Pull-based yield distribution per ADR-005 / ADR-013. Replaces the
///         Wave 3 push-based `YieldDistributor` + `MuHavenEscrow` pipeline.
///         One contract serves every RWA token: per-token issuer is resolved
///         via `TokenRegistry.getConfig(token).issuer` so issuer rotations
///         propagate immediately. Deployed behind an OZ Transparent Proxy.
///
/// @dev Epoch lifecycle (matches `FLOWS.md §F9`):
///   1. Issuer `openEpoch(token)` — allocates an `epochId`, records
///      `snapshotStartTs`.
///   2. Issuer `snapshotBatch(epochId, investors[])` in paginated slices —
///      captures each investor's encrypted balance via
///      `MuHavenToken.snapshotBalance` (which re-grants ACL to this
///      contract so downstream `FHE.mul` doesn't ACL-fail). Duplicate
///      entries within or across batches are silent no-ops (idempotent).
///   3. Issuer `finalizeSnapshot(epochId)` — reads `encryptedTotalSupply`
///      via `MuHavenToken.snapshotTotalSupply`, stores, flips
///      `finalized = true`, locks further `snapshotBatch` calls.
///   4. Issuer `fundEpoch(epochId, encTotalYield, ratePerShare)` —
///      pulls PUSDC from the issuer via the ADR-008 legacy
///      `confidentialTransferFrom(address,address,uint256)` selector,
///      stores the issuer-provided cleartext `ratePerShare` (Phase
///      9.B / Option A — 2026-05-04), and sets `claimExpiry =
///      block.timestamp + claimExpirySeconds(token)`. Issuer must
///      have pre-granted this contract operator rights on PUSDC
///      (standard operator-model flow). The legacy `encRatio` is
///      still computed and stored for the audit-trail surface but
///      `claimYield` no longer multiplies through it — see step 5.
///   5. Each investor `claimYield(epochId, ephemeralEOA)` — computes their
///      proportional share `encShare = FHE.mul(encBalance,
///      FHE.asEuint128(uint256(ratePerShare)))` (Phase 9.B / Option A —
///      the cleartext rate becomes a depth-1 trivial encryption,
///      breaking the deep ancestry of the legacy `encRatio` path),
///      narrows to PUSDC's `euint64` width, grants `ephemeralEOA` decrypt
///      per ADR-021, transfers to investor via the trusted-payer bypass
///      surface `IMuHavenStable.trustedPayout(investor, encShare64,
///      ephemeralEOA)` per Phase 8 Option B / ADR-046. Plants the
///      session-EOA grant on the investor's grown mhUSDC handle in the
///      SAME tx as the transfer, so the investor's first `decryptForView`
///      post-claim succeeds without an on-chain `refreshDecryptGrant`
///      round-trip. Snapshot's float stays kernel-only — investors cannot
///      decrypt the treasury-equivalent float (mirrors audit-prep §A-9).
///      `trustedPayout` skips the wrapper's `_silentFailBound` chain
///      (lte + trivialEncrypt + select), cutting the wrapper-side FHE op
///      count from 5 → 2 and the total claim FHE chain from 8 → 5 ops.
///      The cofhe Threshold Network's testnet indexer empirically refuses
///      to index handles produced by the 8-op chain that the original
///      ADR-044 split-grant path produced — see
///      `PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md` and ADR-046. Snapshot
///      proxy must be pre-registered via
///      `IMuHavenStable.setTrustedPayer(snapshot, true)` (one-shot
///      owner-gated tx via `scripts/grant-trusted-payer.ts`).
///      Idempotent: re-calls revert with `AlreadyClaimed` (interface
///      natspec — "double claim is an operator/tooling bug, not a malicious
///      side-channel", so *not* silent-fail).
///
///      Decoupled-decrypt audit path (Round 3, 2026-05-04): in addition
///      to the encShare64 (Round 1) and encRatio (Round 2) ACL grants
///      preserved for backward compat, `claimYield` also stamps
///      kernel + ephemeralEOA grants on `encTotalYield` (depth ~3,
///      wrapper-free) and `encTotalSupply` (same shape as the
///      investor's snapshot-time balance handle, known-good per
///      `project_cofhe_tn_chain_length_cap`). Frontends compute claim
///      amount as `floor(snapshotBalance × encTotalYield /
///      encTotalSupply)` locally — sidesteps `encRatio`'s deeper FHE
///      op chain (max(encYCanonical, encTotalSupply) + 1) which the
///      cofhe TN testnet indexer refuses on staging.
///
///   6. After `claimExpiry`, issuer `sweepExpired(epochId)` — returns any
///      unclaimed PUSDC back to the issuer. Single-shot: a subsequent
///      sweep on the same epoch reverts with `AlreadySwept`.
///
///   Conservation story (preserves "sum of claims <= pulled yield"):
///   Per-investor share is `FHE.mul(encBalance, encRatio)` where
///   `encRatio = encTotalYield / encTotalSupply` uses floor-division. For
///   any snapshotted holder, `encBalance <= encTotalSupply`, so
///   `sum(encShare) <= encTotalSupply * encRatio <= encTotalYield`. The
///   floor-division slack is captured in `_encRemaining` and swept back to
///   the issuer on expiry.
///
///   Width handling (ADR-031 consistency):
///   `encTotalYield` arrives as `InEuint128` per the interface, but PUSDC
///   is `euint64` (ADR-008 legacy). We narrow to `euint64` for the pull,
///   then widen back to `euint128` for the ratio math — so the "yield pool"
///   used in conservation matches exactly what was transferred on-chain.
///   If an issuer passes a value > `type(uint64).max` the narrowing
///   silently truncates; this is issuer-side misconfiguration and the
///   silent truncation is acceptable because the issuer is the sole caller
///   and the only party affected. PUSDC's legitimate `euint64` range
///   (~1.8e19 base units) is larger than any realistic yield distribution.
///
///   ACL re-grant surface:
///   `MuHavenToken.snapshotBalance(investor)` / `snapshotTotalSupply()`
///   are onlyYieldSnapshot-gated helpers added in Phase 5 so this contract
///   can obtain FHE ACL access on handles the token owns. Without them,
///   `FHE.mul(encBalance, encRatio)` in `claimYield` would revert
///   ACL-denied because the ACL on `_balances[investor]` is scoped to the
///   token, not to this contract.
contract YieldSnapshot is Initializable, ReentrancyGuardTransient, IYieldSnapshot {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Rotatable governance address. Owns all setters.
    address public owner;

    /// @notice Per-token config registry (ADR-024). Source of truth for
    ///         issuer rotation.
    ITokenRegistry public tokenRegistry;

    /// @notice PUSDC (ConfidentialUSDC) address — immutable post-init.
    address public pusdc;

    /// @notice Sequential epoch id. Starts at 1 (id 0 reserved for "none").
    uint256 public nextEpochId;

    /// @notice Per-id epoch storage.
    mapping(uint256 => Epoch) internal _epochs;

    /// @notice Per-(epoch, investor) captured balance at snapshot time.
    mapping(uint256 => mapping(address => euint128)) internal _snapshots;

    /// @notice Per-(epoch, investor) double-claim guard.
    mapping(uint256 => mapping(address => bool)) internal _claimed;

    /// @notice Most recent epoch id opened for a token (0 if none).
    mapping(address => uint256) public override currentEpoch;

    /// @notice Per-epoch remaining (unclaimed) PUSDC. Held at `euint64`
    ///         width — matches the PUSDC unit and the amount actually
    ///         transferred on `fundEpoch`. Decremented on every claim;
    ///         what's left at `sweepExpired` time returns to the issuer.
    mapping(uint256 => euint64) internal _encRemaining;

    /// @notice Per-epoch sweep latch. Idempotency-guard on `sweepExpired`.
    ///         A post-sweep claim reverts with `AlreadySwept` so the
    ///         investor doesn't mark their `_claimed` flag without
    ///         receiving PUSDC.
    mapping(uint256 => bool) internal _swept;

    /// @notice Per-token claim-expiry window (seconds added to
    ///         `block.timestamp` at `fundEpoch`). Zero means "use default"
    ///         (`DEFAULT_CLAIM_EXPIRY`).
    mapping(address => uint256) public claimExpirySeconds;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Four
    ///      single slots + seven mappings = 11 slots; 39 reserved so the
    ///      own-storage footprint totals 50 (matches the Wave 3.5
    ///      convention for Subscription / Treasury / Queue / TokenRegistry).
    uint256[39] private __gap;

    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Default claim window if `claimExpirySeconds[token]` is 0.
    uint256 public constant DEFAULT_CLAIM_EXPIRY = 365 days;

    /// @notice Lower bound on admin-configured claim window (prevents
    ///         footgun configurations that strand every investor with
    ///         a minute to claim).
    uint256 public constant MIN_CLAIM_EXPIRY = 7 days;

    /// @notice Upper bound on admin-configured claim window (10 years —
    ///         ample for every realistic RWA cadence; stops a typo from
    ///         silently parking PUSDC for forever).
    uint256 public constant MAX_CLAIM_EXPIRY = 3650 days;

    /// @dev Selector for `confidentialTransfer(address,uint256)` — legacy
    ///      pre-v0.1.0 ConfidentialUSDC ABI per ADR-008. Pre-computed to
    ///      avoid runtime keccak256 on every claim / sweep.
    bytes4 private constant _TRANSFER_UINT256 =
        bytes4(keccak256("confidentialTransfer(address,uint256)"));

    /// @dev Selector for `confidentialTransferFrom(address,address,uint256)` —
    ///      legacy pre-v0.1.0 ConfidentialUSDC ABI per ADR-008.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    // ── Errors (additive to interface) ───────────────────────────────────

    /// @notice Claimed against an epoch the investor was never snapshotted
    ///         in. Revert (not silent-fail) so investor tooling surfaces
    ///         the "not in this distribution" case clearly instead of
    ///         silently flipping `_claimed = true` with zero payout.
    error NotSnapshotted();

    /// @notice Sweep already executed on this epoch. Also fired when an
    ///         investor tries to claim post-sweep — sweeping closes the
    ///         claim window for that epoch.
    error AlreadySwept();

    /// @notice PUSDC low-level call reverted. Loud revert so the caller
    ///         can diagnose upstream (operator-unset, balance uninit, etc.).
    error PaymentTransferFailed();

    /// @notice `token` is not registered in `TokenRegistry` (or has been
    ///         explicitly deactivated).
    error TokenNotRegistered();

    /// @notice `finalizeSnapshot` called before any investor was captured
    ///         via `snapshotBatch`. Prevents a divide-by-zero on
    ///         `encRatio = encTotalYield / encTotalSupply` when
    ///         `encTotalSupply` would also be zero.
    error EmptySnapshot();

    /// @notice `setClaimExpiry` rejected because the new value is below
    ///         `MIN_CLAIM_EXPIRY` or above `MAX_CLAIM_EXPIRY` (zero is
    ///         allowed — it resets to the default).
    error InvalidClaimExpiry();

    // ── Events (additive to interface) ───────────────────────────────────

    event YieldSnapshotInitialized(
        address indexed owner,
        address indexed tokenRegistry,
        address pusdc
    );
    event ClaimExpiryUpdated(address indexed token, uint256 newSeconds);
    event TokenRegistryUpdated(address indexed newRegistry);
    event PUSDCUpdated(address indexed newPUSDC);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyIssuerFor(address token) {
        if (msg.sender != _issuerOf(token)) revert OnlyIssuer();
        _;
    }

    modifier onlyIssuerForEpoch(uint256 epochId) {
        address t = _epochs[epochId].token;
        if (t == address(0)) revert InvalidEpoch();
        if (msg.sender != _issuerOf(t)) revert OnlyIssuer();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Called once by the deploy script.
    /// @param _owner          Initial governance address (rotatable via
    ///                        `transferOwnership`).
    /// @param _tokenRegistry  `TokenRegistry` pointer (ADR-024).
    /// @param _pusdc          PUSDC (ConfidentialUSDC) address.
    function initialize(
        address _owner,
        address _tokenRegistry,
        address _pusdc
    ) external initializer {
        if (
            _owner == address(0) ||
            _tokenRegistry == address(0) ||
            _pusdc == address(0)
        ) revert ZeroAddress();

        owner = _owner;
        tokenRegistry = ITokenRegistry(_tokenRegistry);
        pusdc = _pusdc;
        nextEpochId = 0;

        emit YieldSnapshotInitialized(_owner, _tokenRegistry, _pusdc);
    }

    // ── Issuer cold path — epoch lifecycle ───────────────────────────────

    /// @inheritdoc IYieldSnapshot
    function openEpoch(address token) external onlyIssuerFor(token) returns (uint256 epochId) {
        if (token == address(0)) revert ZeroAddress();
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
        if (!cfg.active) revert TokenNotRegistered();
        // `paused` is intentionally NOT gated — opening an epoch while the
        // token is paused is a legitimate "prep for unpause" flow. The
        // investor-facing `claimYield` path is also pause-agnostic: already-
        // earned yield stays claimable regardless of the token's pause state.

        epochId = ++nextEpochId;
        Epoch storage e = _epochs[epochId];
        e.token = token;
        e.snapshotStartTs = block.timestamp;

        currentEpoch[token] = epochId;
        emit EpochOpened(token, epochId);
    }

    /// @inheritdoc IYieldSnapshot
    /// @dev Idempotent per (epochId, investor): duplicates within or across
    ///      batches silently no-op. `holderCount` only increments for new
    ///      entries, so the finalize-time invariant `holderCount > 0` is
    ///      a true "any investor captured" signal.
    ///
    ///      Each new balance is ALSO accumulated into `epoch.encTotalSupply`
    ///      via `FHE.add`, so at `finalizeSnapshot` the supply aggregate is
    ///      exactly `sum(snapshot balances)` by construction. This diverges
    ///      from the interface natspec's "read from `MuHavenToken.
    ///      encryptedTotalSupply`" wording (which FLOWS.md explicitly marks
    ///      as the alternative to "compute from snapshot sum"), but is the
    ///      only approach that preserves conservation when mutations occur
    ///      between snapshot batches (see ADR-038). If we read the token's
    ///      live total supply at finalize time, a burn between snapshots
    ///      would make `sum(snapshot) > totalSupply`, pushing
    ///      `encRatio * sum(snapshot) > encTotalYield` and underflowing
    ///      `_encRemaining` at sweep — a pool-drain vector.
    function snapshotBatch(
        uint256 epochId,
        address[] calldata investors
    ) external onlyIssuerForEpoch(epochId) {
        Epoch storage e = _epochs[epochId];
        if (e.finalized) revert SnapshotAlreadyFinalized();

        IMuHavenToken muToken = IMuHavenToken(e.token);
        uint256 added = 0;
        uint256 n = investors.length;
        // Local copy of the running supply so we only touch storage once
        // per batch (cheaper for large n + avoids re-ACL-granting each iter).
        euint128 runningSupply = e.encTotalSupply;
        for (uint256 i = 0; i < n; i++) {
            address inv = investors[i];
            if (inv == address(0)) continue;
            if (Common.isInitialized(_snapshots[epochId][inv])) continue;

            // Token-side helper re-grants this contract ACL on the balance
            // handle, returning a fresh zero-handle for never-held accounts.
            euint128 bal = muToken.snapshotBalance(inv);
            FHE.allowThis(bal);
            _snapshots[epochId][inv] = bal;

            // Accumulate into running supply (sum-of-snapshots — preserves
            // conservation under intra-snapshot mutations per ADR-038).
            if (Common.isInitialized(runningSupply)) {
                runningSupply = FHE.add(runningSupply, bal);
            } else {
                runningSupply = bal;
            }
            added++;
        }
        if (added > 0) {
            FHE.allowThis(runningSupply);
            e.encTotalSupply = runningSupply;
            e.holderCount += added;
            emit SnapshotBatchApplied(epochId, added);
        }
    }

    /// @inheritdoc IYieldSnapshot
    /// @dev `encTotalSupply` is already populated by `snapshotBatch` as the
    ///      running sum (ADR-038); finalize just seals the phase.
    function finalizeSnapshot(uint256 epochId) external onlyIssuerForEpoch(epochId) {
        Epoch storage e = _epochs[epochId];
        if (e.finalized) revert SnapshotAlreadyFinalized();
        if (e.holderCount == 0) revert EmptySnapshot();

        e.snapshotEndTs = block.timestamp;
        e.finalized = true;

        emit SnapshotFinalized(e.token, epochId, e.holderCount);
    }

    /// @inheritdoc IYieldSnapshot
    /// @dev Phase 9.B / Option A (2026-05-04): replaces the previous
    ///      on-chain `encRatio = FHE.div(encTotalYield, encTotalSupply)`
    ///      computation with an issuer-provided cleartext
    ///      `ratePerShare`. The legacy `encRatio` is still computed and
    ///      stored to preserve the audit-trail surface (and to support
    ///      pre-Option-A epochs whose `ratePerShare` slot is zero), but
    ///      `claimYield` now multiplies `snapshotBalance` by a trivial
    ///      encryption of `ratePerShare` instead. The trivial handle
    ///      has chain depth 1, breaking the deep ancestry that stalled
    ///      cofhe TN's resolution. See
    ///      `PHASE9A_CHAIN_LENGTH_BLOCKER.md > Option A`.
    function fundEpoch(
        uint256 epochId,
        InEuint128 calldata encTotalYield,
        uint128 ratePerShare
    ) external nonReentrant onlyIssuerForEpoch(epochId) {
        Epoch storage e = _epochs[epochId];
        if (!e.finalized) revert SnapshotNotFinalized();
        if (e.funded) revert EpochAlreadyFunded();
        if (ratePerShare == 0) revert InvalidRatePerShare();

        // Verify the client-encrypted input here — it's bound to issuer's
        // signature, and msg.sender is the issuer in this context.
        euint128 encY128 = FHE.asEuint128(encTotalYield);
        FHE.allowThis(encY128);

        // Narrow to PUSDC's native width. Silent truncation on
        // issuer-side misconfiguration (value > 2^64-1) is acceptable —
        // PUSDC can't hold more than 2^64-1 base units anyway, and the
        // issuer is the sole caller.
        euint64 encY64 = FHE.asEuint64(encY128);
        FHE.allowThis(encY64);
        FHE.allow(encY64, pusdc);

        // Pull PUSDC from the issuer. The issuer must have granted this
        // contract operator rights on PUSDC via `setOperator(snapshot, ttl)`.
        (bool ok, ) = pusdc.call(
            abi.encodeWithSelector(
                _TRANSFER_FROM_UINT256,
                msg.sender,    // issuer
                address(this),
                uint256(euint64.unwrap(encY64))
            )
        );
        if (!ok) revert PaymentTransferFailed();

        // Widen back — canonicalises to the actually-pulled amount so
        // the conservation accounting matches the PUSDC pool.
        euint128 encYCanonical = FHE.asEuint128(encY64);
        FHE.allowThis(encYCanonical);
        FHE.allow(encYCanonical, msg.sender);  // issuer can decrypt/verify

        // Persist conservation counter BEFORE we compute the ratio so the
        // sweep path doesn't rely on a half-initialised epoch on revert.
        _encRemaining[epochId] = encY64;

        // Legacy encRatio still computed for backward compat with pre-
        // Option-A audit paths. Not used by claimYield post-Option-A —
        // see contract-level natspec "Decoupled-decrypt audit path".
        euint128 encRatio = FHE.div(encYCanonical, e.encTotalSupply);
        FHE.allowThis(encRatio);

        e.encTotalYield = encYCanonical;
        e.encRatio = encRatio;
        e.ratePerShare = ratePerShare;     // Phase 9.B / Option A
        e.funded = true;
        e.claimExpiry = block.timestamp + _claimExpiryFor(e.token);

        emit EpochFunded(e.token, epochId);
    }

    /// @inheritdoc IYieldSnapshot
    /// @dev Issuer-only. Transfers the remaining (floor-division slack +
    ///      unclaimed shares) back to the issuer. Single-shot — subsequent
    ///      sweeps revert with `AlreadySwept`. Closing the claim window
    ///      also causes any late `claimYield` to revert, keeping the
    ///      `_claimed` flag accurate (no zombie "claimed but unpaid"
    ///      entries).
    function sweepExpired(uint256 epochId) external nonReentrant onlyIssuerForEpoch(epochId) {
        Epoch storage e = _epochs[epochId];
        if (!e.funded) revert EpochNotFunded();
        if (block.timestamp <= e.claimExpiry) revert NotYetExpired();
        if (_swept[epochId]) revert AlreadySwept();

        _swept[epochId] = true;

        euint64 rem = _encRemaining[epochId];
        // Reset to uninitialised default (zero-hash handle) so
        // `isInitialized` returns false — a defensive read after sweep
        // reflects "no remaining pool". Solidity doesn't support `delete`
        // on user-defined value types, so wrap the zero-hash directly.
        _encRemaining[epochId] = euint64.wrap(bytes32(0));

        if (Common.isInitialized(rem)) {
            FHE.allowThis(rem);
            FHE.allow(rem, pusdc);
            (bool ok, ) = pusdc.call(
                abi.encodeWithSelector(
                    _TRANSFER_UINT256,
                    msg.sender,    // issuer
                    uint256(euint64.unwrap(rem))
                )
            );
            if (!ok) revert PaymentTransferFailed();
        }

        emit EpochExpired(e.token, epochId);
    }

    // ── Investor hot path ────────────────────────────────────────────────

    /// @inheritdoc IYieldSnapshot
    /// @dev Flips `_claimed` before the external PUSDC call (transient
    ///      reentrancy guard is the primary defence; flag-flip is
    ///      belt-and-braces). `NotSnapshotted` is a loud revert so
    ///      investor tooling can distinguish "not in this epoch's
    ///      distribution" from "claimed with zero payout" — matches the
    ///      interface natspec rationale "double claim reverts (not
    ///      silent-fail) — double claim is an operator/tooling bug, not
    ///      a malicious side-channel" which extends to claim-not-eligible.
    function claimYield(uint256 epochId, address ephemeralEOA) external nonReentrant {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        Epoch storage e = _epochs[epochId];
        if (e.token == address(0)) revert InvalidEpoch();
        if (!e.funded) revert EpochNotFunded();
        // Order: `_claimed` before `_swept` so a repeat-claimer who already
        // took their share pre-sweep gets the most-specific `AlreadyClaimed`
        // error; a never-claimed investor arriving post-sweep gets
        // `AlreadySwept`. Both paths stop before any state mutation.
        if (_claimed[epochId][msg.sender]) revert AlreadyClaimed();
        if (_swept[epochId]) revert AlreadySwept();

        euint128 encBalance = _snapshots[epochId][msg.sender];
        if (!Common.isInitialized(encBalance)) revert NotSnapshotted();

        // Flip BEFORE external call.
        _claimed[epochId][msg.sender] = true;

        FHE.allowThis(encBalance);

        // Proportional share = snapshotBalance * ratePerShare (floor).
        // Phase 9.B / Option A (2026-05-04): use the cleartext
        // `e.ratePerShare` via `FHE.asEuint128(uint256(ratePerShare))`
        // — depth-1 trivial — instead of the encrypted `e.encRatio`.
        // This breaks the deep ancestry that empirically stalled cofhe
        // TN's resolution path on the post-claim mhUSDC handle. See
        // `PHASE9A_CHAIN_LENGTH_BLOCKER.md > Option A`.
        //
        // Backward-compat: pre-Option-A epochs (funded before this
        // contract upgrade) have `e.ratePerShare == 0`. For those we
        // fall back to the legacy `e.encRatio` path. New epochs MUST
        // set ratePerShare via the new fundEpoch signature, which
        // reverts on zero.
        //
        // Upper bound argued in contract-level natspec: for any
        // snapshotted investor encShare <= encTotalYield <= 2^64 - 1.
        euint128 encShare128;
        if (e.ratePerShare != 0) {
            euint128 trivialRate = FHE.asEuint128(uint256(e.ratePerShare));
            FHE.allowThis(trivialRate);
            encShare128 = FHE.mul(encBalance, trivialRate);
        } else {
            // Legacy path — kept for any pre-Option-A epochs still in-flight.
            encShare128 = FHE.mul(encBalance, e.encRatio);
        }
        FHE.allowThis(encShare128);
        FHE.allow(encShare128, ephemeralEOA);  // per ADR-021 / Rule 2

        // Narrow for PUSDC transfer.
        euint64 encShare64 = FHE.asEuint64(encShare128);
        FHE.allowThis(encShare64);
        FHE.allow(encShare64, pusdc);

        // Audit-handle grants on encShare64 (event arg). Stays in place
        // for theoretical event-based audit, but empirical testing on
        // staging post-deploy showed encShare64 is ALSO subject to the
        // wrapper-scoped indexer issue — `cofhe TN refuses wrapper-
        // touching handles even at the documented "5 works" threshold.
        // Active demo verification uses the decoupled-decrypt path
        // below (encRatio + snapshotBalance grants).
        FHE.allow(encShare64, msg.sender);
        FHE.allow(encShare64, ephemeralEOA);

        // ── Decoupled-decrypt audit path · Round 3 (the one that works) ──
        // Frontend computes `claimAmount = floor(snapshotBalance ×
        // encTotalYield / encTotalSupply)` in JS by decrypting each
        // input separately and combining locally.
        //
        // Why not encRatio: `encRatio = FHE.div(encYCanonical,
        // encTotalSupply)` from `fundEpoch` has chain depth `max(3, k)
        // + 1` where `k` is `encTotalSupply`'s depth — which itself
        // grows with the snapshot batch's `FHE.add` accumulator AND
        // inherits each investor's `_balances[i]` chain (each balance
        // is wrapper-tainted via `Subscription.purchase`'s
        // `actualShares = select(eq(actualPaid, encCost), bounded, 0)`
        // chain, so its ancestry crosses `MuHavenStable.transferFrom`).
        // Empirical Round 2 finding (2026-05-04): even at the
        // documented "5 works" boundary the cofhe Threshold Network's
        // testnet indexer queues encRatio at HTTP 204 indefinitely.
        // Decrypting encRatio is therefore unreliable on staging.
        //
        // Round 3 inputs (depth-shallow OR known-good):
        //   - encTotalYield = encYCanonical = asEuint128(asEuint64(
        //     asEuint128(InEuint128 calldata))). Depth ~3, fully
        //     fresh — never touches the wrapper, never aggregated
        //     across investors. Reliably decrypts on TN.
        //   - encTotalSupply = sum-of-snapshot-balances accumulator
        //     from `snapshotBatch`. Depth ≈ max(bal_i depth) + (N-1)
        //     where N = `holderCount`. Wrapper-tainted via each
        //     balance's `_mintInternal` ancestry, BUT this is the
        //     same shape as `_balances[investor]` (TBILL1 / MUSTB
        //     share-balance decrypts work, per
        //     `project_cofhe_tn_chain_length_cap`). For demo-scale
        //     (1-2 investors) depth stays ≤ 6; multi-investor at
        //     production scale may need separate compaction.
        //   - snapshotBalance = `_snapshots[epochId][msg.sender]`,
        //     the SAME handle as `MuHavenToken._balances[msg.sender]`
        //     at snapshot time (frozen — post-claim mutations create
        //     new live handles, this one stays at snapshot depth).
        //     Investor already has ACL via the original mint /
        //     transfer-in — no grant needed here.
        //
        // Round 2's `encRatio` grants are kept as a fallback so
        // pre-Round-3 frontend builds keep working when the chain
        // depth happens to land below the indexer's threshold (e.g.
        // single-investor demo on a freshly-funded epoch where
        // encTotalSupply equals a single shallow balance handle).
        //
        // Privacy trade-off: investor learns totalYield + totalSupply
        // (for own epoch). totalYield is the issuer's published
        // distribution amount and is already inferable from cleartext
        // PUSDC custody on the snapshot proxy. totalSupply combined
        // with own balance reveals the holder set's aggregate share
        // count — but `holderCount` is already public-cleartext on
        // the epoch view, and per-investor balances stay encrypted.
        // Acceptable for the audit-trail use case; contract-mediated
        // paths (sweepExpired, encRemaining decrement) remain
        // operationally private via kernel-only ACL on the float.
        FHE.allow(e.encTotalYield, msg.sender);
        FHE.allow(e.encTotalYield, ephemeralEOA);
        FHE.allow(e.encTotalSupply, msg.sender);
        FHE.allow(e.encTotalSupply, ephemeralEOA);
        // Round 2 encRatio grants — preserved for backward compat.
        FHE.allow(e.encRatio, msg.sender);
        FHE.allow(e.encRatio, ephemeralEOA);

        // Decrement conservation counter BEFORE PUSDC transfer — a failed
        // transfer reverts the whole tx and restores state anyway, so
        // ordering is cosmetic. Keeping state updates before external
        // calls is the CEI (checks-effects-interactions) shape.
        euint64 rem = _encRemaining[epochId];
        FHE.allowThis(rem);
        euint64 newRem = FHE.sub(rem, encShare64);
        FHE.allowThis(newRem);
        _encRemaining[epochId] = newRem;

        // Transfer mhUSDC (this contract → investor) via the trusted-payer
        // bypass surface per Phase 8 Option B / ADR-046. `trustedPayout`
        // skips the wrapper's `_silentFailBound` chain (lte +
        // trivialEncrypt + select), cutting the wrapper-side FHE op count
        // from 5 → 2 and the total claim-tx FHE chain from 8 → 5.
        //
        // The pre-Option-B path used `IMuHavenStable.transferFrom(
        // address(this), msg.sender, encShare64, address(0),
        // ephemeralEOA)` — correct ACL semantics, but the cofhe
        // Threshold Network's testnet indexer choked on the resulting
        // 8-op chain and refused to index the post-claim `_balances[
        // investor]` handle. Investors saw indefinite `204` polls on
        // `/v2/sealoutput`. Empirically verified: the issue persisted
        // across fresh kernels, with preflight-wrapped issuer mhUSDC
        // (Fix A), after a 1-hour TN-propagation wait. Skipping the
        // silent-fail bound (load-bearing for direct EOA P2P transfers,
        // structurally redundant for the snapshot leg by per-epoch
        // conservation) was the only path that dodged the indexer
        // pathology. See `PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md`.
        //
        // ACL grants on the recipient (investor) handle: kernel +
        // ephemeralEOA (split-grant pattern from ADR-044, preserved by
        // `trustedPayout`). Sender (snapshot) handle: kernel-only —
        // snapshot's float stays operationally private.
        //
        // Authorization: snapshot proxy must be pre-registered as
        // trusted payer on the wrapper via
        // `IMuHavenStable.setTrustedPayer(snapshot, true)` (owner-only;
        // one-shot operator script `scripts/grant-trusted-payer.ts`).
        // Pre-flight check; loud-reverts `NotTrustedPayer` if missing.
        //
        // Conservation guarantee: per-epoch `sum(encShare) <=
        // encTotalYield` (via the floor-division ratio bound, see
        // contract-level natspec "Conservation story") ensures the
        // snapshot's mhUSDC float covers every legitimate claim. If
        // `fundEpoch` itself silent-failed (pre-Fix-A failure mode),
        // claims would still silent-fail on the wrapper's `FHE.sub`
        // underflow — but Fix A (`run-yield-epoch.ts` preflight wrap)
        // and Fix B (`PHASE8_FIX_B_DRAFT.md` — pending) close that gap.
        IMuHavenStable(pusdc).trustedPayout(
            msg.sender,
            encShare64,
            ephemeralEOA
        );

        emit YieldClaimed(e.token, msg.sender, epochId, encShare64);
    }

    /// @inheritdoc IYieldSnapshot
    /// @dev Mirror of `MuHavenStable.refreshAuditGrant` (ADR-042 cross-
    ///      session audit-decrypt pattern). The audit handle on a past
    ///      `YieldClaimed` event was granted to the ephemeralEOA at claim
    ///      time, but that eph is gone after a session rotation. The
    ///      handle's kernel-side ACL grant is durable on-chain (granted
    ///      via `FHE.allow(encShare64, msg.sender)` in `claimYield`), so
    ///      the rightful kernel can re-stamp the handle to a new eph
    ///      without touching `_snapshots` / `_claimed` / `_encRemaining`
    ///      state. No reentrancy concern — pure ACL-only mutation.
    function refreshAuditGrant(euint64 handle, address ephemeralEOA) external {
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (!FHE.isAllowed(handle, msg.sender)) revert NotAuditHandleOwner();
        FHE.allow(handle, ephemeralEOA);
        emit AuditGrantRefreshed(msg.sender, ephemeralEOA, handle);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IYieldSnapshot
    function getEpoch(uint256 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    /// @inheritdoc IYieldSnapshot
    function getSnapshotBalance(uint256 epochId, address investor) external view returns (euint128) {
        return _snapshots[epochId][investor];
    }

    /// @inheritdoc IYieldSnapshot
    function hasClaimed(uint256 epochId, address investor) external view returns (bool) {
        return _claimed[epochId][investor];
    }

    /// @inheritdoc IYieldSnapshot
    function issuer(address token) external view returns (address) {
        return _issuerOf(token);
    }

    /// @notice Whether `sweepExpired` has been executed against this epoch.
    function isSwept(uint256 epochId) external view returns (bool) {
        return _swept[epochId];
    }

    /// @notice Remaining (unclaimed) encrypted PUSDC for an epoch. Zero
    ///         handle after sweep.
    function getEncRemaining(uint256 epochId) external view returns (euint64) {
        return _encRemaining[epochId];
    }

    /// @notice Resolved claim-expiry window for a token (applies the
    ///         `DEFAULT_CLAIM_EXPIRY` fallback when `claimExpirySeconds`
    ///         is zero).
    function getClaimExpiryFor(address token) external view returns (uint256) {
        return _claimExpiryFor(token);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Rotate the `TokenRegistry` pointer. Owner-only. Intended
    ///         for a TokenRegistry replacement deploy; per-token issuer
    ///         rotation happens inside the registry itself.
    function setTokenRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        tokenRegistry = ITokenRegistry(newRegistry);
        emit TokenRegistryUpdated(newRegistry);
    }

    /// @notice Rotate the PUSDC pointer. Owner-only. Intended for the
    ///         ADR-008 exit (PUSDC redeploys under cofhe-contracts ≥ v0.1.0).
    function setPUSDC(address newPusdc) external onlyOwner {
        if (newPusdc == address(0)) revert ZeroAddress();
        pusdc = newPusdc;
        emit PUSDCUpdated(newPusdc);
    }

    /// @notice Override the per-token claim-expiry window. Zero resets
    ///         to the default. Owner-only — issuer shouldn't unilaterally
    ///         shorten their own investors' claim window. Bounded to
    ///         `[MIN_CLAIM_EXPIRY, MAX_CLAIM_EXPIRY]` to prevent footguns.
    function setClaimExpiry(address token, uint256 newSeconds) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (newSeconds != 0 && (newSeconds < MIN_CLAIM_EXPIRY || newSeconds > MAX_CLAIM_EXPIRY)) {
            revert InvalidClaimExpiry();
        }
        claimExpirySeconds[token] = newSeconds;
        emit ClaimExpiryUpdated(token, newSeconds);
    }

    /// @notice Rotate governance ownership. Owner-only.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _issuerOf(address token) internal view returns (address) {
        return tokenRegistry.getConfig(token).issuer;
    }

    function _claimExpiryFor(address token) internal view returns (uint256) {
        uint256 custom = claimExpirySeconds[token];
        return custom == 0 ? DEFAULT_CLAIM_EXPIRY : custom;
    }
}
