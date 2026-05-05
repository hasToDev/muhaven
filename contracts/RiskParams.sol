// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    FHE,
    ebool,
    euint64,
    InEuint64,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title RiskParams
/// @notice Encrypted per-investor risk guardrails + Wave-4 hot-path policy
///         engine. Investors store encrypted thresholds via `setRiskParams`;
///         the platform owner (cron policy engine) calls `checkAndExecute`
///         every tick to evaluate the current candidate spend against those
///         thresholds without leaking the values.
///
/// @dev Wave 4 P6 additions on top of the Wave 3.5 carry-over:
///   - `checkAndExecute(eAmount, actionId)` returning `(ebool, uint8)` for
///     branchless hot-path policy enforcement (no decrypt unless settled).
///   - `settleBreachDecrypt` consuming a TN-signed `decryptForTx` payload
///     (off-chain via `cofheClient.decryptForTx`) and committing the breach
///     atomically with `pausedUntil` + `RiskBreach` event.
///   - `computeSignalFlags` returning `ebool`-typed `isOverexposed` /
///     `isUnderYield` for the dashboard's portfolio-summary tile (decryptable
///     by the investor via permit-based `decryptForView`).
///   - `consumeAgentPermit` verifying an investor-signed EIP-712 AgentPermit
///     with monotonic-nonce replay defence — the on-chain authorization
///     surface for tier transitions / Policy-bound action commits.
///
///   Storage rule: every new contract-level slot is accounted for by an
///   equal-sized decrement of `__gap` (50 → 45). Per-investor mappings
///   are added at the contract level (NOT inside `InvestorRisk`) so the
///   struct layout stays stable for proxy upgrades.
///
///   Privacy properties:
///   - Encrypted thresholds never leak. `checkAndExecute` returns an
///     `ebool` handle; only `settleBreachDecrypt` materializes a cleartext
///     and that path requires a TN signature so it cannot be spoofed.
///   - The cleartext breach codes (oracle stale / KYC revoked / user paused)
///     are deliberately non-encrypted: they are the events that trigger
///     human review anyway.
///   - `lastOracleUpdate` / `oracleStalenessSec` are admin-set (owner-tunable).
///     Production NAV worker can write `lastOracleUpdate` from the cron tick.
contract RiskParams is Initializable {

    // ── Constants: ActionId enum (Wave 4 P6, ADR-1 §"actionId") ──────────

    uint8 internal constant ACTION_ID_BUY        = 1;
    uint8 internal constant ACTION_ID_SELL       = 2;
    uint8 internal constant ACTION_ID_CLAIM      = 3;
    uint8 internal constant ACTION_ID_REBALANCE  = 4;
    // 5..255 reserved per ADR-1; new values require UUPS upgrade + ADR amendment

    // ── Constants: cleartext breach codes (Wave 4 P6) ────────────────────

    uint8 internal constant BREACH_NONE            = 0;
    uint8 internal constant BREACH_ORACLE_STALE    = 1;
    uint8 internal constant BREACH_KYC_REVOKED     = 2;
    uint8 internal constant BREACH_USER_PAUSED     = 3;
    uint8 internal constant BREACH_UNKNOWN_ACTION  = 4;
    // 5..255 reserved

    // ── Constants: trigger codes for settled breaches (RiskBreach event) ─

    uint8 internal constant TRIGGER_DRAWDOWN_BREACH = 1;
    uint8 internal constant TRIGGER_DAILY_SPEND     = 2;
    uint8 internal constant TRIGGER_DRIFT           = 3;
    uint8 internal constant TRIGGER_YIELD_FLOOR     = 4;

    // ── Constants: EIP-712 AgentPermit ───────────────────────────────────

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant AGENT_PERMIT_TYPEHASH = keccak256(
        "AgentPermit(address investor,uint8 tier,uint8 surface,uint8 actionId,uint256 maxAmount,uint64 nonce,uint256 expiry)"
    );

    string internal constant DOMAIN_NAME    = "MuHaven AgentPermit";
    string internal constant DOMAIN_VERSION = "1";

    // ── Storage: existing (Wave 3.5; unchanged) ──────────────────────────

    /// @dev All four threshold fields are encrypted. Stored per investor.
    struct InvestorRisk {
        euint64 maxDrawdownBps;
        euint64 minYieldBps;
        euint64 driftToleranceBps;
        euint64 maxDailySpend;
    }

    mapping(address => InvestorRisk) private _riskParams;

    /// @dev `_hasParams[investor]` is the only cleartext indicator that an
    ///      investor has configured risk preferences (Q4→B: no cleartext
    ///      timestamp).
    mapping(address => bool) private _hasParams;

    address public owner;

    // ── Storage: Wave 4 P6 additions ─────────────────────────────────────

    /// @notice KYC gate consulted by `checkAndExecute`. Optional — when
    ///         unset (zero), the cleartext KYC gate is skipped.
    IKYCGate public kycGate;

    /// @notice Last cleartext oracle update timestamp (seconds since epoch).
    ///         Wave 4 P6: admin-set; the NAV worker writes this on each
    ///         oracle tick. When `oracleStalenessSec == 0`, the staleness
    ///         gate is disabled (useful for tests).
    uint64 public lastOracleUpdate;

    /// @notice Maximum tolerated oracle staleness in seconds. Cleartext.
    uint64 public oracleStalenessSec;

    /// @dev Per-investor pause floor. `block.timestamp < _pausedUntil[i]`
    ///      ⇒ all actions cleartext-fail with `BREACH_USER_PAUSED`. Set by
    ///      `settleBreachDecrypt` (to `type(uint32).max`) or by `setUserPaused`
    ///      admin override (cooling-off windows / manual pause).
    mapping(address => uint32) private _pausedUntil;

    /// @dev Reserved for Wave 5 — unix-day epoch on which the investor's
    ///      daily-spend cap was last consumed. P6 ships the slot; the
    ///      reset-on-new-day logic is a Wave 5 deliverable.
    mapping(address => uint32) private _lastSpendEpoch;

    /// @dev Monotonic AgentPermit nonces per investor. Strictly-increasing.
    ///      Replay defence: a permit with `nonce <= _agentPermitNonces[i]`
    ///      is rejected.
    mapping(address => uint64) private _agentPermitNonces;

    // ── Storage: gap (decremented from 50 → 45 by P6's 5 new slots) ──────

    uint256[45] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event RiskParamsUpdated(address indexed investor);
    event RiskParamsDecryptRequested(address indexed investor, address indexed requester);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // Wave 4 P6
    event RiskBreach(
        address indexed investor,
        uint8 indexed triggerCode,
        uint64 thresholdSnapshot,
        uint256 timestamp
    );
    event BreachSettled(address indexed investor, uint8 indexed triggerCode, uint32 pausedUntilTs);
    event KYCGateSet(address indexed previous, address indexed current);
    event OracleFreshnessUpdated(uint64 lastOracleUpdate, uint64 oracleStalenessSec);
    event UserPauseOverride(address indexed investor, uint32 pausedUntilTs);
    event AgentPermitConsumed(address indexed investor, uint64 indexed nonce, uint8 actionId);

    /// @notice Emitted on every `checkAndExecute` call so the off-chain
    ///         policy engine can pick up the result from event logs without
    ///         re-running `simulateContract`. `ePassedHandle` is the raw
    ///         `bytes32` ebool handle — decryptable off-chain via
    ///         `cofheClient.decryptForTx(...)`.
    event PolicyChecked(
        address indexed investor,
        uint8 indexed actionId,
        bytes32 ePassedHandle,
        uint8 breachId
    );

    /// @notice Emitted on every `computeSignalFlags` call so a frontend
    ///         that already submitted the tx can recover the two ebool
    ///         handles from the receipt without an additional view call.
    event SignalsComputed(
        address indexed investor,
        bytes32 isOverexposedHandle,
        bytes32 isUnderYieldHandle
    );

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyOwnerOrInvestor();
    error Unauthorized();
    error NoRiskParams();
    error ZeroAddress();
    error AgentPermitExpired();
    error AgentPermitNonceUsed(uint64 supplied, uint64 lastConsumed);
    error AgentPermitWrongSigner(address recovered, address expected);

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

    // ── Investor: set own risk params (Wave 3.5; unchanged) ──────────────

    function setRiskParams(
        InEuint64 memory encMaxDrawdownBps,
        InEuint64 memory encMinYieldBps,
        InEuint64 memory encDriftToleranceBps,
        InEuint64 memory encMaxDailySpend
    ) external {
        euint64 maxDrawdown = FHE.asEuint64(encMaxDrawdownBps);
        euint64 minYield    = FHE.asEuint64(encMinYieldBps);
        euint64 driftTol    = FHE.asEuint64(encDriftToleranceBps);
        euint64 dailySpend  = FHE.asEuint64(encMaxDailySpend);

        FHE.allowThis(maxDrawdown);
        FHE.allowThis(minYield);
        FHE.allowThis(driftTol);
        FHE.allowThis(dailySpend);

        FHE.allowSender(maxDrawdown);
        FHE.allowSender(minYield);
        FHE.allowSender(driftTol);
        FHE.allowSender(dailySpend);

        _riskParams[msg.sender] = InvestorRisk({
            maxDrawdownBps:     maxDrawdown,
            minYieldBps:        minYield,
            driftToleranceBps:  driftTol,
            maxDailySpend:      dailySpend
        });

        _hasParams[msg.sender] = true;
        emit RiskParamsUpdated(msg.sender);
    }

    // ── Async decrypt (Wave 3.5 legacy; deprecated on testnet) ───────────

    /// @notice Request async decryption of an investor's risk parameters.
    /// @dev Legacy on-chain async path (`createDecryptTask` + polling). Works
    ///      under the cofhe-mocks fixture but is deprecated on Arb Sepolia
    ///      with cofhe-contracts v0.1.3. New code SHOULD use the off-chain
    ///      `cofheClient.decryptForView(...).withPermit().execute()` path
    ///      with the ACL grants applied at `setRiskParams` time.
    function requestRiskParamsDecrypt(address investor) external {
        if (msg.sender != investor && msg.sender != owner) revert Unauthorized();
        if (!_hasParams[investor]) revert NoRiskParams();

        InvestorRisk storage p = _riskParams[investor];

        FHE.allow(p.maxDrawdownBps,    msg.sender);
        FHE.allow(p.minYieldBps,       msg.sender);
        FHE.allow(p.driftToleranceBps, msg.sender);
        FHE.allow(p.maxDailySpend,     msg.sender);

        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint64.unwrap(p.maxDrawdownBps)), msg.sender
        );
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint64.unwrap(p.minYieldBps)), msg.sender
        );
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint64.unwrap(p.driftToleranceBps)), msg.sender
        );
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint64.unwrap(p.maxDailySpend)), msg.sender
        );

        emit RiskParamsDecryptRequested(investor, msg.sender);
    }

    function getRiskParamsDecryptResult(address investor)
        external
        view
        returns (
            uint64 maxDrawdownBps,
            uint64 minYieldBps,
            uint64 driftToleranceBps,
            uint64 maxDailySpend,
            bool d0,
            bool d1,
            bool d2,
            bool d3
        )
    {
        if (!_hasParams[investor]) revert NoRiskParams();
        InvestorRisk storage p = _riskParams[investor];

        (maxDrawdownBps,    d0) = FHE.getDecryptResultSafe(p.maxDrawdownBps);
        (minYieldBps,       d1) = FHE.getDecryptResultSafe(p.minYieldBps);
        (driftToleranceBps, d2) = FHE.getDecryptResultSafe(p.driftToleranceBps);
        (maxDailySpend,     d3) = FHE.getDecryptResultSafe(p.maxDailySpend);
    }

    // ── Wave 4 P6: hot-path policy check ─────────────────────────────────

    /// @notice Branchless hot-path policy check called by the cron policy
    ///         engine and by Policy-bound on-demand actions. Returns an
    ///         encrypted `ePassed` flag plus a cleartext `breachId` for
    ///         non-encrypted breach reasons (oracle stale / KYC revoked /
    ///         user paused / unknown action). The encrypted leg is silent
    ///         — no plaintext-revealing revert.
    ///
    ///         Per ADR-1 §"Branchless hot-path pattern":
    ///         - Cleartext gates run first (Rule 4 in `FHE_ACL_CONVENTIONS.md`).
    ///         - If a cleartext gate triggers, returns `(ebool(false), <code>)`.
    ///         - Otherwise the encrypted threshold comparison happens with
    ///           plaintext-branched dispatch on `actionId` (which is itself
    ///           cleartext — only the threshold is encrypted).
    ///
    /// @param investor    Investor whose policy is being checked.
    /// @param eAmount     Encrypted candidate spend (caller-encrypted).
    /// @param actionId    `ACTION_ID_*` constant identifying the action class.
    /// @return ePassed    Encrypted bool — true ⇒ within the encrypted
    ///                    thresholds. ACL: caller, contract, owner.
    /// @return breachId   `BREACH_*` cleartext code; 0 = no cleartext breach.
    function checkAndExecute(
        address investor,
        InEuint64 calldata eAmount,
        uint8 actionId
    ) external returns (ebool ePassed, uint8 breachId) {
        // Cleartext gates first (FHE_ACL_CONVENTIONS Rule 4).
        if (
            oracleStalenessSec > 0 &&
            block.timestamp > uint256(lastOracleUpdate) + uint256(oracleStalenessSec)
        ) {
            ebool eFail = FHE.asEbool(false);
            emit PolicyChecked(investor, actionId, ebool.unwrap(eFail), BREACH_ORACLE_STALE);
            return (eFail, BREACH_ORACLE_STALE);
        }
        if (address(kycGate) != address(0) && !kycGate.isEligible(investor)) {
            ebool eFail = FHE.asEbool(false);
            emit PolicyChecked(investor, actionId, ebool.unwrap(eFail), BREACH_KYC_REVOKED);
            return (eFail, BREACH_KYC_REVOKED);
        }
        if (uint256(_pausedUntil[investor]) > block.timestamp) {
            ebool eFail = FHE.asEbool(false);
            emit PolicyChecked(investor, actionId, ebool.unwrap(eFail), BREACH_USER_PAUSED);
            return (eFail, BREACH_USER_PAUSED);
        }
        if (!_hasParams[investor]) {
            // No constraints configured — pass without exposing anything.
            ePassed = FHE.asEbool(true);
            FHE.allowThis(ePassed);
            FHE.allowSender(ePassed);
            FHE.allow(ePassed, owner);
            emit PolicyChecked(investor, actionId, ebool.unwrap(ePassed), BREACH_NONE);
            return (ePassed, BREACH_NONE);
        }

        InvestorRisk storage p = _riskParams[investor];
        euint64 amt = FHE.asEuint64(eAmount);

        // Plaintext-branched dispatch on the cleartext `actionId`. The
        // encrypted leg is the threshold comparison only — never the
        // dispatch itself. Per ADR-1: this is what "branchless" means in
        // the FHE sense — no plaintext-revealing revert based on encrypted
        // state.
        if (
            actionId == ACTION_ID_BUY ||
            actionId == ACTION_ID_SELL ||
            actionId == ACTION_ID_REBALANCE
        ) {
            // Spending action — must be ≤ encrypted daily-spend cap.
            ePassed = FHE.lte(amt, p.maxDailySpend);
        } else if (actionId == ACTION_ID_CLAIM) {
            // Claim doesn't spend; always within budget.
            ePassed = FHE.asEbool(true);
        } else {
            // Unknown action — refuse cleartext. Defence in depth — the
            // backend should enum-validate before getting here, but if it
            // doesn't, surface a non-zero breachId so the cron's audit log
            // can flag the call site.
            ebool eFail = FHE.asEbool(false);
            emit PolicyChecked(investor, actionId, ebool.unwrap(eFail), BREACH_UNKNOWN_ACTION);
            return (eFail, BREACH_UNKNOWN_ACTION);
        }

        // ACLs:
        //   - allowThis  → contract retains read access (e.g., for downstream
        //                  composition before settle).
        //   - allowSender → caller (cron / kernel) reads `ePassed` for the
        //                   off-chain `decryptForTx` step.
        //   - allow(owner) → owner-as-permit-signer for the breach-decrypt
        //                    flow when the cron and the platform owner are
        //                    different addresses (rare but possible in
        //                    multi-sig setups).
        FHE.allowThis(ePassed);
        FHE.allowSender(ePassed);
        FHE.allow(ePassed, owner);

        breachId = BREACH_NONE;
        emit PolicyChecked(investor, actionId, ebool.unwrap(ePassed), breachId);
    }

    // ── Wave 4 P6: breach-decrypt settle ─────────────────────────────────

    /// @notice Commit a Threshold-Network-signed breach decrypt against the
    ///         on-chain handle returned by `checkAndExecute`. Caller MUST be
    ///         the platform owner (cron policy engine).
    ///
    ///         Verification semantics: this calls
    ///         `FHE.publishDecryptResult(handle, false, signature)` which
    ///         delegates to the on-chain TaskManager's signature verifier.
    ///         If the TN-signed cleartext was actually `true` (no breach)
    ///         the signature won't verify against `result=false` and the
    ///         call reverts. Operators can therefore only ever land an
    ///         actual breach commit.
    ///
    /// @param investor             Investor whose state is being paused.
    /// @param triggerCode          `TRIGGER_*` taxonomy code for the breach.
    /// @param thresholdSnapshot    Cleartext threshold value at breach time
    ///                             (for the audit log + RiskBreach event).
    /// @param encryptedBreachFlag  The `ePassed` ebool handle returned by
    ///                             `checkAndExecute`.
    /// @param signature            TN-signed signature from
    ///                             `cofheClient.decryptForTx(handle).execute()`.
    function settleBreachDecrypt(
        address investor,
        uint8 triggerCode,
        uint64 thresholdSnapshot,
        ebool encryptedBreachFlag,
        bytes calldata signature
    ) external onlyOwner {
        // Reverts on signature mismatch (i.e., if the cleartext was actually
        // true / "no breach"). After return, the cleartext is published to
        // the TaskManager; subsequent `FHE.getDecryptResult(handle)` reads
        // would yield 0.
        FHE.publishDecryptResult(encryptedBreachFlag, false, signature);

        uint32 pausedUntilTs = type(uint32).max;
        _pausedUntil[investor] = pausedUntilTs;

        emit RiskBreach(investor, triggerCode, thresholdSnapshot, block.timestamp);
        emit BreachSettled(investor, triggerCode, pausedUntilTs);
    }

    // ── Wave 4 P6: encrypted signal flags ────────────────────────────────

    /// @notice Compute the `isOverexposed` / `isUnderYield` ebool flags
    ///         consumed by `muhaven_portfolio_summary` (P2 frontend tool).
    ///         Caller may be the investor or the platform owner; in both
    ///         cases the result handles are FHE-allow-granted to the
    ///         investor so they can `decryptForView` from the dashboard.
    ///
    /// @param investor             Investor whose stored thresholds to use.
    /// @param eCurrentDriftBps     Encrypted current portfolio drift in bps.
    /// @param eCurrentYieldBps     Encrypted current annualised yield in bps.
    /// @return isOverexposed       ebool: currentDrift > driftToleranceBps
    /// @return isUnderYield        ebool: currentYield < minYieldBps
    function computeSignalFlags(
        address investor,
        InEuint64 calldata eCurrentDriftBps,
        InEuint64 calldata eCurrentYieldBps
    ) external returns (ebool isOverexposed, ebool isUnderYield) {
        if (msg.sender != investor && msg.sender != owner) revert OnlyOwnerOrInvestor();
        if (!_hasParams[investor]) revert NoRiskParams();

        InvestorRisk storage p = _riskParams[investor];

        euint64 currentDrift = FHE.asEuint64(eCurrentDriftBps);
        euint64 currentYield = FHE.asEuint64(eCurrentYieldBps);

        isOverexposed = FHE.gt(currentDrift, p.driftToleranceBps);
        isUnderYield  = FHE.lt(currentYield, p.minYieldBps);

        // Contract retains read access for downstream composition.
        FHE.allowThis(isOverexposed);
        FHE.allowThis(isUnderYield);

        // Investor permit-decrypts both flags from the dashboard.
        FHE.allow(isOverexposed, investor);
        FHE.allow(isUnderYield,  investor);

        // If the agent backend called this on the investor's behalf, also
        // grant it permit access (it caches the results before serving them).
        if (msg.sender == owner) {
            FHE.allowSender(isOverexposed);
            FHE.allowSender(isUnderYield);
        }

        emit SignalsComputed(
            investor,
            ebool.unwrap(isOverexposed),
            ebool.unwrap(isUnderYield)
        );
    }

    // ── Wave 4 P6: AgentPermit (EIP-712) ─────────────────────────────────

    /// @notice EIP-712 domain separator for the AgentPermit typed data.
    ///         Computed lazily from `block.chainid` to stay correct across
    ///         hard forks / chainid rotations on the upgradeable proxy.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Hash an AgentPermit struct per EIP-712.
    /// @dev Public for off-chain debugging and SDK parity with the
    ///      backend's TypeScript helper.
    function hashAgentPermit(
        address investor,
        uint8 tier,
        uint8 surface,
        uint8 actionId,
        uint256 maxAmount,
        uint64 nonce,
        uint256 expiry
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AGENT_PERMIT_TYPEHASH,
                investor,
                tier,
                surface,
                actionId,
                maxAmount,
                nonce,
                expiry
            )
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash));
    }

    /// @notice Read-only view: does this signature recover to `investor`
    ///         for the given AgentPermit, AND is the permit live + the
    ///         nonce strictly newer than the consumed floor?
    ///
    ///         Returns false rather than reverting so the backend can
    ///         pre-check before initiating an on-chain consume tx.
    function isAgentPermitValid(
        address investor,
        uint8 tier,
        uint8 surface,
        uint8 actionId,
        uint256 maxAmount,
        uint64 nonce,
        uint256 expiry,
        bytes calldata signature
    ) external view returns (bool) {
        if (block.timestamp > expiry) return false;
        if (nonce <= _agentPermitNonces[investor]) return false;

        bytes32 digest = hashAgentPermit(investor, tier, surface, actionId, maxAmount, nonce, expiry);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) return false;
        return recovered == investor;
    }

    /// @notice Consume an investor-signed AgentPermit. Caller MUST be the
    ///         platform owner. Reverts on expired permit, wrong signer, or
    ///         stale nonce. Emits `AgentPermitConsumed`.
    ///
    ///         The permit's `tier` / `surface` / `maxAmount` fields are NOT
    ///         enforced on-chain here — they are part of the EIP-712 hash
    ///         (so the investor signs to a specific scope) but the actual
    ///         policy enforcement happens off-chain in the backend / kernel.
    ///         This is the carrier "nonce-monotonic + signature-verified"
    ///         primitive; semantic enforcement layers on top.
    function consumeAgentPermit(
        address investor,
        uint8 tier,
        uint8 surface,
        uint8 actionId,
        uint256 maxAmount,
        uint64 nonce,
        uint256 expiry,
        bytes calldata signature
    ) external onlyOwner {
        if (block.timestamp > expiry) revert AgentPermitExpired();
        if (nonce <= _agentPermitNonces[investor]) {
            revert AgentPermitNonceUsed(nonce, _agentPermitNonces[investor]);
        }

        bytes32 digest = hashAgentPermit(investor, tier, surface, actionId, maxAmount, nonce, expiry);
        // Use OZ ECDSA.recover (reverts on malformed sig; rejects malleable s).
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != investor) revert AgentPermitWrongSigner(recovered, investor);

        _agentPermitNonces[investor] = nonce;
        emit AgentPermitConsumed(investor, nonce, actionId);
    }

    function getAgentPermitNonce(address investor) external view returns (uint64) {
        return _agentPermitNonces[investor];
    }

    // ── Wave 4 P6: admin setters ─────────────────────────────────────────

    function setKycGate(IKYCGate _kycGate) external onlyOwner {
        emit KYCGateSet(address(kycGate), address(_kycGate));
        kycGate = _kycGate;
    }

    function setOracleFreshness(uint64 _lastOracleUpdate, uint64 _stalenessSec) external onlyOwner {
        lastOracleUpdate   = _lastOracleUpdate;
        oracleStalenessSec = _stalenessSec;
        emit OracleFreshnessUpdated(_lastOracleUpdate, _stalenessSec);
    }

    /// @notice Admin-set per-investor pause floor. Used by the backend
    ///         when a policy engine softfails (e.g., decryptForTx repeatedly
    ///         hits TN `Forbidden`) and operators want to pause manually
    ///         without committing a (signature-required) breach decrypt.
    function setUserPaused(address investor, uint32 pausedUntilTs) external onlyOwner {
        _pausedUntil[investor] = pausedUntilTs;
        emit UserPauseOverride(investor, pausedUntilTs);
    }

    // ── View helpers ─────────────────────────────────────────────────────

    function hasRiskParams(address investor) external view returns (bool) {
        return _hasParams[investor];
    }

    function pausedUntil(address investor) external view returns (uint32) {
        return _pausedUntil[investor];
    }

    function lastSpendEpoch(address investor) external view returns (uint32) {
        return _lastSpendEpoch[investor];
    }

    /// @notice Surface action IDs for off-chain SDKs. Constants are
    ///         internal; these getters expose them stably.
    function actionIdBuy()       external pure returns (uint8) { return ACTION_ID_BUY; }
    function actionIdSell()      external pure returns (uint8) { return ACTION_ID_SELL; }
    function actionIdClaim()     external pure returns (uint8) { return ACTION_ID_CLAIM; }
    function actionIdRebalance() external pure returns (uint8) { return ACTION_ID_REBALANCE; }

    function breachOracleStale()   external pure returns (uint8) { return BREACH_ORACLE_STALE; }
    function breachKycRevoked()    external pure returns (uint8) { return BREACH_KYC_REVOKED; }
    function breachUserPaused()    external pure returns (uint8) { return BREACH_USER_PAUSED; }
    function breachUnknownAction() external pure returns (uint8) { return BREACH_UNKNOWN_ACTION; }

    // ── Owner admin ──────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
