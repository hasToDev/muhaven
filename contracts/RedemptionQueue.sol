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
import {IRedemptionQueue} from "./interfaces/IRedemptionQueue.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMuHavenIdentityRegistry} from "./interfaces/IMuHavenIdentityRegistry.sol";
import {IModularCompliance} from "./interfaces/IModularCompliance.sol";

/// @title RedemptionQueue
/// @notice Per-token overflow redemption queue per ADR-004. Settles the
///         redemption tail when `MuHavenSubscription.redeem` would blow
///         through the per-epoch instant-redeem cap. Deployed behind an
///         OZ Transparent Proxy — one instance per RWA token.
///
/// @dev Flow:
///      - Investor direct: investor calls `submit(encShares, maxSharesHint,
///        ephemeralEOA)`. The queue calls `token.pullFromInvestor(investor,
///        encSharesBounded, eph)` which silent-fails on insufficient balance
///        and returns `actualPulled`. ADR-036 — the queue stores
///        `actualPulled` as `request.encShares` so a zero-pull can never
///        translate to a non-zero payout at processEpoch.
///      - Escalation: `MuHavenSubscription.redeem` detects cap overflow and
///        calls `submitFor(investor, ...)`. Same share-pull mechanics;
///        `investor` is the one on the request (not Subscription).
///      - Settlement: issuer calls `processEpoch(epochId, startIdx, endIdx)`
///        in paginated slices. One oracle read drives
///        `encProceeds = FHE.mul(encShares, nav)`; each request's proceeds
///        are narrowed to `euint64` (cleartext `maxSharesHint * nav` guard
///        per ADR-031 prevents truncation), ACL-granted to the captured
///        `ephemeralEOA`, and marked settled. The queue also burns its own
///        share balance equal to each request's `encShares` via
///        `token.burnFromQueue` — this fires the token-side `Transfer(from,
///        0)` and keeps `encryptedTotalSupply` consistent with circulating.
///      - Claim: investor calls `claim(requestId)` to pull PUSDC from the
///        treasury. PUSDC transfer uses the legacy `confidentialTransferFrom
///        (address,address,uint256)` selector per ADR-008; the treasury
///        pre-granted queue operator rights at its `initialize`.
///
///      Storage is derived from `TokenRegistry` (oracle / treasury / issuer
///      / epochDuration), matching `MuHavenSubscription`'s pattern. Rotations
///      propagate immediately; no cached pointers that can drift from the
///      registry.
///
///      KYC-revocation cancel: issuer-only; returns the locked shares via
///      `token.returnToInvestor(investor, encShares, eph)` which skips the
///      compliance gate (investor is KYC-revoked by construction). Per
///      ADR-027 the issuer calls cancel BEFORE any hard-block of the
///      investor's address so the recipient can still decrypt the refunded
///      balance handle.
contract RedemptionQueue is Initializable, ReentrancyGuardTransient, IRedemptionQueue {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @notice Rotatable governance address. Owns setters for subscription
    ///         + identity registry rotation.
    address public owner;

    /// @notice Bound RWA token — immutable post-init.
    address public override token;

    /// @notice PUSDC (ConfidentialUSDC) address — immutable post-init.
    address public pusdc;

    /// @notice Per-token config registry (ADR-024). Source of truth for
    ///         treasury / oracle / issuer / epochDuration.
    ITokenRegistry public tokenRegistry;

    /// @notice Trusted caller for `submitFor` (the bound
    ///         `MuHavenSubscription`). Set at init, rotatable via
    ///         `setSubscription`.
    address public subscription;

    /// @notice Identity registry used for KYC-revocation checks in
    ///         `cancelOnKYCRevocation`. Set via `setIdentityRegistry`; zero
    ///         disables the cancel path.
    address public identityRegistry;

    /// @notice Sequential request id. Starts at 1 (id 0 reserved for "none").
    uint256 public override nextRequestId;

    /// @notice Per-id request storage.
    mapping(uint256 => Request) private _requests;

    /// @notice Per-epoch request id list. Preserves insertion order for
    ///         paginated `processEpoch` + event-log reconstruction.
    mapping(uint256 => uint256[]) private _epochRequests;

    /// @dev Reserved storage for future upgrades (proxy-safe gap). Seven
    ///      single slots + two mappings = 9 slots; keep 41 reserved so the
    ///      own-storage footprint totals 50 (matches TokenRegistry /
    ///      Subscription / Treasury convention).
    uint256[41] private __gap;

    // ── Constants ────────────────────────────────────────────────────────

    /// @dev Selector for `confidentialTransferFrom(address,address,uint256)` —
    ///      legacy pre-v0.1.0 ConfidentialUSDC ABI per ADR-008. Pulls PUSDC
    ///      from the treasury (queue is a pre-granted operator) to the
    ///      claiming investor.
    bytes4 private constant _TRANSFER_FROM_UINT256 =
        bytes4(keccak256("confidentialTransferFrom(address,address,uint256)"));

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyIssuer() {
        if (msg.sender != _issuer()) revert OnlyIssuer();
        _;
    }

    modifier onlySubscription() {
        if (msg.sender != subscription) revert OnlySubscription();
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
    /// @param _token          Bound RWA token address.
    /// @param _tokenRegistry  `TokenRegistry` pointer (ADR-024) — source
    ///                        of truth for oracle / treasury / issuer.
    /// @param _subscription   Bound `MuHavenSubscription` (trusted caller
    ///                        for `submitFor`).
    /// @param _pusdc          PUSDC (ConfidentialUSDC) address.
    function initialize(
        address _owner,
        address _token,
        address _tokenRegistry,
        address _subscription,
        address _pusdc
    ) external initializer {
        if (
            _owner == address(0) ||
            _token == address(0) ||
            _tokenRegistry == address(0) ||
            _subscription == address(0) ||
            _pusdc == address(0)
        ) revert ZeroAddress();

        owner = _owner;
        token = _token;
        tokenRegistry = ITokenRegistry(_tokenRegistry);
        subscription = _subscription;
        pusdc = _pusdc;
        nextRequestId = 1;
    }

    // ── Investor hot path ────────────────────────────────────────────────

    /// @inheritdoc IRedemptionQueue
    function submit(
        InEuint128 calldata encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external nonReentrant returns (uint256 requestId) {
        // Verify the client-encrypted input here — the investor signed it
        // for this queue contract's address.
        euint128 encSharesIn = FHE.asEuint128(encShares);
        FHE.allowThis(encSharesIn);
        return _submit(msg.sender, encSharesIn, maxSharesHint, ephemeralEOA);
    }

    /// @inheritdoc IRedemptionQueue
    /// @dev `msg.sender` must be the bound Subscription contract.
    ///      Subscription has already verified the client-encrypted
    ///      `InEuint128` via its own `FHE.asEuint128` call (and bounded it
    ///      against the investor's cleartext hint). The queue receives the
    ///      resulting `euint128` handle with ACL grants already extended
    ///      to the queue by the Subscription before the call. The queue
    ///      still re-runs every cleartext gate against `investor` to keep
    ///      its entry invariants self-contained — defence-in-depth if a
    ///      future Subscription skips a check.
    function submitFor(
        address investor,
        euint128 encShares,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) external nonReentrant onlySubscription returns (uint256 requestId) {
        if (investor == address(0)) revert ZeroAddress();
        // Defensive re-grant — Subscription already did this, but costs
        // nothing and protects against a misbehaving caller.
        FHE.allowThis(encShares);
        return _submit(investor, encShares, maxSharesHint, ephemeralEOA);
    }

    /// @inheritdoc IRedemptionQueue
    function claim(uint256 requestId) external nonReentrant {
        Request storage r = _requests[requestId];
        if (r.investor == address(0)) revert UnknownRequest();
        if (msg.sender != r.investor) revert WrongInvestor();
        if (r.cancelled) revert AlreadyCancelled();
        if (!r.settled) revert NotSettled();
        if (r.claimed) revert AlreadyClaimed();

        // Flip the flag BEFORE the external PUSDC call. Transient
        // reentrancy guard is the primary defence; this is belt + braces.
        r.claimed = true;

        // Narrow-copy the stored 128-bit proceeds handle to PUSDC's 64-bit
        // width. At processEpoch we guaranteed the true value fits in
        // euint64 (ADR-031 cleartext width guard), so the narrow cannot
        // truncate.
        euint64 encProceeds = FHE.asEuint64(r.encProceeds);
        FHE.allowThis(encProceeds);
        FHE.allow(encProceeds, pusdc);

        address treasuryAddr = _treasury();
        (bool ok, ) = pusdc.call(
            abi.encodeWithSelector(
                _TRANSFER_FROM_UINT256,
                treasuryAddr,
                msg.sender,
                uint256(euint64.unwrap(encProceeds))
            )
        );
        if (!ok) revert PaymentTransferFailed();

        emit QueueClaimed(msg.sender, requestId);
    }

    // ── Issuer cold path ─────────────────────────────────────────────────

    /// @inheritdoc IRedemptionQueue
    /// @dev Paginates over `_epochRequests[epochId][startIdx..endIdx)`. A
    ///      single oracle read at the top drives every request's
    ///      `encProceeds = FHE.mul(encShares, nav)` — NAV is captured at
    ///      processing time, not submission time (ADR-004 rationale: NAV
    ///      can drift during the queue window). Already-terminal requests
    ///      (settled / cancelled) are skipped silently — idempotent
    ///      re-runs over the same slice are safe.
    function processEpoch(
        uint256 epochId,
        uint256 startIdx,
        uint256 endIdx
    ) external nonReentrant onlyIssuer {
        uint256[] storage ids = _epochRequests[epochId];
        uint256 n = ids.length;
        if (startIdx > endIdx) revert InvalidRange();
        if (endIdx > n) revert InvalidRange();

        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
        if (!cfg.active) revert TokenNotRegistered();
        if (cfg.paused) revert TokenPaused();

        IPriceOracle oracle = IPriceOracle(cfg.oracle);
        (uint256 nav, ) = oracle.getNAV(token);
        if (nav == 0) revert OracleReturnedZero();
        if (!oracle.isFresh(token)) revert StaleNAV();

        euint128 encNav = FHE.asEuint128(nav);
        FHE.allowThis(encNav);

        IMuHavenToken muToken = IMuHavenToken(token);
        // Cache the token's compliance coordinator so the state-hook fire
        // doesn't do a staticcall per request. ADR-032: queue fires
        // `destroyed` on settlement; cleartext amount = `maxSharesHint`.
        address comp = _tokenCompliance();

        uint256 processed = 0;
        for (uint256 i = startIdx; i < endIdx; i++) {
            uint256 rid = ids[i];
            Request storage r = _requests[rid];

            // Skip already-terminal requests so re-running processEpoch over
            // the same slice is idempotent. Crucially — the `destroyed`
            // state-hook fire also lives inside this branch so a re-run
            // doesn't double-count module trackers (MaxHolders,
            // MaxBalance, Lockup).
            if (r.settled || r.cancelled) continue;

            // Cleartext width guard per ADR-031. Loud-reverts (structural
            // overflow, not normal silent-fail). Per-request because each
            // investor picks their own bound.
            if (uint256(r.maxSharesHint) * nav > type(uint64).max) {
                revert CostOverflowsPUSDCWidth();
            }

            // r.encShares is the silent-fail-bounded actualPulled from
            // submit. Guaranteed `actualPulled <= maxSharesHint` via the
            // submit-time hint gate, so actualProceeds <= hint*nav <= u64.
            FHE.allowThis(r.encShares);

            euint128 encProceeds128 = FHE.mul(r.encShares, encNav);
            FHE.allowThis(encProceeds128);

            // Grant investor's ephemeralEOA on the stored 128-bit handle
            // per Rule 2. PUSDC-side ACL is granted at claim-time narrow.
            FHE.allow(encProceeds128, r.ephemeralEOA);
            r.encProceeds = encProceeds128;

            // Burn the queue's locked shares for this request — keeps
            // encryptedTotalSupply consistent with circulating supply and
            // fires the token-side `Transfer(queue, 0)` event. Silent-
            // fails to zero if the queue's balance is somehow below the
            // request amount (shouldn't happen — shares were just pulled
            // at submit — but defence-in-depth).
            euint128 actualBurned = muToken.burnFromQueue(r.encShares);
            // `actualBurned` is not consumed further; it's returned for
            // symmetry with `burnFromSubscription`. Granted ACL to this
            // contract inside the token so downstream operators of the
            // handle don't ACL-fail if we ever extend settlement logic.
            FHE.allowThis(actualBurned);

            r.settled = true;
            processed++;

            // Compliance `destroyed` state-hook fire (ADR-032). One fan-
            // out per newly-settled request so per-wallet counters
            // (MaxHolders, MaxBalance) see each settlement exactly once.
            if (comp != address(0)) {
                IModularCompliance(comp).destroyed(
                    token,
                    r.investor,
                    uint256(r.maxSharesHint)
                );
            }
        }

        emit EpochProcessed(epochId, processed);
    }

    /// @inheritdoc IRedemptionQueue
    /// @dev Returns locked shares to the investor via
    ///      `token.returnToInvestor` (skips compliance per ADR-027). The
    ///      investor must currently be `!identityRegistry.isVerified` —
    ///      else the cancel reverts loudly to prevent accidental refunds.
    function cancelOnKYCRevocation(uint256 requestId) external nonReentrant onlyIssuer {
        Request storage r = _requests[requestId];
        if (r.investor == address(0)) revert UnknownRequest();
        if (r.settled) revert AlreadySettled();
        if (r.claimed) revert AlreadyClaimed();
        if (r.cancelled) revert AlreadyCancelled();

        if (identityRegistry == address(0)) revert ZeroAddress();
        if (IMuHavenIdentityRegistry(identityRegistry).isVerified(r.investor)) {
            revert InvestorStillVerified();
        }

        r.cancelled = true;

        // Return the locked shares to the investor. `returnToInvestor`
        // bypasses the compliance gate (investor is KYC-revoked — a gated
        // return would brick every legitimate cancel).
        FHE.allowThis(r.encShares);
        FHE.allow(r.encShares, token);
        IMuHavenToken(token).returnToInvestor(r.investor, r.encShares, r.ephemeralEOA);

        emit QueueCancelled(r.investor, requestId);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Rotate governance ownership. Owner-only.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /// @notice Rotate the trusted Subscription pointer. Owner-only.
    function setSubscription(address newSubscription) external onlyOwner {
        if (newSubscription == address(0)) revert ZeroAddress();
        subscription = newSubscription;
        emit SubscriptionUpdated(newSubscription);
    }

    /// @notice Set the identity registry used for KYC-revocation checks.
    ///         Owner-only. Zero disables the cancel path (cancel reverts).
    function setIdentityRegistry(address newRegistry) external onlyOwner {
        identityRegistry = newRegistry;
        emit IdentityRegistryUpdated(newRegistry);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @inheritdoc IRedemptionQueue
    function treasury() external view returns (address) {
        return _treasury();
    }

    /// @inheritdoc IRedemptionQueue
    function issuer() external view returns (address) {
        return _issuer();
    }

    /// @inheritdoc IRedemptionQueue
    /// @dev Time-based epoch derived from the token config — matches
    ///      `MuHavenSubscription.getCurrentEpoch` so the two contracts
    ///      agree on the current epoch without extra synchronisation.
    function currentEpoch() external view returns (uint256) {
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
        if (!cfg.active || cfg.epochDuration == 0) return 0;
        return block.timestamp / uint256(cfg.epochDuration);
    }

    /// @inheritdoc IRedemptionQueue
    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    /// @inheritdoc IRedemptionQueue
    function getEpochRequests(uint256 epochId) external view returns (uint256[] memory) {
        return _epochRequests[epochId];
    }

    // ── Internals ────────────────────────────────────────────────────────

    /// @dev Core submit path shared by `submit` (investor direct) and
    ///      `submitFor` (Subscription auto-escalate). Runs every cleartext
    ///      gate, pulls shares via `token.pullFromInvestor` (returns
    ///      silent-fail-bounded actualPulled per ADR-036), and writes the
    ///      request entry.
    /// @param encSharesIn  Already-verified `euint128` handle. `submit`
    ///                     materialises this from an `InEuint128`;
    ///                     `submitFor` receives it directly from the
    ///                     Subscription (which already materialised it via
    ///                     its own `FHE.asEuint128(InEuint128)` call).
    function _submit(
        address investor,
        euint128 encSharesIn,
        uint128 maxSharesHint,
        address ephemeralEOA
    ) internal returns (uint256 requestId) {
        // ── Cleartext gates (Rule 4) ──
        if (ephemeralEOA == address(0)) revert InvalidEphemeralEOA();
        if (maxSharesHint == 0) revert InvalidMaxSharesHint();

        uint256 epochId;
        // Block-scope the TokenConfig + oracle read so locals release the
        // stack before the FHE math block runs. Only `epochId` outlives.
        {
            ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfig(token);
            if (!cfg.active) revert TokenNotRegistered();
            if (cfg.paused) revert TokenPaused();
            if (maxSharesHint < cfg.minInvestment) revert InvalidMaxSharesHint();

            _requireEligible(investor);
            // Burn convention — the shares are en-route to destruction at
            // processEpoch. Matches MuHavenSubscription.redeem direction per
            // ADR-032.
            _requireCompliance(investor, address(0), uint256(maxSharesHint));

            // Freshness read (defence-in-depth — processEpoch re-checks, but
            // keeping submit from accepting against a dead oracle avoids
            // wasted share locks).
            IPriceOracle oracle = IPriceOracle(cfg.oracle);
            (uint256 nav, ) = oracle.getNAV(token);
            if (nav == 0) revert OracleReturnedZero();
            if (!oracle.isFresh(token)) revert StaleNAV();

            // Cleartext width guard per ADR-031.
            if (uint256(maxSharesHint) * nav > type(uint64).max) {
                revert CostOverflowsPUSDCWidth();
            }

            epochId = _currentEpoch(cfg.epochDuration);
        }

        // ── Silent-fail hint gate + pull (Rule 5) ──
        euint128 actualPulled;
        {
            FHE.allowThis(encSharesIn);

            euint128 encHint = FHE.asEuint128(uint256(maxSharesHint));
            FHE.allowThis(encHint);

            ebool withinHint = FHE.lte(encSharesIn, encHint);
            FHE.allowThis(withinHint);

            euint128 zero128 = FHE.asEuint128(uint256(0));
            FHE.allowThis(zero128);

            euint128 encSharesBounded = FHE.select(withinHint, encSharesIn, zero128);
            FHE.allowThis(encSharesBounded);

            // Token needs ACL on the handle to run its silent-fail math in
            // `pullFromInvestor`.
            FHE.allow(encSharesBounded, token);

            actualPulled = IMuHavenToken(token).pullFromInvestor(
                investor,
                encSharesBounded,
                ephemeralEOA
            );
            FHE.allowThis(actualPulled);
            // Grant investor's ephemeralEOA on the locked handle so they
            // can verify what's queued on their behalf (Rule 2).
            FHE.allow(actualPulled, ephemeralEOA);
        }

        // ── Write the request ──
        requestId = nextRequestId++;

        Request storage r = _requests[requestId];
        r.investor = investor;
        r.encShares = actualPulled;
        r.epochId = epochId;
        r.ephemeralEOA = ephemeralEOA;
        r.maxSharesHint = maxSharesHint;

        _epochRequests[epochId].push(requestId);

        emit QueueSubmitted(investor, requestId, epochId);
    }

    /// @dev Resolve eligibility via the token's own gate hierarchy —
    ///      mirrors `MuHavenToken._isEligible` so direct submits track the
    ///      exact same rules the token applies to transferFrom on this
    ///      investor. Order:
    ///        1. `token.identityRegistry()` (Phase 3+ canonical) when wired.
    ///        2. `token.kycGate()` (Wave 3 carry-over) otherwise.
    ///      The queue's own `identityRegistry` slot is reserved for the
    ///      cancel-on-revocation path (a different semantic — we want to
    ///      detect a REVOKED account, not a currently-verified one).
    function _requireEligible(address account) internal view {
        address tokenReg = _tokenIdentityRegistry();
        if (tokenReg != address(0)) {
            if (!IMuHavenIdentityRegistry(tokenReg).isVerified(account)) {
                revert NotEligible();
            }
            return;
        }
        // Fall back to the token's legacy kycGate.
        address gate = _tokenKycGate();
        if (gate == address(0)) {
            // No eligibility surface at all on the token — treat as
            // misconfiguration and revert loudly.
            revert NotEligible();
        }
        if (!_isEligibleOnGate(gate, account)) revert NotEligible();
    }

    /// @dev Read the token's `kycGate` pointer via staticcall. Soft-fail
    ///      to zero address if the call pattern differs (future interface
    ///      tweak shouldn't brick the queue).
    function _tokenKycGate() internal view returns (address gate) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("kycGate()")
        );
        if (!ok || data.length < 32) return address(0);
        gate = abi.decode(data, (address));
    }

    /// @dev Call `isEligible(address)` on the KYC gate. Soft-fail to false
    ///      if the call pattern differs.
    function _isEligibleOnGate(address gate, address account)
        internal
        view
        returns (bool eligible)
    {
        (bool ok, bytes memory data) = gate.staticcall(
            abi.encodeWithSignature("isEligible(address)", account)
        );
        if (!ok || data.length < 32) return false;
        eligible = abi.decode(data, (bool));
    }

    /// @dev Read the token's modularCompliance and, if wired, gate via
    ///      `canTransfer`. ADR-034: the token owns the compliance pointer.
    function _requireCompliance(
        address from,
        address to,
        uint256 amount
    ) internal view {
        address comp = _tokenCompliance();
        if (comp == address(0)) return;
        if (!IModularCompliance(comp).canTransfer(token, from, to, amount)) {
            revert ComplianceBlocked();
        }
    }

    function _tokenCompliance() internal view returns (address) {
        return IMuHavenToken(token).modularCompliance();
    }

    function _tokenIdentityRegistry() internal view returns (address reg) {
        // Read via staticcall because the interface surface is narrow; the
        // token's `identityRegistry()` getter exists as a public state
        // variable accessor. Soft-fail (return zero) on any call failure so
        // a future interface tweak doesn't brick the queue.
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("identityRegistry()")
        );
        if (!ok || data.length < 32) return address(0);
        reg = abi.decode(data, (address));
    }

    function _treasury() internal view returns (address) {
        return tokenRegistry.getConfig(token).treasury;
    }

    function _issuer() internal view returns (address) {
        return tokenRegistry.getConfig(token).issuer;
    }

    function _currentEpoch(uint32 epochDuration) internal view returns (uint256) {
        if (epochDuration == 0) return 0;
        return block.timestamp / uint256(epochDuration);
    }
}
