// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, euint128, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IDefaultProtection
/// @notice Credit default protection module. Issuers deposit a PUSDC first-loss
///         reserve when listing tokens; if the issuer defaults, the reserve
///         distributes proportionally to all current investors via MuHavenEscrow.
///
/// @dev Two-phase payout distribution mirrors `YieldDistributor` exactly so the
///      same SDK plumbing (`MuHavenEscrow.batchCreate(InEaddress[],resolver,data[])`
///      → `setPayoutEscrowIds(...)` → repeated `processPayoutBatch(...)` calls)
///      can drive both surfaces. The contract itself never sees plaintext
///      investor addresses; the SDK encrypts them off-chain and provides the
///      sequential escrow IDs.
///
///      See `docs/CREDIT_PROTECTION_DESIGN.md` §3 for the full specification.
interface IDefaultProtection {

    // ── Events ───────────────────────────────────────────────────────

    event ProtectionCreated(
        uint256 indexed protectionId,
        address indexed token,
        address indexed issuer,
        uint256 reserveRateBps
    );
    event ReserveDeposited(uint256 indexed protectionId, address indexed depositor);
    event ReserveTopUp(uint256 indexed protectionId, address indexed depositor);
    event PayoutTriggered(
        uint256 indexed protectionId,
        address indexed triggeredBy,
        uint256 investorCount
    );
    event PayoutEscrowIdsAttached(uint256 indexed protectionId, uint256 count);
    event PayoutBatchProcessed(
        uint256 indexed protectionId,
        uint256 processedCount,
        uint256 investorCount
    );
    event PayoutCompleted(uint256 indexed protectionId);
    event ReserveDecryptRequested(uint256 indexed protectionId, address indexed requester);

    event MinimumReserveRateUpdated(uint256 newMinBps);
    event AuthorizedTriggerUpdated(address indexed trigger, bool authorized);
    event MuHavenEscrowUpdated(address indexed newEscrow);
    event YieldGateUpdated(address indexed newGate);
    event PusdcUpdated(address indexed newPusdc);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyIssuer();
    error Unauthorized();
    error ZeroAddress();
    error RateBelowMinimum();
    error RateAboveMaximum();
    error ProtectionAlreadyExists();
    error ProtectionNotActive();
    error ProtectionNotTriggered();
    error InvalidProtection();
    error PayoutAlreadyCompleted();
    error NoInvestors();
    error PusdcTransferFailed();
    error EscrowIdsNotSet();
    error EscrowIdsAlreadySet();
    error EscrowIdsLengthMismatch();

    // ── Issuer functions ─────────────────────────────────────────────

    function createProtection(
        address token,
        uint256 reserveRateBps
    ) external returns (uint256 protectionId);

    function depositReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external;

    function topUpReserve(
        uint256 protectionId,
        InEuint64 memory encryptedAmount
    ) external;

    // ── Payout pipeline ──────────────────────────────────────────────

    function triggerPayout(uint256 protectionId) external;

    function setPayoutEscrowIds(
        uint256 protectionId,
        uint256[] calldata escrowIds
    ) external;

    function processPayoutBatch(
        uint256 protectionId,
        uint256 batchSize
    ) external;

    // ── Async decrypt (issuer + owner only) ──────────────────────────

    function requestReserveDecrypt(uint256 protectionId) external;

    function getReserveDecryptResult(uint256 protectionId)
        external
        view
        returns (uint64 reserveBalance, bool decrypted);

    // ── Views ────────────────────────────────────────────────────────

    function getProtection(uint256 protectionId) external view returns (
        address token,
        address issuer,
        uint256 reserveRateBps,
        euint128 encReserveBalance,
        uint8 status,
        uint256 createdAt,
        uint256 triggeredAt
    );

    function getPayoutDistribution(uint256 protectionId) external view returns (
        euint64 encTotalPayout,
        euint64 encPerInvestorPayout,
        uint256 investorCount,
        uint256 processedCount,
        uint256 escrowsCreated,
        uint8 status
    );

    function getPayoutEscrowIds(uint256 protectionId) external view returns (uint256[] memory);

    function tokenProtection(address token) external view returns (uint256);

    function minimumReserveRateBps() external view returns (uint256);

    function isPayoutComplete(uint256 protectionId) external view returns (bool);

    // ── Admin ────────────────────────────────────────────────────────

    function setMinimumReserveRate(uint256 newMinBps) external;
    function setAuthorizedTrigger(address trigger, bool authorized) external;
    function setMuHavenEscrow(address newEscrow) external;
    function setYieldGate(address newGate) external;
    function setPusdc(address newPusdc) external;
    function transferOwnership(address newOwner) external;
}
