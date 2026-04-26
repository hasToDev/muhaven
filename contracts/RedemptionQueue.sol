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
import {IMuHavenStable} from "./interfaces/IMuHavenStable.sol";

/// @title RedemptionQueue
/// @notice Per-token overflow redemption queue per ADR-004. Settles the
///         redemption tail when `MuHavenSubscription.redeem` would blow
///         through the per-epoch instant-redeem cap. Deployed behind an
///         OZ Transparent Proxy — one instance per RWA token.
///
/// @dev Flow (Phase 7.6 / ADR-NEW-1 — settlement collapsed into processEpoch):
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
///        `encProceeds = FHE.mul(encShares, nav)` per request, narrowed to
///        `euint64` (cleartext `maxSharesHint * nav` guard per ADR-031
///        prevents truncation). Per Phase 7.6 / ADR-NEW-1 the same loop now
///        also pulls mhUSDC `treasury → request.investor` via the wrapper's
///        modern surface, captures `actualPaid`, and conditionally burns or
///        refunds the locked shares using the share/cash silent-fail mirror:
///          - cash-paid (`actualPaid == encProceeds`):
///              `burnFromQueue(r.encShares)` + `returnToInvestor(0)`
///          - cash-short (`actualPaid == 0` per the wrapper's binary
///            silent-fail): `burnFromQueue(0)` + `returnToInvestor(r.encShares)`
///        Both branches reduce queue balance by exactly `r.encShares` so the
///        `encryptedTotalSupply`-vs-circulating invariant holds. Settlement
///        flips both `r.settled` and `r.claimed` so the legacy `claim()` path
///        becomes vestigial.
///      - Claim: vestigial as of Phase 7.6 — `processEpoch` already paid the
///        investor's mhUSDC at settlement (or refunded the shares on
///        treasury-short). Calling `claim(requestId)` after settlement
///        reverts with `AlreadyClaimed`. Kept on the surface for ABI /
///        frontend / SDK compatibility during cutover; pre-cutover deploys
///        that still hold un-settled requests under the Phase 5 model can
///        retire `claim` once those requests drain.
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

    /// @notice mhUSDC wrapper address (`MuHavenStable`). Immutable post-init.
    ///         Phase 7.6 calls the wrapper's modern `transferFrom` exclusively;
    ///         no legacy ADR-008 selector path remains in this contract.
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
    /// @dev Vestigial as of Phase 7.6 / ADR-NEW-1 — `processEpoch` now pays
    ///      mhUSDC + flips `r.claimed` atomically at settlement. This
    ///      function is retained on the surface for ABI / SDK / frontend
    ///      compatibility during cutover; in steady state every call here
    ///      reverts on one of the existing precondition checks
    ///      (`AlreadyClaimed` for processed requests, `NotSettled` for
    ///      pending ones, `AlreadyCancelled` / `UnknownRequest` /
    ///      `WrongInvestor` for the obvious cases). No external call paths
    ///      remain.
    function claim(uint256 requestId) external nonReentrant {
        Request storage r = _requests[requestId];
        if (r.investor == address(0)) revert UnknownRequest();
        if (msg.sender != r.investor) revert WrongInvestor();
        if (r.cancelled) revert AlreadyCancelled();
        if (!r.settled) revert NotSettled();
        // Phase 7.6: every settled request has `claimed == true` already
        // (set inside `processEpoch`), so this branch is the only landing.
        if (r.claimed) revert AlreadyClaimed();
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
    ///
    ///      Phase 7.6 / ADR-NEW-1: settlement now pulls mhUSDC `treasury →
    ///      r.investor` per request via `IMuHavenStable.transferFrom` and
    ///      conditionally burns / refunds the locked shares using the
    ///      share/cash silent-fail mirror. Investor's per-request outcome:
    ///        - `actualPaid == encProceeds` (cash-paid): burn r.encShares,
    ///          refund 0. Investor: -shares, +mhUSDC.
    ///        - `actualPaid == 0` (treasury-short, wrapper silent-fail):
    ///          burn 0, refund r.encShares. Investor: 0 net change.
    ///      Both branches reduce queue's balance by exactly r.encShares so
    ///      the encryptedTotalSupply-vs-circulating invariant holds. The
    ///      flag flip is `settled = claimed = true` so the legacy
    ///      `claim(requestId)` path is closed for processed requests.
    /// @dev In-memory bundle of hot pointers passed into per-request
    ///      settlement so the loop doesn't redundantly SLOAD / staticcall
    ///      per iteration and the helper stays under the 0.8.28 stack-frame
    ///      limit without `viaIR`. Memory-struct-by-ref counts as one
    ///      stack slot regardless of field count.
    struct SettleContext {
        address treasuryAddr;
        address comp;
    }

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

        // Cache hot pointers for the per-request loop. ADR-032: queue
        // fires `destroyed` on settlement; cleartext amount = `maxSharesHint`.
        SettleContext memory ctx = SettleContext({
            treasuryAddr: cfg.treasury,
            comp: _tokenCompliance()
        });

        uint256 processed = 0;
        for (uint256 i = startIdx; i < endIdx; i++) {
            uint256 rid = ids[i];
            Request storage r = _requests[rid];

            // Skip already-terminal requests so re-running processEpoch over
            // the same slice is idempotent. Crucially — every observable
            // side-effect (mhUSDC pull, share burn, refund, state-hook
            // fire) lives inside this branch so a re-run can't double-pay
            // an investor or double-count module trackers (MaxHolders,
            // MaxBalance, Lockup).
            if (r.settled || r.cancelled) continue;

            _settleRequest(r, rid, encNav, nav, ctx);
            processed++;
        }

        emit EpochProcessed(epochId, processed);
    }

    /// @dev Per-request settlement path — extracted so `processEpoch`
    ///      stays under the stack-frame limit at 0.8.28 without `viaIR`.
    ///      Computes the cleartext width guard + NAV-driven proceeds, then
    ///      delegates to `_pullAndMirror` for the mhUSDC pull + conditional
    ///      burn/refund mirror. Final state-hook fan-out + flag flip lives
    ///      here so the helper has the request reference + cached `comp`
    ///      pointer in a single slot frame. Caller must have already
    ///      validated the request is non-terminal.
    function _settleRequest(
        Request storage r,
        uint256 requestId,
        euint128 encNav,
        uint256 navCleartext,
        SettleContext memory ctx
    ) internal {
        // Cleartext width guard per ADR-031. Loud-reverts (structural
        // overflow, not normal silent-fail). Per-request because each
        // investor picks their own bound.
        if (uint256(r.maxSharesHint) * navCleartext > type(uint64).max) {
            revert CostOverflowsPUSDCWidth();
        }

        // r.encShares is the silent-fail-bounded actualPulled from submit.
        // Guaranteed `actualPulled <= maxSharesHint` via the submit-time
        // hint gate, so actualProceeds <= hint*nav <= u64.
        FHE.allowThis(r.encShares);

        // Compute proceeds + narrow to mhUSDC width.
        euint128 encProceeds128 = FHE.mul(r.encShares, encNav);
        FHE.allowThis(encProceeds128);
        FHE.allow(encProceeds128, r.ephemeralEOA);
        r.encProceeds = encProceeds128;

        euint64 encProceeds64 = FHE.asEuint64(encProceeds128);
        FHE.allowThis(encProceeds64);
        // Wrapper needs ACL on the handle to run its silent-fail math
        // (`FHE.lte`, `FHE.select`) inside `transferFrom`.
        FHE.allow(encProceeds64, pusdc);

        // Pull mhUSDC + mirror cash-leg outcome onto the share leg.
        _pullAndMirror(r, encProceeds64, ctx.treasuryAddr);

        // Flip terminal flags atomically. Both `settled` and `claimed` are
        // set so the vestigial `claim()` surface always reverts
        // `AlreadyClaimed` on processed requests (Phase 7.6 / ADR-NEW-1).
        r.settled = true;
        r.claimed = true;

        // Compliance `destroyed` state-hook (ADR-032). Fires on both
        // cash-paid AND refund branches — hooks are bound to the cleartext
        // hint per ADR-019, not to settlement outcome. The refund branch
        // doesn't fire a compensating `created` (`returnToInvestor` doesn't
        // re-notify), matching the Subscription.redeem-refund behaviour
        // where mintFromSubscription also skips the state-hook fan-out.
        if (ctx.comp != address(0)) {
            IModularCompliance(ctx.comp).destroyed(
                token,
                r.investor,
                uint256(r.maxSharesHint)
            );
        }

        // Settlement payout event (mhUSDC pulled to investor OR refund
        // shares returned). Mirrors the legacy `QueueClaimed` shape so
        // existing indexers track auto-claim events without delta.
        emit QueueClaimed(r.investor, requestId);
    }

    /// @dev mhUSDC pull + share-leg mirror. Pulls `encProceeds64` from
    ///      `treasuryAddr` to `r.investor` via the wrapper's modern surface,
    ///      captures the silent-fail-bounded `actualPaid`, then either:
    ///        - cash-paid (`actualPaid == encProceeds64`): burn `r.encShares`
    ///          from queue, return 0 to investor.
    ///        - cash-short (`actualPaid == 0`): burn 0 from queue, return
    ///          `r.encShares` to investor.
    ///      Both branches reduce queue's balance by exactly `r.encShares`,
    ///      preserving the `encryptedTotalSupply`-vs-circulating invariant.
    function _pullAndMirror(
        Request storage r,
        euint64 encProceeds64,
        address treasuryAddr
    ) internal {
        // mhUSDC pull treasury → investor. The wrapper's `actualPaid` is
        // silent-fail-bounded: `encProceeds64` if treasury can cover, 0
        // otherwise.
        //
        // Phase 7.6-E / ADR-044 — split-grant 5-arg surface: investor's
        // `r.ephemeralEOA` grants only on the recipient (investor) leg; the
        // sender (treasury) leg's resulting balance handle stays kernel-only.
        // Closes audit-prep §A-9 — without this split, every queue
        // settlement would leak the treasury's mhUSDC float to the
        // settling investor's session.
        euint64 actualPaid = IMuHavenStable(pusdc).transferFrom(
            treasuryAddr,
            r.investor,
            encProceeds64,
            address(0),         // fromEph — suppress treasury-leg grant
            r.ephemeralEOA      // toEph   — investor's session
        );
        FHE.allowThis(actualPaid);

        // Build conditional share amounts — burn full + refund 0 on
        // cash-paid; burn 0 + refund full on cash-short.
        ebool fullPay = FHE.eq(actualPaid, encProceeds64);
        FHE.allowThis(fullPay);

        euint128 zero128 = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero128);

        euint128 sharesToBurn = FHE.select(fullPay, r.encShares, zero128);
        FHE.allowThis(sharesToBurn);
        FHE.allow(sharesToBurn, token);

        euint128 sharesToReturn = FHE.select(fullPay, zero128, r.encShares);
        FHE.allowThis(sharesToReturn);
        FHE.allow(sharesToReturn, token);

        // `actualBurned` from burnFromQueue is granted ACL to this contract
        // inside the token but not used further — kept as a hook for any
        // future settlement extension that wants to mirror burn outcome.
        euint128 actualBurned = IMuHavenToken(token).burnFromQueue(sharesToBurn);
        FHE.allowThis(actualBurned);
        IMuHavenToken(token).returnToInvestor(r.investor, sharesToReturn, r.ephemeralEOA);
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
