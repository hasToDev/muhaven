// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    FHE,
    euint64,
    InEuint64,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title RiskParams
/// @notice Encrypted per-investor risk guardrails stored on-chain.
///         Investors client-encrypt their own risk parameters via setRiskParams().
///         The platform owner (AI agent) can request async decryption to read
///         params off-chain and enforce portfolio constraints.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Privacy architecture:
///   - All four risk parameters are stored as `euint64` — never visible on-chain.
///   - `FHE.allowSender()` at store time grants the investor permit-based
///     decryption of their own params via client-side `decryptForView()`.
///   - `FHE.allow(param, msg.sender)` in `requestRiskParamsDecrypt()` grants
///     the platform owner (AI agent) decrypt access dynamically — not hardcoded
///     at store time, so ownership transfers don't break ACLs.
///   - Async decrypt via `createDecryptTask` is the alternative path for callers
///     that need on-chain decrypted values (e.g., for future on-chain enforcement).
///
///   Known leakage:
///   - `_hasParams[investor]` is a cleartext boolean — reveals whether an investor
///     has configured risk preferences, but not what those preferences are.
///   - `RiskParamsUpdated` event reveals the investor address and that params changed.
contract RiskParams is Initializable {

    // ── Storage ──────────────────────────────────────────────────────────

    /// @dev All four fields are encrypted. Stored per investor.
    struct InvestorRisk {
        euint64 maxDrawdownBps;     // Max tolerated drawdown in basis points (e.g. 1000 = 10%)
        euint64 minYieldBps;        // Minimum acceptable annual yield in basis points
        euint64 driftToleranceBps;  // Max allocation drift from target before rebalance trigger
        euint64 maxDailySpend;      // Max daily spend cap in USDC (6-decimal units)
    }

    mapping(address => InvestorRisk) private _riskParams;

    /// @dev Q4→B: separate bool avoids leaking a cleartext timestamp on-chain.
    ///      `_hasParams[investor]` is the only cleartext indicator of existence.
    mapping(address => bool) private _hasParams;

    address public owner;

    /// @dev Reserved storage for future upgrades (proxy-safe gap)
    uint256[50] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event RiskParamsUpdated(address indexed investor);
    event RiskParamsDecryptRequested(address indexed investor, address indexed requester);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error Unauthorized();
    error NoRiskParams();
    error ZeroAddress();

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
    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Investor: set own risk params ─────────────────────────────────────

    /// @notice Store encrypted risk parameters for the caller (investor).
    ///         Inputs must be client-encrypted by the investor's keypair before
    ///         calling this function. All four params are required; pass an
    ///         encrypted zero to indicate "no constraint" for any field.
    ///
    ///         FHE patterns applied:
    ///         - FHE.allowThis()   → contract can store/compute on these values
    ///         - FHE.allowSender() → investor retains read access for their own params
    ///
    /// @param encMaxDrawdownBps    Max drawdown tolerance in bps
    /// @param encMinYieldBps       Minimum acceptable yield in bps
    /// @param encDriftToleranceBps Max allocation drift before rebalance trigger
    /// @param encMaxDailySpend     Max daily spend cap (USDC 6-decimal units)
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

        // Contract must retain access to compute on these ciphertexts
        FHE.allowThis(maxDrawdown);
        FHE.allowThis(minYield);
        FHE.allowThis(driftTol);
        FHE.allowThis(dailySpend);

        // Investor retains read access to their own params
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

    // ── Async decrypt: request ────────────────────────────────────────────

    /// @notice Request async decryption of an investor's risk parameters.
    ///         Caller must be the investor themselves or the platform owner (AI agent).
    ///
    ///         Access pattern: `FHE.allow()` is called here (not at store time) so
    ///         the platform owner is granted decrypt access dynamically. This avoids
    ///         hardcoding the owner address into ciphertext ACLs at store time — which
    ///         would break if ownership is transferred after params were set.
    ///
    ///         Results are readable via getRiskParamsDecryptResult() once the
    ///         CoFHE coprocessor completes the four decrypt tasks.
    ///
    /// @param investor  The investor whose risk params to decrypt
    function requestRiskParamsDecrypt(address investor) external {
        if (msg.sender != investor && msg.sender != owner) revert Unauthorized();
        if (!_hasParams[investor]) revert NoRiskParams();

        InvestorRisk storage p = _riskParams[investor];

        // Grant requester decrypt access (required for non-investor callers;
        // no-op if msg.sender already has access via allowSender at store time)
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

    // ── Async decrypt: read result ────────────────────────────────────────

    /// @notice Read the async-decrypted risk parameters for an investor.
    ///         Each value is only meaningful if its corresponding decrypted flag is true.
    ///         Call requestRiskParamsDecrypt() first and wait for the CoFHE coprocessor.
    ///
    /// @param investor  The investor whose decrypted params to read
    /// @return maxDrawdownBps       Decrypted max drawdown in bps
    /// @return minYieldBps          Decrypted min yield in bps
    /// @return driftToleranceBps    Decrypted drift tolerance in bps
    /// @return maxDailySpend        Decrypted max daily spend
    /// @return d0 d1 d2 d3          Whether each respective value has been decrypted
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

    // ── View ──────────────────────────────────────────────────────────────

    /// @notice Returns true if an investor has set their risk parameters.
    ///         Does not reveal when they were set (Q4→B: no cleartext timestamp).
    function hasRiskParams(address investor) external view returns (bool) {
        return _hasParams[investor];
    }

    // ── Owner admin ───────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
